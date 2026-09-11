import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { listArticles } from "./articles.mjs";
import { readSite, validateSite, renderHome, applySiteToPost } from "./site.mjs";

export async function syncSite(root, input) {
  const site = input ? validateSite(input) : await readSite(root);
  const posts = await listArticles(root);
  const template = await readFile(path.join(root, "theme", "home.html"), "utf8");
  // Prepare every transformation before writing any public file.
  const home = renderHome(template, site, posts);
  const pages = await Promise.all(posts.map(async (post) => ({
    file: path.join(root, "posts", `${post.slug}.html`),
    html: applySiteToPost(await readFile(path.join(root, "posts", `${post.slug}.html`), "utf8"), site, post.slug),
  })));
  if (input) await writeFile(path.join(root, "site.config.json"), `${JSON.stringify(site, null, 2)}\n`);
  await writeFile(path.join(root, "index.html"), home);
  for (const page of pages) await writeFile(page.file, page.html);
  // Local preview and checked-in HTML use the same public theme files as dist.
  for (const file of ["styles.css", "script.js"]) {
    await writeFile(path.join(root, file), await readFile(path.join(root, "theme", file)));
  }
  await mkdir(path.join(root, "assets", "posts"), { recursive: true });
  return site;
}
