import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import matter from "gray-matter";

const templates = new Map();
const pending = new Map();
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

async function templateSlug(workspace, article) {
  if (article.baseHash) return article.slug;
  let first;
  for (const file of await readdir(
    path.join(workspace.siteRoot, "content/blog"),
  )) {
    if (!/^[a-z0-9-]+\.md$/.test(file)) continue;
    const data = matter(
      await readFile(
        path.join(workspace.siteRoot, "content/blog", file),
        "utf8",
      ),
    ).data;
    if (data.draft) continue;
    first ||= file.slice(0, -3);
    if (data.category === article.category) return file.slice(0, -3);
  }
  if (!first) throw new Error("还没有可读取的线上 Editorial 文章主题。");
  return first;
}

async function getTemplate(workspace, article) {
  const slug = await templateSlug(workspace, article);
  const key = `${workspace.siteRoot}:${slug}`;
  const previous = templates.get(key);
  if (previous && Date.now() - previous.time < 300000) return previous.html;
  const cacheFile = path.join(workspace.privateRoot, "themes", `${slug}.html`);
  let cached;
  if (pending.has(key)) return pending.get(key);
  const request = (async () => {
    try {
      cached = await readFile(cacheFile, "utf8");
      if (Date.now() - (await stat(cacheFile)).mtimeMs < 300000) {
        templates.set(key, { html: cached, time: Date.now() });
        return cached;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      // Only an existing public article URL is requested; manuscripts stay local.
      const response = await fetch(`${workspace.siteUrl}/blog/${slug}/`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`主题请求失败（${response.status}）。`);
      const html = await response.text();
      if (!load(html)("main.article-page .article-hero").length)
        throw new Error("线上页面缺少 Editorial 文章结构。");
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, html, "utf8");
      templates.set(key, { html, time: Date.now() });
      return html;
    } catch (error) {
      if (cached || previous) return cached || previous.html;
      throw error;
    }
  })();
  pending.set(key, request);
  try {
    return await request;
  } finally {
    pending.delete(key);
  }
}

function safeDocument($) {
  $(
    "script, iframe, object, embed, form, base, link[rel=modulepreload], link[rel=prefetch], link[as=script], meta[http-equiv]",
  ).remove();
  $("*").each((_, element) => {
    for (const [name, value] of Object.entries(element.attribs || {})) {
      if (
        /^on/i.test(name) ||
        name === "srcdoc" ||
        /^(?:javascript|vbscript):/i.test(value.trim())
      )
        $(element).removeAttr(name);
    }
  });
  $("head").append(
    "<meta http-equiv=\"Content-Security-Policy\" content=\"script-src 'none'; object-src 'none'; form-action 'none'\">",
  );
  $("head").append(
    "<style>.site-header a,.site-header button,.classic-site-header a,.classic-site-header button,.share-actions,.related-section{pointer-events:none!important}.mobile-reading-progress{display:none!important}html{scroll-behavior:auto!important}body{min-height:0!important}</style>",
  );
}

