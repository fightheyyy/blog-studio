import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  StudioError,
  applyArticleToHtml,
  articleFromHtml,
  buildWritingIndex,
  loadArticle,
  saveArticle,
  uploadArticleAsset,
  validateSlug,
} from "../lib/articles.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..", "..");

test("saveArticle updates managed fields while preserving custom page chrome", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await readFile(path.join(root, "theme", "article.html"), "utf8");
  const custom = template
    .replace('class="article-page"', 'class="article-page custom-theme"')
    .replace("</body>", '<script src="../assets/posts/existing/custom.js"></script>\n  </body>');
  await writeFile(path.join(root, "posts", "existing.html"), custom);

  const saved = await saveArticle(root, {
    slug: "existing",
    isNew: false,
    title: "一篇由本人写下的现场记录",
    headlineLines: ["一篇由本人写下的", "现场记录"],
    kicker: "Field Notes · Robot",
    deck: "这是一段具体、克制的页头导语。",
    description: "搜索摘要",
    date: "2026-09-04",
    readMinutes: 11,
    contentHtml: '<p class="article-lead">真实的第一段。</p><h2>发生了什么</h2><p>细节。</p>',
  });

  assert.equal(saved.title, "一篇由本人写下的现场记录");
  assert.deepEqual(saved.headlineLines, ["一篇由本人写下的", "现场记录"]);
  const output = await readFile(path.join(root, "posts", "existing.html"), "utf8");
  assert.match(output, /custom-theme/);
  assert.match(output, /custom\.js/);
  assert.match(output, /真实的第一段/);
  assert.match(output, /canonical[^>]+existing\.html/);
  const index = await readFile(path.join(root, "index.html"), "utf8");
  assert.match(index, /posts\/existing\.html/);
  assert.match(index, /一篇由本人写下的现场记录/);
});

test("saveArticle creates a new article and refuses an existing slug", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const article = sampleArticle({ slug: "new-field-note", isNew: true });
  await saveArticle(root, article);
  const loaded = await loadArticle(root, "new-field-note");
  assert.equal(loaded.title, article.title);
  await assert.rejects(() => saveArticle(root, article), (error) => {
    assert.equal(error.code, "ARTICLE_EXISTS");
    return true;
  });
});

test("slug and writing marker validation reject unsafe inputs", () => {
  assert.equal(validateSlug("Has-Caps"), "has-caps");
  for (const slug of ["../secret", "two words", "a/b", "-leading"]) {
    assert.throws(() => validateSlug(slug), StudioError);
  }
  assert.throws(() => buildWritingIndex("<main></main>", []), (error) => {
    assert.equal(error.code, "INDEX_MARKERS_MISSING");
    return true;
  });
});

test("uploadArticleAsset writes a scoped raster asset with a safe filename", async (t) => {
  const root = await createFixtureRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const onePixelPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const result = await uploadArticleAsset(root, {
    slug: "new-field-note",
    fileName: "My Screenshot!!.png",
    dataUrl: onePixelPng,
  });
  assert.equal(result.fileName, "my-screenshot.png");
  assert.equal(result.src, "../assets/posts/new-field-note/my-screenshot.png");
  const file = await readFile(path.join(root, "assets", "posts", "new-field-note", result.fileName));
  assert.ok(file.length > 20);
});

test("all existing article variants survive a managed-field round trip", async () => {
  const postsDir = path.join(sourceRoot, "posts");
  const names = (await readdir(postsDir)).filter((name) => name.endsWith(".html"));
  assert.ok(names.length >= 2);

  for (const name of names) {
    const slug = name.slice(0, -5);
    const source = await readFile(path.join(postsDir, name), "utf8");
    const article = articleFromHtml(source, slug, false);
    const output = applyArticleToHtml(source, article);
    const roundTrip = articleFromHtml(output, slug, false);
    assert.equal(roundTrip.title, article.title, name);
    assert.deepEqual(roundTrip.headlineLines, article.headlineLines, name);
    assert.equal(roundTrip.contentHtml.replace(/\s+/g, " "), article.contentHtml.replace(/\s+/g, " "), name);

    for (const sourcePath of source.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
      assert.ok(output.includes(sourcePath[1]), `${name} lost ${sourcePath[1]}`);
    }
    const bodyClasses = /<body\s+class="([^"]+)"/.exec(source)?.[1]?.split(/\s+/) ?? [];
    bodyClasses.forEach((className) => assert.match(output, new RegExp(`\\b${className}\\b`), name));
  }
});

async function createFixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "blog-studio-studio-"));
  await mkdir(path.join(root, "posts"), { recursive: true });
  await mkdir(path.join(root, "assets", "posts"), { recursive: true });
  await mkdir(path.join(root, "theme"), { recursive: true });
  const template = await readFile(path.join(sourceRoot, "theme", "article.html"), "utf8");
  await writeFile(path.join(root, "theme", "article.html"), template);
  await writeFile(path.join(root, "theme", "home.html"), await readFile(path.join(sourceRoot, "theme", "home.html")));
  const config = JSON.parse(await readFile(path.join(sourceRoot, "site.config.json"), "utf8"));
  config.url = "https://example.test/blog/";
  await writeFile(path.join(root, "site.config.json"), JSON.stringify(config));
  await writeFile(
    path.join(root, "index.html"),
    `<main>\n  ${"<!-- blog-studio:writing:start -->"}\n  ${"<!-- blog-studio:writing:end -->"}\n</main>\n`,
  );
  return root;
}

function sampleArticle(overrides = {}) {
  return {
    slug: "field-note",
    isNew: true,
    title: "现场笔记",
    headlineLines: ["现场笔记"],
    kicker: "Field Notes · Agent",
    deck: "从一个具体问题开始。",
    description: "现场笔记摘要。",
    date: "2026-09-04",
    readMinutes: 8,
    contentHtml: '<p class="article-lead">第一段。</p><p>正文。</p>',
    ...overrides,
  };
}
