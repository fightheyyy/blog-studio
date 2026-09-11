import { StudioError } from "./errors.mjs";
export { StudioError } from "./errors.mjs";
import { readSite, applySiteToPost, renderHome } from "./site.mjs";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";

export const WRITING_START = "<!-- blog-studio:writing:start -->";
export const WRITING_END = "<!-- blog-studio:writing:end -->";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

export function validateSlug(value) {
  const slug = String(value ?? "").trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new StudioError("Slug 只能使用小写字母、数字和连字符。", {
      code: "INVALID_SLUG",
      status: 422,
    });
  }
  if (slug.length > 120) {
    throw new StudioError("Slug 不能超过 120 个字符。", {
      code: "INVALID_SLUG",
      status: 422,
    });
  }
  return slug;
}

export function validateArticle(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StudioError("文章数据格式无效。", { code: "INVALID_ARTICLE", status: 422 });
  }

  const slug = validateSlug(input.slug);
  const title = requiredText(input.title, "标题", 200);
  const kicker = requiredText(input.kicker, "栏目标签", 160);
  const deck = requiredText(input.deck, "头部导语", 800);
  const description = optionalText(input.description, 800) || deck;
  const date = validateDate(input.date);
  const readMinutes = Number(input.readMinutes);
  const contentHtml = String(input.contentHtml ?? "").trim();
  const headlineLines = normalizeHeadlineLines(input.headlineLines, title);

  if (!Number.isInteger(readMinutes) || readMinutes < 1 || readMinutes > 999) {
    throw new StudioError("阅读时长必须是 1 到 999 之间的整数。", {
      code: "INVALID_READ_TIME",
      status: 422,
    });
  }
  if (!contentHtml) {
    throw new StudioError("正文不能为空。", { code: "EMPTY_CONTENT", status: 422 });
  }
  if (Buffer.byteLength(contentHtml, "utf8") > 2_500_000) {
    throw new StudioError("正文 HTML 不能超过 2.5 MB。", {
      code: "CONTENT_TOO_LARGE",
      status: 413,
    });
  }

  return {
    slug,
    isNew: Boolean(input.isNew),
    title,
    headlineLines,
    kicker,
    deck,
    description,
    date,
    readMinutes,
    contentHtml,
  };
}

export async function listArticles(repoRoot) {
  const postsDir = within(repoRoot, "posts");
  const entries = await readdir(postsDir, { withFileTypes: true });
  const articles = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map(async (entry) => {
        const slug = entry.name.slice(0, -5);
        const html = await readFile(within(postsDir, entry.name), "utf8");
        return articleFromHtml(html, slug, false);
      }),
  );

  return articles
    .sort(compareArticles)
    .map(({ sourceHtml, contentHtml, ...summary }) => ({
      ...summary,
      excerpt: plainText(contentHtml).slice(0, 120),
    }));
}

export async function loadArticle(repoRoot, slugValue) {
  const slug = validateSlug(slugValue);
  const filePath = within(repoRoot, "posts", `${slug}.html`);
  try {
    const html = await readFile(filePath, "utf8");
    return articleFromHtml(html, slug, false);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new StudioError("没有找到这篇文章。", {
        code: "ARTICLE_NOT_FOUND",
        status: 404,
      });
    }
    throw error;
  }
}

export async function createNewDraft(repoRoot) {
  const templatePath = within(repoRoot, "theme", "article.html");
  const sourceHtml = applySiteToPost(await readFile(templatePath, "utf8"), await readSite(repoRoot), "new-post");
  const draft = articleFromHtml(sourceHtml, "new-post", true);
  return {
    ...draft,
    slug: "",
    title: "",
    headlineLines: [""],
    kicker: "Notes · Writing",
    deck: "",
    description: "",
    date: localIsoDate(),
    readMinutes: 8,
    isNew: true,
  };
}

export async function saveArticle(repoRoot, input) {
  const article = validateArticle(input);
  const postPath = within(repoRoot, "posts", `${article.slug}.html`);
  const templatePath = within(repoRoot, "theme", "article.html");
  const indexPath = within(repoRoot, "index.html");
  const alreadyExists = await exists(postPath);

  if (article.isNew && alreadyExists) {
    throw new StudioError("这个 Slug 已经存在，请换一个。", {
      code: "ARTICLE_EXISTS",
      status: 409,
    });
  }
  if (!article.isNew && !alreadyExists) {
    throw new StudioError("要编辑的文章不存在。", {
      code: "ARTICLE_NOT_FOUND",
      status: 404,
    });
  }

  const originalHtml = await readFile(alreadyExists ? postPath : templatePath, "utf8");
  const site = await readSite(repoRoot);
  const savedHtml = applySiteToPost(applyArticleToHtml(originalHtml, article), site, article.slug);
  const indexHtml = await readFile(within(repoRoot, "theme", "home.html"), "utf8");
  const currentArticles = await listArticles(repoRoot);
  const nextSummary = articleFromHtml(savedHtml, article.slug, false);
  const nextArticles = [
    ...currentArticles.filter((item) => item.slug !== article.slug),
    nextSummary,
  ].sort(compareArticles);
  const nextIndexHtml = renderHome(indexHtml, site, nextArticles);

  await writeFile(postPath, savedHtml, "utf8");
  await writeFile(indexPath, nextIndexHtml, "utf8");

  return articleFromHtml(savedHtml, article.slug, false);
}

