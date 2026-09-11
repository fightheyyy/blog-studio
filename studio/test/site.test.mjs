import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { load } from "cheerio";
import { validateSite, readSite, renderHome } from "../lib/site.mjs";
import { syncSite } from "../lib/sync.mjs";
import { saveArticle, loadArticle } from "../lib/articles.mjs";
import { startStudioServer } from "../server.mjs";
import { build } from "../../scripts/build.mjs";

const source = path.resolve(import.meta.dirname, "../..");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "blog-studio-site-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["theme", "posts", "assets", "site.config.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(path.join(source, name), path.join(root, name), { recursive: true });
  await mkdir(path.join(root, "studio"), { recursive: true });
  await cp(path.join(source, "studio/public"), path.join(root, "studio/public"), { recursive: true });
  await syncSite(root);
  return root;
}

test("config text is escaped; portable links and optional canonical URLs have one owner", async (t) => {
  const root = await fixture(t);
  const site = await readSite(root);
  site.name = 'Mira <script>alert(1)</script>';
  site.nameStem = '<Mira>'; site.nameTail = '&'; site.title = 'Mira & friends';
  site.intro = '<img src=x onerror=alert(1)>';
  site.url = 'https://example.test/my-blog';
  site.projects = []; site.links = [{ label: '<contact>', url: 'mailto:hello@example.test' }];
  await syncSite(root, site);
  const html = await readFile(path.join(root, "index.html"), "utf8"), $ = load(html);
  assert.equal($("#home-title").attr("aria-label"), site.name);
  assert.equal($(".identity-primary").text(), site.intro);
  assert.equal($(".identity-primary img, #home-title script").length, 0);
  assert.equal($("link[rel='canonical']").attr("href"), "https://example.test/my-blog/");
  assert.ok($("#projects").is("[hidden]"));
  const article = await readFile(path.join(root, "posts/a-small-beginning.html"), "utf8");
  const post = load(article);
  assert.equal(post(".article-footer > span").text(), site.name);
  assert.equal(post("link[rel='canonical']").attr("href"), "https://example.test/my-blog/posts/a-small-beginning.html");
  await syncSite(root, { ...site, url: "" });
  assert.equal(load(await readFile(path.join(root, "posts/a-small-beginning.html"), "utf8"))("link[rel='canonical'], meta[property='og:url']").length, 0);
});

test("config validation rejects script, credentials, traversal and malformed fields", async () => {
  const site = await readSite(source);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', '//example.test', '../secret', 'https://user:password@example.test', 'posts/%2e%2e/secret', '/root-only']) {
    assert.throws(() => validateSite({ ...site, links: [{ label: 'link', url }] }), undefined, url);
  }
  for (const url of ['javascript:alert(1)', 'https://example.test/#fragment', 'https://example.test/?token=secret']) {
    assert.throws(() => validateSite({ ...site, url }));
  }
  assert.throws(() => validateSite({ ...site, projects: {} }));
  assert.throws(() => validateSite({ ...site, nameStem: '', nameTail: '' }));
  assert.throws(() => validateSite({ ...site, language: 'en" onload="evil' }));
  assert.equal(validateSite({ ...site, url: 'https://example.test/blog' }).url, 'https://example.test/blog/');
});

test("export includes only public files and every local link works at a repository subpath", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".env"), "PRIVATE_TEST_VALUE=true");
  await writeFile(path.join(root, "assets/.env"), "PRIVATE_TEST_VALUE=true");
  const output = await build(root);
  assert.deepEqual((await readdir(output)).sort(), [".nojekyll", "LICENSE", "THIRD_PARTY_NOTICES.md", "assets", "index.html", "posts", "script.js", "styles.css"]);
  assert.ok(!(await readdir(path.join(output, "assets"))).includes(".env"));
  const base = new URL("https://example.test/my-blog/");
  for (const name of ["index.html", ...(await readdir(path.join(output, "posts"))).map((name) => `posts/${name}`)]) {
    const html = await readFile(path.join(output, name), "utf8"), $ = load(html);
    assert.doesNotMatch(html, /Fightheyyy|fightheyyy|studio\/public/);
    for (const element of $("[href], [src]").toArray()) {
      const reference = $(element).attr("href") || $(element).attr("src");
      if (!reference || /^(?:https?:|mailto:|data:)/.test(reference)) continue;
      const url = new URL(reference, new URL(name, base));
      assert.ok(url.pathname.startsWith(base.pathname), `${name} escapes base: ${reference}`);
      const local = decodeURIComponent(url.pathname.slice(base.pathname.length)) || "index.html";
      await readFile(path.join(output, local));
    }
  }
});

