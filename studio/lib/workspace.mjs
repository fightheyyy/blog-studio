import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import { load } from "cheerio";
import {
  StudioError,
  validateSlug,
  uploadArticleAsset,
  buildWritingIndex,
} from "./articles.mjs";
import { getGitStatus, publishPaths, runGit } from "./git.mjs";

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
const categories = ["Agents", "Hardware", "Evals", "Skills"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const today = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );

export async function resolveWorkspace(studioRoot) {
  let config = {};
  try {
    config = JSON.parse(
      await readFile(path.join(studioRoot, "studio.config.local.json"), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const target = process.env.BLOG_STUDIO_SITE_ROOT || config.siteRoot;
  if (!target) return null;
  const siteRoot = path.resolve(studioRoot, target);
  for (const file of [
    "nuxt.config.ts",
    "content/blog",
    "public/classic/index.html",
  ]) {
    if (!(await exists(path.join(siteRoot, file))))
      throw new Error(`写作目标不是支持的双版本博客：缺少 ${file}`);
  }
  const siteUrl = new URL(
    config.siteUrl || "https://fightheyyy.github.io/",
  ).href.replace(/\/$/, "");
  return {
    siteRoot,
    siteUrl,
    label: config.label || new URL(siteUrl).hostname,
    author: config.author || "Fightheyyy",
    privateRoot: path.join(
      studioRoot,
      ".studio-data",
      hash(siteRoot).slice(0, 12),
    ),
  };
}

function articlePath(workspace, slug) {
  return path.join(
    workspace.siteRoot,
    "content/blog",
    `${validateSlug(slug)}.md`,
  );
}
function draftPath(workspace, slug) {
  return path.join(
    workspace.privateRoot,
    "drafts",
    `${validateSlug(slug)}.json`,
  );
}
async function maybeRead(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, file);
}
function readingMinutes(markdown) {
  const plain = load(md.render(markdown)).text();
  const cjk = (plain.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (
    plain.replace(/[\u3400-\u9fff]/g, "").match(/[\p{L}\p{N}]+/gu) || []
  ).length;
  return Math.max(1, Math.ceil(cjk / 400 + words / 220));
}
function normalize(input, { publish = false } = {}) {
  if (!input || typeof input !== "object")
    throw new StudioError("文章数据无效。");
  const article = {
    slug: validateSlug(input.slug),
    title: String(input.title || "")
      .trim()
      .slice(0, 200),
    description: String(input.description || "")
      .trim()
      .slice(0, 800),
    date: String(input.date || today()),
    category: String(input.category || "Agents"),
    tags: (Array.isArray(input.tags) ? input.tags : [])
      .map((tag) => String(tag).trim())
      .filter(Boolean)
      .slice(0, 20),
    featured: Boolean(input.featured),
    markdown: String(input.markdown ?? ""),
    revision: input.revision || null,
    baseHash: input.baseHash || null,
  };
  const calendarDate = new Date(`${article.date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(article.date) ||
    !Number.isFinite(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== article.date
  )
    throw new StudioError("请选择有效日期。");
  if (!categories.includes(article.category))
    throw new StudioError("请选择支持的文章分类。");
  if (article.markdown.length > 2_000_000)
    throw new StudioError("文章超过了 2 MB。");
  if (publish && (!article.title || !article.markdown.trim()))
    throw new StudioError("发布前请填写标题和正文。");
  return { ...article, readingMinutes: readingMinutes(article.markdown) };
}

export function newWorkspaceDraft(workspace) {
  return {
    slug: `note-${today().replaceAll("-", "")}-${randomUUID().slice(0, 6)}`,
    title: "",
    description: "",
    date: today(),
    category: "Agents",
    tags: [],
    featured: false,
    markdown: "",
    author: workspace.author,
    revision: null,
    baseHash: null,
    state: "new",
    readingMinutes: 1,
  };
}

export async function loadWorkspaceArticle(workspace, slug) {
  const draft = await maybeRead(draftPath(workspace, slug));
  if (draft) return { ...JSON.parse(draft), state: "draft" };
  const source = await maybeRead(articlePath(workspace, slug));
  if (source === null)
    throw new StudioError("文章不存在。", { code: "NOT_FOUND", status: 404 });
  const { data, content } = matter(source);
  return {
    ...newWorkspaceDraft(workspace),
    ...data,
    slug,
    markdown: content.replace(/^\r?\n/, ""),
    revision: null,
    baseHash: hash(source),
    state: "published",
    readingMinutes: data.readingMinutes || readingMinutes(content),
  };
}

export async function listWorkspaceArticles(workspace) {
  const names = await readdir(path.join(workspace.siteRoot, "content/blog"));
  const slugs = new Set(
    names
      .filter((name) => /^[a-z0-9-]+\.md$/.test(name))
      .map((name) => name.slice(0, -3)),
  );
  try {
    (await readdir(path.join(workspace.privateRoot, "drafts")))
      .filter((name) => /^[a-z0-9-]+\.json$/.test(name))
      .forEach((name) => slugs.add(name.slice(0, -5)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const articles = await Promise.all(
    [...slugs].map((slug) => loadWorkspaceArticle(workspace, slug)),
  );
  return articles
    .map(({ markdown, ...article }) => article)
    .sort(
      (a, b) =>
        (a.state === "draft" ? 0 : 1) - (b.state === "draft" ? 0 : 1) ||
        b.date.localeCompare(a.date) ||
        a.slug.localeCompare(b.slug),
    );
}

export async function saveWorkspaceDraft(workspace, input) {
  const article = normalize(input);
  const current = await maybeRead(draftPath(workspace, article.slug));
  if ((current ? JSON.parse(current).revision : null) !== article.revision) {
    throw new StudioError(
      "另一窗口已更新这篇草稿。请先重新打开文章，避免覆盖较新的内容。",
      { code: "DRAFT_CONFLICT", status: 409 },
    );
  }
  const saved = {
    ...article,
    author: workspace.author,
    state: "draft",
    revision: randomUUID(),
    savedAt: new Date().toISOString(),
  };
  await atomicWrite(
    draftPath(workspace, article.slug),
    JSON.stringify(saved, null, 2),
  );
  return saved;
}

function publicMarkdown(article, oldMeta, author) {
  return matter.stringify(article.markdown, {
    ...oldMeta,
    title: article.title,
    description: article.description,
    date: article.date,
    author: oldMeta.author || author,
    category: article.category,
    tags: article.tags,
    featured: article.featured,
    draft: false,
    readingMinutes: article.readingMinutes,
  });
}
function cleanPreview(html) {
  const $ = load(html, null, false);
  $("script, iframe, object, embed, base, meta, link, form").remove();
  $("*").each((_, element) => {
    for (const name of Object.keys(element.attribs || {})) {
      if (
        /^on/i.test(name) ||
        name === "srcdoc" ||
        /^(?:javascript|vbscript):/i.test(element.attribs[name].trim())
      )
        $(element).removeAttr(name);
    }
  });
  return $.html();
}
export function renderWorkspacePreview(
  workspace,
  input,
  presentation = "editorial",
) {
  const article = normalize(input);
  const body = cleanPreview(md.render(article.markdown));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><link rel="stylesheet" href="/studio/reading.css"></head><body data-presentation="${presentation === "minimal" ? "minimal" : "editorial"}"><main class="reading-page"><header><p class="reading-category">${escape(article.category)}</p><h1>${escape(article.title || "无标题文章")}</h1>${article.description ? `<p class="reading-description">${escape(article.description)}</p>` : ""}<div class="reading-meta">${escape(workspace.author)} <span>${escape(article.date)}</span> <span>${article.readingMinutes} min read</span></div></header><article>${body || '<p class="reading-empty">正文预览会出现在这里。</p>'}</article></main></body></html>`;
}

function adjustRelativeLinks($, root) {
  root
    .find("[href], [src]")
    .addBack("[href], [src]")
    .each((_, element) => {
      for (const attr of ["href", "src"]) {
        const value = $(element).attr(attr);
        if (value && !/^(?:[a-z]+:|\/|#)/i.test(value))
          $(element).attr(attr, `../${value}`);
      }
    });
}
async function renderClassicArticle(
  workspace,
  article,
  oldSource,
  oldMarkdown,
) {
  const renderedBody = md.render(article.markdown);
  const oldHtml = await maybeRead(
    path.join(
      workspace.siteRoot,
      "public/classic/posts",
      `${article.slug}.html`,
    ),
  );
  let $;
  if (oldHtml) $ = load(oldHtml);
  else {
    const home = load(
      await readFile(
        path.join(workspace.siteRoot, "public/classic/index.html"),
        "utf8",
      ),
    );
    const header = home(".classic-site-header").clone();
    const footer = home(".classic-shared-footer").clone();
    adjustRelativeLinks(home, header);
    adjustRelativeLinks(home, footer);
    const head = home("head").clone();
    head
      .find('meta[name="description"], title, link[rel="canonical"]')
      .remove();
    adjustRelativeLinks(home, head);
    $ = load(
      `<!doctype html><html lang="zh-CN">${home.html(head)}<body class="article-page">${home.html(header)}<main class="article-shell"><article><header class="article-header"><p class="article-kicker"></p><h1></h1><p class="article-deck"></p><div class="article-meta"></div></header><div class="article-content"></div></article><footer class="article-footer"><a href="../index.html#blog">← 返回 Blog</a><span>${escape(workspace.label)}</span></footer></main>${home.html(footer)}</body></html>`,
    );
  }
  const metadata = {
    description: article.description,
    "og:title": article.title,
    "og:description": article.description,
    "og:type": "article",
    "article:published_time": article.date,
  };
  for (const [name, value] of Object.entries(metadata)) {
    const attribute = name.includes(":") ? "property" : "name";
    $(`meta[${attribute}="${name}"]`).remove();
    $("head").append(
      `<meta ${attribute}="${name}" content="${escape(value)}">`,
    );
  }
  $("title").remove();
  $("head").append(
    `<title>${escape(article.title)} — ${escape(workspace.label)}</title>`,
  );
  $('link[rel="canonical"]').remove();
  $("head").append(
    `<link rel="canonical" href="${escape(workspace.siteUrl)}/classic/posts/${article.slug}.html">`,
  );
  $(".article-kicker").first().text(article.category);
  $(".article-header h1")
    .first()
    .text(article.title)
    .attr("aria-label", article.title);
  $(".article-deck").first().text(article.description);
  $(".article-meta")
    .first()
    .html(
      `<time datetime="${article.date}">${article.date.replaceAll("-", ".")}</time><span>约 ${article.readingMinutes} 分钟阅读</span>`,
    );
  // Preserve existing bespoke HTML/interactive diagrams for metadata-only edits.
  if (
    !oldHtml ||
    oldSource === null ||
    article.markdown.trim() !== oldMarkdown.trim()
  )
    $(".article-content").first().html(renderedBody);
  return $.html();
}

export async function publishWorkspaceArticle(workspace, input, commitMessage) {
  let article = normalize(input, { publish: true });
  const status = await getGitStatus(workspace.siteRoot);
  if (!status.hasOrigin) throw new StudioError("目标博客没有配置 origin。");
  await runGit(workspace.siteRoot, ["fetch", "origin"]);
  const latest = await getGitStatus(workspace.siteRoot);
  if (latest.behind)
    throw new StudioError("目标博客落后远程，请先同步仓库再发布。", {
      code: "BRANCH_BEHIND",
      status: 409,
    });
  const oldSource = await maybeRead(articlePath(workspace, article.slug));
  const expectedHash = oldSource === null ? null : hash(oldSource);
  if (article.baseHash !== expectedHash)
    throw new StudioError(
      "博客源文件已被其他程序修改，已停止发布。请先同步并合并内容，草稿仍保留。",
      { code: "SOURCE_CONFLICT", status: 409 },
    );
  article = await saveWorkspaceDraft(workspace, article);
  try {
    const old =
      oldSource === null ? { data: {}, content: "" } : matter(oldSource);
    const markdown = publicMarkdown(article, old.data, workspace.author);
    const classic = await renderClassicArticle(
      workspace,
      article,
      oldSource,
      old.content,
    );
    const redirect = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../blog/${article.slug}"><link rel="canonical" href="${escape(workspace.siteUrl)}/blog/${article.slug}"><title>${escape(article.title)}</title></head><body><a href="../blog/${article.slug}">${escape(article.title)}</a></body></html>`;
    const summaries = [];
    for (const name of await readdir(
      path.join(workspace.siteRoot, "content/blog"),
    )) {
      if (!/^[a-z0-9-]+\.md$/.test(name) || name === `${article.slug}.md`)
        continue;
      const parsed = matter(
        await readFile(
          path.join(workspace.siteRoot, "content/blog", name),
          "utf8",
        ),
      );
      if (!parsed.data.draft)
        summaries.push({ ...parsed.data, slug: name.slice(0, -3) });
    }
    summaries.push(article);
    const indexPath = path.join(
      workspace.siteRoot,
      "public/classic/index.html",
    );
    const index = buildWritingIndex(
      await readFile(indexPath, "utf8"),
      summaries,
    );
    const assetsDir = path.join(
      workspace.privateRoot,
      "assets/posts",
      article.slug,
    );
    const paths = [
      `content/blog/${article.slug}.md`,
      `public/classic/posts/${article.slug}.html`,
      "public/classic/index.html",
      `public/posts/${article.slug}.html`,
    ];
    if (await exists(assetsDir)) {
      for (const name of await readdir(assetsDir)) {
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) continue;
        const destination = path.join(
          workspace.siteRoot,
          "public/assets/posts",
          article.slug,
          name,
        );
        const source = await readFile(path.join(assetsDir, name));
        if (
          (await exists(destination)) &&
          hash(await readFile(destination)) !== hash(source)
        )
          throw new StudioError(
            `图片 ${name} 与已发布文件重名，请更换文件名。`,
          );
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(assetsDir, name), destination);
        paths.push(`public/assets/posts/${article.slug}/${name}`);
      }
    }
    await atomicWrite(path.join(workspace.siteRoot, paths[1]), classic);
    await atomicWrite(path.join(workspace.siteRoot, paths[3]), redirect);
    await atomicWrite(indexPath, index);
    await atomicWrite(articlePath(workspace, article.slug), markdown);
    article = { ...article, baseHash: hash(markdown), revision: randomUUID() };
    await atomicWrite(
      draftPath(workspace, article.slug),
      JSON.stringify(article, null, 2),
    );
    const publish = await publishPaths(
      workspace.siteRoot,
      paths,
      commitMessage || `publish: ${article.title}`,
    );
    const historyDir = path.join(workspace.privateRoot, "history");
    await mkdir(historyDir, { recursive: true });
    await rename(
      draftPath(workspace, article.slug),
      path.join(historyDir, `${article.slug}-${Date.now()}.json`),
    );
    return {
      article: await loadWorkspaceArticle(workspace, article.slug),
      publish,
    };
  } catch (error) {
    error.context = { ...error.context, savedArticle: article };
    throw error;
  }
}

export async function handleWorkspaceApi(
  request,
  response,
  pathname,
  workspace,
  helpers,
) {
  const { sendJson, readJson, assertMutationRequest } = helpers;
  const send = (data) => sendJson(response, 200, { ok: true, ...data });
  if (request.method === "POST") assertMutationRequest(request);
  if (request.method === "GET" && pathname === "/api/workspace")
    return send({
      workspace: {
        label: workspace.label,
        siteRoot: workspace.siteRoot,
        siteUrl: workspace.siteUrl,
        categories,
        author: workspace.author,
      },
    });
  if (request.method === "GET" && pathname === "/api/posts")
    return send({ posts: await listWorkspaceArticles(workspace) });
  if (request.method === "GET" && pathname === "/api/template")
    return send({ article: newWorkspaceDraft(workspace) });
  if (request.method === "GET" && pathname === "/api/status")
    return send({ status: await getGitStatus(workspace.siteRoot) });
  const post = /^\/api\/posts\/([a-z0-9-]+)$/.exec(pathname);
  if (request.method === "GET" && post)
    return send({ article: await loadWorkspaceArticle(workspace, post[1]) });
  if (request.method === "POST" && pathname === "/api/save")
    return send({
      article: await saveWorkspaceDraft(
        workspace,
        (await readJson(request)).article,
      ),
      message: "草稿已保存到本机，尚未发布。",
    });
  if (request.method === "POST" && pathname === "/api/preview") {
    const payload = await readJson(request);
    return send({
      html: renderWorkspacePreview(
        workspace,
        payload.article,
        payload.presentation,
      ),
    });
  }
  if (request.method === "POST" && pathname === "/api/assets") {
    const payload = await readJson(request);
    payload.fileName = `${randomUUID().slice(0, 8)}-${path.basename(String(payload.fileName || "image.png"))}`;
    const asset = await uploadArticleAsset(workspace.privateRoot, payload);
    return send({
      asset: { ...asset, src: asset.src.replace(/^\.\.\//, "/") },
    });
  }
  if (request.method === "POST" && pathname === "/api/publish") {
    const payload = await readJson(request);
    return send({
      ...(await publishWorkspaceArticle(
        workspace,
        payload.article,
        payload.commitMessage,
      )),
      message: "当前文章已推送，两版将随 GitHub Pages 部署一起更新。",
    });
  }
  throw new StudioError("API 地址不存在。", { code: "NOT_FOUND", status: 404 });
}