export async function uploadArticleAsset(repoRoot, { slug: slugValue, fileName, dataUrl }) {
  const slug = validateSlug(slugValue);
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(String(dataUrl ?? ""));
  if (!match) {
    throw new StudioError("图片数据格式无效。", { code: "INVALID_IMAGE", status: 422 });
  }

  const mime = match[1].toLowerCase();
  const extension = IMAGE_MIME_EXTENSIONS.get(mime);
  if (!extension) {
    throw new StudioError("只支持 PNG、JPEG、WebP 和 GIF 图片。", {
      code: "UNSUPPORTED_IMAGE",
      status: 415,
    });
  }

  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 8_000_000) {
    throw new StudioError("图片必须小于 8 MB。", {
      code: "IMAGE_TOO_LARGE",
      status: 413,
    });
  }

  const assetDir = within(repoRoot, "assets", "posts", slug);
  await mkdir(assetDir, { recursive: true });
  const requestedBase = path.basename(String(fileName ?? "image"), path.extname(String(fileName ?? "")));
  const safeBase = slugifyFileBase(requestedBase) || `image-${Date.now()}`;
  const finalName = await availableFileName(assetDir, safeBase, extension);
  const filePath = within(assetDir, finalName);
  await writeFile(filePath, buffer);

  return {
    fileName: finalName,
    src: `../assets/posts/${slug}/${finalName}`,
    bytes: buffer.length,
    mime,
  };
}

export function articleFromHtml(html, slug, isNew = false) {
  const $ = load(html);
  const header = $(".article-header").first();
  const content = $(".article-content").first();
  if (!header.length || !content.length) {
    throw new StudioError(`posts/${slug}.html 缺少可编辑的文章结构。`, {
      code: "UNSUPPORTED_ARTICLE",
      status: 422,
    });
  }

  const h1 = header.find("h1").first();
  const headlineLines = h1
    .children("span")
    .toArray()
    .map((element) => $(element).text().trim())
    .filter(Boolean);
  const title =
    $("meta[property='og:title']").attr("content")?.trim() ||
    $("title").first().text().trim() ||
    headlineLines.join("");
  const metaSpans = header.find(".article-meta span").toArray();
  const readTimeText = metaSpans.map((element) => $(element).text()).find((text) => /分钟/.test(text));
  const readMinutes = Number(/(\d+)\s*分钟/.exec(readTimeText ?? "")?.[1] ?? 8);
  const contentHtml = content.html()?.trim() ?? "";

  return {
    slug,
    isNew,
    title,
    headlineLines: headlineLines.length ? headlineLines : [title],
    kicker: header.find(".article-kicker").first().text().trim(),
    deck: header.find(".article-deck").first().text().replace(/\s+/g, " ").trim(),
    description:
      $("meta[name='description']").attr("content")?.trim() ||
      header.find(".article-deck").first().text().replace(/\s+/g, " ").trim(),
    date:
      $("meta[property='article:published_time']").attr("content")?.trim() ||
      header.find("time").first().attr("datetime")?.trim() ||
      "",
    readMinutes: Number.isFinite(readMinutes) ? readMinutes : 8,
    contentHtml,
    sourceHtml: html,
  };
}