test("changing site settings keeps authored content and scripts, including newly created posts", async (t) => {
  const root = await fixture(t);
  const before = await loadArticle(root, 'type-and-space');
  const file = path.join(root, 'posts/type-and-space.html');
  await writeFile(file, before.sourceHtml.replace('</body>', '<script src="../assets/demo.js"></script></body>'));
  await syncSite(root, { ...await readSite(root), name: 'Someone Else', nameStem: 'Someone', nameTail: 'Else' });
  const after = await loadArticle(root, 'type-and-space');
  assert.equal(after.contentHtml, before.contentHtml);
  assert.match(after.sourceHtml, /assets\/demo\.js/);
  await syncSite(root);
  assert.equal((await loadArticle(root, 'type-and-space')).sourceHtml, after.sourceHtml, 'repeated sync must not dirty unchanged articles');
  const created = await saveArticle(root, { ...after, slug: 'a-new-post', isNew: true });
  assert.equal(load(created.sourceHtml)(".article-footer > span").text(), 'Someone Else');
  assert.match(await readFile(path.join(root, 'index.html'), 'utf8'), /posts\/a-new-post\.html/);
});

test("HTTP rejects foreign origins and private paths, and settings preview never writes", async (t) => {
  const root = await fixture(t);
  const server = await startStudioServer({ repoRoot: root, port: 0 });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const pathname of ['/site.config.json', '/.git/config', '/studio/../lib/git.mjs', '/package.json']) {
    assert.equal((await fetch(`${base}${pathname}`)).status, 404, pathname);
  }
  const before = await readFile(path.join(root, 'site.config.json'), 'utf8');
  const site = { ...JSON.parse(before), name: 'Preview only' };
  const send = (pathname, origin = base, payload = { site }) => fetch(`${base}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(payload) });
  assert.equal((await send('/api/site', 'https://unrelated.example')).status, 403);
  assert.equal((await send('/api/site', 'http://127.0.0.1:1')).status, 403);
  assert.equal((await fetch(`${base}/api/site`, { method: 'POST', body: '{}' })).status, 415);
  const preview = await (await send('/api/site/preview')).json();
  assert.equal(preview.ok, true); assert.match(preview.html, /Preview only/);
  assert.equal(await readFile(path.join(root, 'site.config.json'), 'utf8'), before);
  assert.equal((await send('/api/site')).status, 200);
  assert.equal((await readSite(root)).name, 'Preview only');
  // A new article is saved before a missing-origin publish fails. The response
  // carries its persisted state so a browser retry doesn't try to create it twice.
  const article = { ...await loadArticle(root, 'type-and-space'), slug: 'publish-retry', isNew: true };
  const result = await (await send('/api/publish', base, { article, commitMessage: 'publish: new post' })).json();
  assert.equal(result.ok, false);
  assert.equal(result.context.savedArticle.isNew, false);
  assert.equal(result.context.savedArticle.slug, 'publish-retry');
});

test("site publication includes every saved post while leaving unrelated staged code alone", async (t) => {
  const root = await fixture(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), "blog-studio-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(remote, ["init", "--bare"]);
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Studio Test"]);
  git(root, ["config", "user.email", "test@example.test"]);
  git(root, ["add", "."]); git(root, ["commit", "-m", "initial"]);
  git(root, ["remote", "add", "origin", remote]); git(root, ["push", "-u", "origin", "main"]);
  const original = await loadArticle(root, "type-and-space");
  await saveArticle(root, { ...original, slug: "another-saved-post", title: "Another saved post", isNew: true });
  await writeFile(path.join(root, "unrelated-code.txt"), "must remain staged\n");
  git(root, ["add", "unrelated-code.txt"]);
  const server = await startStudioServer({ repoRoot: root, port: 0 });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article: { ...original, title: "Current article updated" }, commitMessage: "publish: all saved content" }),
  });
  const result = await response.json();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.publish.pushed, true);
  const publishedHome = git(remote, ["show", "main:index.html"]);
  assert.match(publishedHome, /another-saved-post\.html/);
  assert.match(git(remote, ["show", "main:posts/another-saved-post.html"]), /Another saved post/);
  assert.match(git(remote, ["show", "main:posts/type-and-space.html"]), /Current article updated/);
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "unrelated-code.txt");
  assert.throws(() => git(remote, ["show", "main:unrelated-code.txt"]));
});
