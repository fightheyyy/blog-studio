import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listArticles } from "../studio/lib/articles.mjs";
import { readSite, renderHome, applySiteToPost } from "../studio/lib/site.mjs";

const defaultRoot = path.resolve(import.meta.dirname, "..");
const assetTypes = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".txt", ".pdf", ".css", ".js", ".json", ".mp3", ".mp4", ".webm", ".mmd"]);

export async function build(root = defaultRoot) {
  root = path.resolve(root);
  const site = await readSite(root);
  const articles = await listArticles(root);
  const home = renderHome(await readFile(path.join(root, "theme", "home.html"), "utf8"), site, articles);
  const pages = await Promise.all(articles.map(async (article) => ({
    name: `${article.slug}.html`,
    html: applySiteToPost(await readFile(path.join(root, "posts", `${article.slug}.html`), "utf8"), site, article.slug),
  })));
  const output = path.join(root, "dist");
  // Never follow a dist symlink when replacing a previous export.
  const existing = await lstat(output).catch((error) => { if (error.code !== "ENOENT") throw error; });
  if (existing?.isSymbolicLink()) throw new Error("dist must not be a symbolic link.");
  if (path.dirname(output) !== root) throw new Error("Invalid output directory.");
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, "posts"), { recursive: true });
  await writeFile(path.join(output, "index.html"), home);
  for (const page of pages) await writeFile(path.join(output, "posts", page.name), page.html);
  for (const name of ["styles.css", "script.js"]) await cp(path.join(root, "theme", name), path.join(output, name));
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) await cp(path.join(root, name), path.join(output, name));
  await copyAssets(path.join(root, "assets"), path.join(output, "assets"));
  await writeFile(path.join(output, ".nojekyll"), "");
  console.log(`Built ${pages.length} articles → ${output}`);
  return output;
}

async function copyAssets(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyAssets(from, to);
    else if (entry.isFile() && assetTypes.has(path.extname(entry.name).toLowerCase())) await cp(from, to);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
