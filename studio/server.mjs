import { access, readFile, stat, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  StudioError,
  createNewDraft,
  listArticles,
  loadArticle,
  saveArticle,
  uploadArticleAsset,
  validateSlug,
} from "./lib/articles.mjs";
import { getGitStatus, publishPaths } from "./lib/git.mjs";
import { readSite, validateSite, renderHome } from "./lib/site.mjs";
import { syncSite } from "./lib/sync.mjs";
import { resolveWorkspace, handleWorkspaceApi } from "./lib/workspace.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(moduleDir, "..");
const MAX_JSON_BYTES = 12_000_000;

const CONTENT_TYPES = new Map([
  [".svg", "image/svg+xml"],
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".woff2", "font/woff2"],
  [".mmd", "text/plain; charset=utf-8"],
]);

export function createStudioServer({
  repoRoot = defaultRepoRoot,
  workspace = null,
} = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  let mutationQueue = Promise.resolve();
  return http.createServer(async (request, response) => {
    setBaseHeaders(response);

    try {
      assertLocalHost(request);
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "127.0.0.1"}`,
      );
      const pathname = decodeURIComponent(url.pathname);

      if (request.method === "GET" && pathname === "/") {
        response.writeHead(302, { Location: "/studio/" });
        response.end();
        return;
      }

      if (pathname.startsWith("/api/")) {
        if (request.method === "POST" && pathname !== "/api/preview") {
          const operation = mutationQueue.then(() =>
            handleApi(request, response, pathname, resolvedRepoRoot, workspace),
          );
          mutationQueue = operation.catch(() => {});
          await operation;
        } else {
          await handleApi(
            request,
            response,
            pathname,
            resolvedRepoRoot,
            workspace,
          );
        }
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new StudioError("不支持这个请求方法。", {
          code: "METHOD_NOT_ALLOWED",
          status: 405,
        });
      }

      if (workspace && pathname === "/index.html") {
        response.writeHead(302, { Location: workspace.siteUrl });
        response.end();
        return;
      }
      if (
        workspace &&
        ["/studio/index.html", "/studio/site.html"].includes(pathname)
      ) {
        response.writeHead(302, { Location: "/studio/" });
        response.end();
        return;
      }
      if (workspace && pathname.startsWith("/blog-fonts/")) {
        const base = path.join(workspace.siteRoot, "public/fonts");
        await sendFile(
          response,
          within(base, pathname.slice("/blog-fonts/".length)),
          request.method === "HEAD",
          base,
        );
        return;
      }
      if (workspace && pathname.startsWith("/preview-site/")) {
        const base = path.join(workspace.siteRoot, "public");
        await sendFile(
          response,
          within(base, pathname.slice("/preview-site/".length)),
          request.method === "HEAD",
          base,
        );
        return;
      }
      if (workspace && pathname.startsWith("/assets/posts/")) {
        const relative = pathname.slice("/assets/".length);
        for (const base of [
          path.join(workspace.privateRoot, "assets"),
          path.join(workspace.siteRoot, "public/assets"),
          path.join(workspace.siteRoot, "public/classic/assets"),
        ]) {
          const file = within(base, relative);
          if (await exists(file)) {
            await sendFile(response, file, request.method === "HEAD", base);
            return;
          }
        }
        throw new StudioError("图片不存在。", { status: 404 });
      }
      const staticFile = resolveStaticFile(
        resolvedRepoRoot,
        pathname,
        workspace,
      );
      if (!staticFile) {
        sendJson(response, 404, {
          ok: false,
          error: "页面不存在。",
          code: "NOT_FOUND",
        });
        return;
      }
      const allowedRoot = pathname.startsWith("/studio")
        ? path.join(resolvedRepoRoot, "studio", "public")
        : pathname.startsWith("/assets/")
          ? path.join(resolvedRepoRoot, "assets")
          : pathname.startsWith("/posts/")
            ? path.join(resolvedRepoRoot, "posts")
            : resolvedRepoRoot;
      await sendFile(
        response,
        staticFile,
        request.method === "HEAD",
        allowedRoot,
      );
    } catch (error) {
      sendError(response, error);
    }
  });
}

export async function startStudioServer({
  repoRoot = defaultRepoRoot,
  port = 4174,
  workspace,
} = {}) {
  const targetWorkspace =
    workspace === undefined ? await resolveWorkspace(repoRoot) : workspace;
  const server = createStudioServer({ repoRoot, workspace: targetWorkspace });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

async function handleApi(request, response, pathname, repoRoot, workspace) {
  if (workspace)
    return handleWorkspaceApi(request, response, pathname, workspace, {
      sendJson,
      readJson,
      assertMutationRequest,
    });
  if (request.method === "GET" && pathname === "/api/site") {
    sendJson(response, 200, { ok: true, site: await readSite(repoRoot) });
    return;
  }
  if (
    request.method === "POST" &&
    ["/api/site", "/api/site/preview"].includes(pathname)
  ) {
    assertMutationRequest(request);
    const payload = await readJson(request);
    const site = validateSite(payload.site);
    if (pathname.endsWith("/preview")) {
      const template = await readFile(
        path.join(repoRoot, "theme", "home.html"),
        "utf8",
      );
      sendJson(response, 200, {
        ok: true,
        html: renderHome(template, site, await listArticles(repoRoot)),
      });
    } else {
      await syncSite(repoRoot, site);
      sendJson(response, 200, {
        ok: true,
        site,
        message: "已保存首页配置，并同步所有文章的站点名称和导航。",
      });
    }
    return;
  }

  if (request.method === "GET" && pathname === "/api/posts") {
    const posts = await listArticles(repoRoot);
    sendJson(response, 200, { ok: true, posts });
    return;
  }

  if (request.method === "GET" && pathname === "/api/template") {
    const article = await createNewDraft(repoRoot);
    sendJson(response, 200, { ok: true, article });
    return;
  }

  if (request.method === "GET" && pathname === "/api/status") {
    const status = await getGitStatus(repoRoot);
    sendJson(response, 200, { ok: true, status });
    return;
  }

  const postMatch = /^\/api\/posts\/([a-z0-9-]+)$/.exec(pathname);
  if (request.method === "GET" && postMatch) {
    const article = await loadArticle(repoRoot, postMatch[1]);
    sendJson(response, 200, { ok: true, article });
    return;
  }

  if (request.method === "POST" && pathname === "/api/save") {
    assertMutationRequest(request);
    const payload = await readJson(request);
    const article = await saveArticle(repoRoot, payload.article);
    sendJson(response, 200, {
      ok: true,
      article,
      message: `已保存 posts/${article.slug}.html，并更新首页 Writing 列表。`,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/assets") {
    assertMutationRequest(request);
    const payload = await readJson(request);
    const asset = await uploadArticleAsset(repoRoot, payload);
    sendJson(response, 201, {
      ok: true,
      asset,
      message: `图片已保存为 ${asset.fileName}。`,
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/publish") {
    assertMutationRequest(request);
    const payload = await readJson(request);
    let article;
    try {
      if (payload.article)
        article = await saveArticle(repoRoot, payload.article);
      await syncSite(repoRoot);
      const paths = [
        "site.config.json",
        "index.html",
        "styles.css",
        "script.js",
        "posts",
        "assets",
      ];
      const commitMessage =
        payload.commitMessage || "publish: saved site content";
      const publish = await publishPaths(repoRoot, paths, commitMessage);
      sendJson(response, 200, {
        ok: true,
        article,
        publish,
        message: publish.pushed
          ? `已推送到 origin（${publish.commit}）。部署状态请查看 GitHub Actions。`
          : publish.message,
      });
    } catch (error) {
      if (article && error instanceof StudioError)
        error.context = { ...error.context, savedArticle: article };
      throw error;
    }
    return;
  }

  throw new StudioError("API 地址不存在。", { code: "NOT_FOUND", status: 404 });
}

function resolveStaticFile(repoRoot, pathname, workspace) {
  if (pathname === "/studio" || pathname === "/studio/") {
    return within(
      path.join(repoRoot, "studio", "public"),
      workspace ? "writing.html" : "index.html",
    );
  }
  if (pathname.startsWith("/studio/")) {
    const relative = pathname.slice("/studio/".length);
    if (!relative || relative.includes("\0")) return null;
    return within(path.join(repoRoot, "studio", "public"), relative);
  }
  if (pathname === "/index.html") return within(repoRoot, "index.html");
  if (pathname === "/styles.css") return within(repoRoot, "styles.css");
  if (pathname === "/script.js") return within(repoRoot, "script.js");
  if (pathname.startsWith("/assets/"))
    return within(path.join(repoRoot, "assets"), pathname.slice(8));
  if (pathname.startsWith("/posts/"))
    return within(path.join(repoRoot, "posts"), pathname.slice(7));
  return null;
}

async function sendFile(response, filePath, headOnly, allowedRoot) {
  let fileStats;
  try {
    const actual = await realpath(filePath);
    if (
      actual !== allowedRoot &&
      !actual.startsWith(`${allowedRoot}${path.sep}`)
    ) {
      throw new StudioError("文件路径超出允许范围。", {
        code: "INVALID_PATH",
        status: 403,
      });
    }
    fileStats = await stat(actual);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(response, 404, {
        ok: false,
        error: "文件不存在。",
        code: "NOT_FOUND",
      });
      return;
    }
    throw error;
  }
  if (!fileStats.isFile()) {
    sendJson(response, 404, {
      ok: false,
      error: "文件不存在。",
      code: "NOT_FOUND",
    });
    return;
  }

  const contentType =
    CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ||
    "application/octet-stream";
  const headers = {
    "Content-Type": contentType,
    "Content-Length": fileStats.size,
    "Cache-Control": "no-store",
  };
  response.writeHead(200, headers);
  if (headOnly) {
    response.end();
    return;
  }
  response.end(await readFile(filePath));
}

function assertLocalHost(request) {
  const host = String(request.headers.host ?? "").toLowerCase();
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) {
    throw new StudioError("Blog Studio 只接受本机请求。", {
      code: "LOCAL_ONLY",
      status: 403,
    });
  }
}

function assertMutationRequest(request) {
  const contentType = String(
    request.headers["content-type"] ?? "",
  ).toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new StudioError("写操作必须使用 application/json。", {
      code: "JSON_REQUIRED",
      status: 415,
    });
  }
  const origin = request.headers.origin;
  if (!origin) return;
  if (origin !== `http://${request.headers.host}`) {
    throw new StudioError("拒绝来自其他来源的写操作。", {
      code: "CROSS_ORIGIN_MUTATION",
      status: 403,
    });
  }
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES) {
      throw new StudioError("请求内容超过 12 MB。", {
        code: "REQUEST_TOO_LARGE",
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new StudioError("JSON 格式无效。", {
      code: "INVALID_JSON",
      status: 400,
    });
  }
}

function sendJson(response, status, value) {
  if (response.headersSent) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  if (error instanceof StudioError) {
    sendJson(response, error.status || 400, {
      ok: false,
      error: error.message,
      code: error.code,
      details: error.details || undefined,
      context: Object.keys(error.context || {}).length
        ? error.context
        : undefined,
    });
    return;
  }
  console.error(error);
  sendJson(response, 500, {
    ok: false,
    error: "Blog Studio 遇到未预期的错误。",
    code: "INTERNAL_ERROR",
  });
}

function setBaseHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "SAMEORIGIN");
}

function within(base, relative) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, relative);
  if (
    resolved !== resolvedBase &&
    !resolved.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    throw new StudioError("文件路径无效。", {
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

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const port = Number(process.env.BLOG_STUDIO_PORT || 4174);
  resolveWorkspace(defaultRepoRoot)
    .then(async (workspace) => {
      if (!workspace) await syncSite(defaultRepoRoot);
      return startStudioServer({ port, workspace });
    })
    .then(() => {
      console.log(`\n  Blog Studio\n  http://127.0.0.1:${port}/studio/\n`);
      console.log("  按 Ctrl+C 停止。\n");
    })
    .catch((error) => {
      console.error(`Blog Studio 启动失败：${error.message}`);
      process.exitCode = 1;
    });
}