async function currentArticleMark(workspace, article) {
  try {
    // Reuse the target blog's SVG geometry; never evaluate its component code.
    const source = await readFile(
      path.join(workspace.siteRoot, "app/components/ArticleMark.vue"),
      "utf8",
    );
    const script = source.split("<template>")[0];
    let kind;
    for (const match of script.matchAll(
      /if\s*\(props\.path\.includes\(['"]([^'"]+)['"]\)\)\s*return\s*['"]([^'"]+)['"]/g,
    )) {
      if (article.slug.includes(match[1])) {
        kind = match[2];
        break;
      }
    }
    if (!kind) {
      for (const match of script.matchAll(
        /if\s*\(props\.category\s*===\s*['"]([^'"]+)['"]\)\s*return\s*['"]([^'"]+)['"]/g,
      )) {
        if (article.category === match[1]) {
          kind = match[2];
          break;
        }
      }
    }
    kind ||= [...script.matchAll(/return\s+['"]([^'"]+)['"]/g)].at(-1)?.[1];
    const mark = load(
      source.split("<template>")[1]?.split("</template>")[0] || "",
      { xmlMode: true },
    );
    const svg = mark("svg").first();
    if (!kind || !svg.length) return null;
    const groups = svg.children("g").toArray();
    const selected =
      groups.find((element) => {
        const expression =
          element.attribs["v-if"] || element.attribs["v-else-if"];
        return (
          expression &&
          (expression.includes(`'${kind}'`) || expression.includes(`"${kind}"`))
        );
      }) || groups.find((element) => Object.hasOwn(element.attribs, "v-else"));
    groups
      .filter((element) => element !== selected)
      .forEach((element) => mark(element).remove());
    svg
      .find("*")
      .addBack()
      .each((_, element) => {
        for (const name of Object.keys(element.attribs || {}))
          if (name.startsWith(":") || name.startsWith("v-"))
            mark(element).removeAttr(name);
      });
    svg.attr("class", "article-mark is-large");
    return mark.html(svg);
  } catch {
    return null;
  }
}

export async function renderEditorialTheme(workspace, article, body) {
  const $ = load(await getTemplate(workspace, article));
  safeDocument($);
  $("body > *").each((_, element) => {
    if (
      element.name !== "div" &&
      !$(element).hasClass("site-header") &&
      !$(element).hasClass("article-page")
    )
      $(element).remove();
  });
  $(
    ".site-footer, .related-section, .skip-link, nuxt-devtools-panel, .rail-progress, .rail-hint, .share-actions",
  ).remove();
  $("head [href], head [src], .site-header [src]").each((_, element) => {
    for (const attr of ["href", "src"]) {
      const value = $(element).attr(attr);
      if (value && !value.startsWith("#") && !value.startsWith("data:"))
        $(element).attr(attr, new URL(value, `${workspace.siteUrl}/`).href);
    }
  });
  $(".article-hero h1")
    .first()
    .text(article.title || "无标题文章");
  $("title").text(`${article.title || "无标题文章"} · Editorial 预览`);
  $(".article-hero .standfirst").text(article.description);
  $(".article-brandline .badge").text(article.category);
  const mark = await currentArticleMark(workspace, article);
  if (mark) $(".article-brandline .article-emblem").html(mark);
  const date = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${article.date}T00:00:00Z`));
  const metadata = $(".article-hero .article-meta dd");
  metadata.eq(0).text(workspace.author);
  metadata
    .eq(1)
    .html(`<time datetime="${article.date}">${escape(date)}</time>`);
  metadata.eq(2).text(`${article.readingMinutes} min`);
  const content = load(`<div>${body}</div>`, null, false);
  const headings = [];
  const used = new Set();
  content("h2,h3").each((index, element) => {
    const text = content(element).text();
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-|-$/g, "") || `heading-${index + 1}`;
    let id = base;
    let suffix = 1;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    content(element).attr("id", id);
    headings.push({ text, id, depth: element.name });
  });
  $(".article-body-grid .prose").first().html(content.html());
  $(".rail-title").text(article.title);
  $(".contents-tree ul")
    .first()
    .html(
      headings
        .map(
          (heading) =>
            `<li${heading.depth === "h3" ? ' style="padding-left:14px"' : ""}><a href="about:srcdoc#${encodeURIComponent(heading.id)}"><span aria-hidden="true">└</span>${escape(heading.text)}</a></li>`,
        )
        .join(""),
    );
  if (!headings.length) $(".contents-tree").hide();
  return $.html();
}

export function renderMinimalTheme(html) {
  const $ = load(html);
  safeDocument($);
  $(".classic-shared-footer").remove();
  $("head").prepend('<base href="/preview-site/classic/posts/">');
  // Root-relative manuscript images are served from the Studio's private asset adapter.
  return $.html();
}
