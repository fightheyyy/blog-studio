import { readFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { StudioError } from "./errors.mjs";

export function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function text(value, label, max = 800, required = false) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new StudioError(`${label}格式不正确，最多 ${max} 个字符。`, { code: "INVALID_SITE", status: 422 });
  }
  return value.trim();
}

function safeUrl(value) {
  const url = text(value, "链接", 2000, true);
  if (/\s|[\\<>"'\x00-\x1f]/.test(url) || url.startsWith("/") || /%2f|%5c|%2e/i.test(url)) {
    throw new StudioError("请使用 https://、mailto: 或相对路径链接。", { code: "INVALID_URL", status: 422 });
  }
  if (/^https?:\/\//i.test(url)) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new StudioError("网址格式无效。", { code: "INVALID_URL", status: 422 }); }
    if (parsed.username || parsed.password) throw new StudioError("链接不能包含登录凭据。", { code: "INVALID_URL", status: 422 });
  } else if (!/^mailto:[^@]+@[^@]+$/i.test(url) && !/^(?:#[\w-]+|[a-zA-Z0-9_-][\w./#?=&%-]*)$/.test(url)) {
    throw new StudioError("链接格式不受支持。", { code: "INVALID_URL", status: 422 });
  }
  if (url.split(/[/?#]/).includes("..")) throw new StudioError("相对链接不能跳出站点。", { code: "INVALID_URL", status: 422 });
  return url;
}

function links(value, max) {
  if (!Array.isArray(value) || value.length > max) throw new StudioError(`链接最多 ${max} 项。`, { code: "INVALID_SITE", status: 422 });
  return value.map((link) => ({ label: text(link?.label, "链接文字", 50, true), url: safeUrl(link?.url) }));
}

export function validateSite(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new StudioError("站点配置无效。", { code: "INVALID_SITE", status: 422 });
  const site = {
    name: text(input.name, "显示名称", 48, true),
    nameStem: text(input.nameStem, "实心名称", 36),
    nameTail: text(input.nameTail, "描边名称", 12),
    language: text(input.language, "语言", 20, true),
    title: text(input.title, "站点标题", 160, true),
    description: text(input.description, "站点摘要"),
    url: text(input.url, "站点地址", 2000),
    intro: text(input.intro, "一句介绍", 300, true),
    about: text(input.about, "补充介绍"),
  };
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(site.language)) throw new StudioError("语言示例：zh-CN、en。", { code: "INVALID_SITE", status: 422 });
  if (!site.nameStem && !site.nameTail) throw new StudioError("请填写名称的实心或描边部分。", { code: "INVALID_SITE", status: 422 });
  if (site.url) {
    try {
      const url = new URL(site.url);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      site.url = url.href.replace(/\/+$/, "") + "/";
    } catch { throw new StudioError("站点地址应是完整的 HTTP(S) 地址，可包含仓库子路径。", { code: "INVALID_URL", status: 422 }); }
  }
  if (!Array.isArray(input.projects) || input.projects.length > 30) throw new StudioError("项目最多 30 项。", { code: "INVALID_SITE", status: 422 });
  site.projects = input.projects.map((project) => ({
    name: text(project?.name, "项目名称", 120, true),
    description: text(project?.description, "项目简介", 200),
    links: links(project?.links, 5),
  }));
  if (site.projects.some((p) => !p.links.length)) throw new StudioError("每个项目至少需要一个链接。", { code: "INVALID_SITE", status: 422 });
  site.links = links(input.links, 15);
  return site;
}

export async function readSite(root) {
  return validateSite(JSON.parse(await readFile(path.join(root, "site.config.json"), "utf8")));
}

function metadata($, site, relative, title, description) {
  $("html").attr("lang", site.language);
  $("title").text(title);
  for (const [attribute, key, value] of [
    ["name", "description", description], ["name", "author", site.name],
    ["property", "og:title", title], ["property", "og:description", description],
    ["property", "og:site_name", site.title],
  ]) {
    $(`meta[${attribute}='${key}']`).remove();
    $("head").append(`<meta ${attribute}="${key}" content="${escapeHtml(value)}">`);
  }
  $("link[rel='canonical'], meta[property='og:url']").remove();
  if (site.url) {
    const url = escapeHtml(new URL(relative, site.url).href);
    $("head").append(`<link rel="canonical" href="${url}"><meta property="og:url" content="${url}">`);
  }
}

function anchor(link, className = "", prefix = "") {
  const href = /^(https?:|mailto:)/i.test(link.url) ? link.url : `${prefix}${link.url}`;
  const external = /^https?:/i.test(href) ? ' target="_blank" rel="noreferrer"' : "";
  return `<a${className ? ` class="${className}"` : ""} href="${escapeHtml(href)}"${external}>${escapeHtml(link.label)}</a>`;
}

export function renderHome(template, site, articles) {
  const $ = load(template);
  metadata($, site, "", site.title, site.description);
  $("#home-title").attr("aria-label", site.name);
  $(".name-stem").text(site.nameStem);
  $(".name-tail-group").html([...site.nameTail].map((letter, i) => `<span class="name-tail" style="--tail-index: ${i}">${escapeHtml(letter)}</span>`).join(""));
  $(".identity-primary").text(site.intro);
  $(".identity-secondary").text(site.about);
  $(".project-index").html(site.projects.map((project) => `<div class="index-item reveal-item"><div class="index-link project-link-multi">${anchor({label: project.name, url: project.links[0].url}, "index-title index-title-link")}<span class="index-context">${escapeHtml(project.description)}</span><span class="project-destinations" aria-label="${escapeHtml(project.name)} links">${project.links.map((link) => anchor(link)).join('<span class="project-destination-separator" aria-hidden="true">·</span>')}</span></div></div>`).join("\n"));
  // Keep the anchor available even when the owner has no projects yet.
  $("#projects").attr("hidden", site.projects.length ? null : "");
  $(".skip-link").attr("href", "#blog").text("Skip to writing");
  const rows = [...articles].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)).map((article) => `<div class="index-item reveal-item"><a class="index-link writing-link" href="posts/${escapeHtml(article.slug)}.html"><span class="index-title">${escapeHtml(article.title)}</span><span class="index-destination">Read</span></a></div>`);
  $(".writing-index").html(`<!-- blog-studio:writing:start -->\n${rows.join("\n") || '<p class="empty-writing">还没有文章。第一篇，留给你来写。</p>'}\n<!-- blog-studio:writing:end -->`);
  $(".social-links").html(site.links.map((link) => anchor(link)).join("\n"));
  return `<!doctype html>\n${$("html").toString()}\n`;
}

export function applySiteToPost(html, site, slug) {
  const $ = load(html.trimEnd());
  const title = $(".article-header h1").attr("aria-label") || $("title").text();
  const description = $("meta[name='description']").attr("content") || $(".article-deck").text();
  metadata($, site, `posts/${slug}.html`, title, description);
  $(".article-name-mark").attr("aria-label", site.name);
  $(".article-name-stem").text(site.nameStem);
  $(".article-name-tail").text(site.nameTail);
  $(".article-site-header .nav").html('<a href="../index.html#blog">Writing</a>' + (site.projects.length ? '<a href="../index.html#projects">Projects</a>' : ""));
  $(".article-footer > span").text(site.name);
  return `<!doctype html>\n${$("html").toString()}\n`;
}