export function applyArticleToHtml(originalHtml, input) {
  const article = validateArticle(input);
  const $ = load(originalHtml.trimEnd());
  const header = $(".article-header").first();
  const content = $(".article-content").first();
  if (!header.length || !content.length) {
    throw new StudioError("文章模板缺少 .article-header 或 .article-content。", {
      code: "UNSUPPORTED_ARTICLE",
      status: 422,
    });
  }

  upsertMeta($, "name", "description", article.description);
  upsertMeta($, "property", "og:type", "article");
  upsertMeta($, "property", "og:title", article.title);
  upsertMeta($, "property", "og:description", article.deck);
  upsertMeta($, "property", "article:published_time", article.date);

  const titleElement = $("title").first();
  if (titleElement.length) titleElement.text(article.title);
  else $("head").append(`<title>${escapeHtml(article.title)}</title>`);

  let kicker = header.find(".article-kicker").first();
  if (!kicker.length) {
    header.prepend('<p class="article-kicker"></p>');
    kicker = header.find(".article-kicker").first();
  }
  kicker.text(article.kicker);

  const h1 = header.find("h1").first();
  if (!h1.length) {
    throw new StudioError("文章模板缺少 h1。", { code: "UNSUPPORTED_ARTICLE", status: 422 });
  }
  h1.attr("aria-label", article.title);
  h1.empty();
  article.headlineLines.forEach((line) => h1.append(`<span>${escapeHtml(line)}</span>`));

  let deck = header.find(".article-deck").first();
  if (!deck.length) {
    h1.after('<p class="article-deck"></p>');
    deck = header.find(".article-deck").first();
  }
  deck.text(article.deck);

  let articleMeta = header.find(".article-meta").first();
  if (!articleMeta.length) {
    header.append('<div class="article-meta"></div>');
    articleMeta = header.find(".article-meta").first();
  }
  let time = articleMeta.find("time").first();
  if (!time.length) {
    articleMeta.prepend("<time></time>");
    time = articleMeta.find("time").first();
  }
  time.attr("datetime", article.date).text(article.date.replaceAll("-", "."));

  let readTime = articleMeta
    .find("span")
    .toArray()
    .map((element) => $(element))
    .find((element) => /分钟/.test(element.text()));
  if (!readTime) {
    articleMeta.append("<span></span>");
    readTime = articleMeta.find("span").last();
  }
  readTime.text(`约 ${article.readMinutes} 分钟阅读`);
  content.html(article.contentHtml);

  let serialized = $.html();
  serialized = serialized.replace(/^<!DOCTYPE html>/i, "<!doctype html>");
  return serialized.endsWith("\n") ? serialized : `${serialized}\n`;
}

export function buildWritingIndex(indexHtml, articles) {
  const startIndex = indexHtml.indexOf(WRITING_START);
  const endIndex = indexHtml.indexOf(WRITING_END);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new StudioError("首页缺少 Blog Studio 的 Writing 区域标记。", {
      code: "INDEX_MARKERS_MISSING",
      status: 500,
    });
  }

  const generated = [...articles]
    .sort(compareArticles)
    .map(
      (article) =>
        `          <div class="index-item reveal-item">\n` +
        `            <a class="index-link writing-link" href="posts/${escapeHtml(article.slug)}.html">\n` +
        `              <span class="index-title">${escapeHtml(article.title)}</span>\n` +
        `              <span class="index-destination">Read</span>\n` +
        `            </a>\n` +
        `          </div>`,
    )
    .join("\n");

  const before = indexHtml.slice(0, startIndex + WRITING_START.length);
  const after = indexHtml.slice(endIndex);
  return `${before}\n${generated}\n          ${after}`;
}

function upsertMeta($, attribute, key, content) {
  let element = $(`meta[${attribute}='${key}']`).first();
  if (!element.length) {
    $("head").append(`<meta ${attribute}="${escapeHtml(key)}" />`);
    element = $(`meta[${attribute}='${key}']`).first();
  }
  element.attr("content", content);
}

function requiredText(value, label, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    throw new StudioError(`${label}不能为空。`, { code: "MISSING_FIELD", status: 422 });
  }
  if (text.length > maxLength) {
    throw new StudioError(`${label}不能超过 ${maxLength} 个字符。`, {
      code: "FIELD_TOO_LONG",
      status: 422,
    });
  }
  return text;
}

function optionalText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length > maxLength) {
    throw new StudioError(`字段不能超过 ${maxLength} 个字符。`, {
      code: "FIELD_TOO_LONG",
      status: 422,
    });
  }
  return text;
}

function normalizeHeadlineLines(value, fallbackTitle) {
  const lines = (Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/))
    .map((line) => String(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!lines.length) return [fallbackTitle];
  if (lines.length > 8 || lines.some((line) => line.length > 120)) {
    throw new StudioError("大标题最多 8 行，每行不超过 120 个字符。", {
      code: "INVALID_HEADLINE",
      status: 422,
    });
  }
  return lines;
}

function validateDate(value) {
  const date = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new StudioError("日期格式必须是 YYYY-MM-DD。", {
      code: "INVALID_DATE",
      status: 422,
    });
  }
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new StudioError("日期不是有效的日历日期。", {
      code: "INVALID_DATE",
      status: 422,
    });
  }
  return date;
}

function compareArticles(a, b) {
  return String(b.date).localeCompare(String(a.date)) || String(a.slug).localeCompare(String(b.slug));
}

function plainText(html) {
  const $ = load(`<main>${html}</main>`);
  return $("main").text().replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function within(base, ...segments) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, ...segments);
  if (resolved !== resolvedBase && !resolved.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new StudioError("文件路径超出博客目录。", {
      code: "INVALID_PATH",
      status: 422,
    });
  }
  return resolved;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function localIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function slugifyFileBase(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function availableFileName(directory, base, extension) {
  let candidate = `${base}${extension}`;
  let counter = 2;
  while (await exists(within(directory, candidate))) {
    candidate = `${base}-${counter}${extension}`;
    counter += 1;
  }
  return candidate;
}
