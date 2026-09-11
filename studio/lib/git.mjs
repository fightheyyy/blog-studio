import { spawn } from "node:child_process";
import path from "node:path";
import { StudioError } from "./articles.mjs";

const MAX_OUTPUT = 80_000;

export async function getGitStatus(repoRoot) {
  const inside = await runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"], {
    acceptedCodes: [0, 128],
  });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    throw new StudioError("Blog Studio 必须从 Git 仓库中运行。", {
      code: "NOT_A_GIT_REPOSITORY",
      status: 500,
    });
  }

  const [branchResult, remoteResult, dirtyResult, upstreamResult] = await Promise.all([
    runGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["remote", "get-url", "origin"], { acceptedCodes: [0, 2] }),
    runGit(repoRoot, ["status", "--short"]),
    runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], {
      acceptedCodes: [0, 128],
    }),
  ]);

  const branch = branchResult.stdout.trim();
  if (!branch) {
    throw new StudioError("当前处于 detached HEAD，不能从 Studio 发布。", {
      code: "DETACHED_HEAD",
      status: 409,
    });
  }

  const [behind = 0, ahead = 0] =
    upstreamResult.code === 0
      ? upstreamResult.stdout
          .trim()
          .split(/\s+/)
          .map((value) => Number(value) || 0)
      : [0, 0];
  const dirtyPaths = dirtyResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  return {
    branch,
    remote: remoteResult.code === 0 ? sanitizeRemote(remoteResult.stdout.trim()) : "未配置 origin",
    hasOrigin: remoteResult.code === 0,
    ahead,
    behind,
    dirtyCount: dirtyPaths.length,
    dirtyPaths: dirtyPaths.slice(0, 20),
  };
}

export async function publishPaths(repoRoot, pathValues, messageValue) {
  const paths = [...new Set(pathValues.map(normalizeGitPath))];
  if (!paths.length) {
    throw new StudioError("没有可发布的文件。", { code: "NO_PUBLISH_PATHS", status: 422 });
  }

  const message = String(messageValue ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (message.length < 3 || message.length > 160) {
    throw new StudioError("提交说明需要 3 到 160 个字符。", {
      code: "INVALID_COMMIT_MESSAGE",
      status: 422,
    });
  }

  const status = await getGitStatus(repoRoot);
  if (!status.hasOrigin) {
    throw new StudioError("仓库没有配置 origin，无法发布。", {
      code: "NO_ORIGIN",
      status: 409,
    });
  }
  if (status.behind > 0) {
    throw new StudioError(`当前分支落后远程 ${status.behind} 个提交，请先拉取再发布。`, {
      code: "BRANCH_BEHIND",
      status: 409,
    });
  }

  await runGit(repoRoot, ["add", "--", ...paths]);
  const diff = await runGit(repoRoot, ["diff", "--cached", "--quiet", "--", ...paths], {
    acceptedCodes: [0, 1],
  });

  if (diff.code === 0) {
    if (status.ahead > 0) {
      const hash = (await runGit(repoRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
      await pushHead(repoRoot, hash);
      return {
        committed: false,
        pushed: true,
        commit: hash,
        message: `没有新的文章变化；已把本地待推送提交 ${hash} 发布到 GitHub。`,
      };
    }
    return {
      committed: false,
      pushed: false,
      commit: null,
      message: "内容与当前提交一致，没有生成新提交。",
    };
  }

  const commit = await runGit(repoRoot, ["commit", "--only", "-m", message, "--", ...paths], {
    acceptedCodes: [0, 1],
  });
  if (commit.code !== 0) {
    throw new StudioError("Git 提交失败。", {
      code: "GIT_COMMIT_FAILED",
      status: 409,
      details: cleanGitOutput(commit),
    });
  }

  const hash = (await runGit(repoRoot, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  const push = await pushHead(repoRoot, hash, { committed: true });

  return {
    committed: true,
    pushed: true,
    commit: hash,
    message: cleanGitOutput(push) || `已推送提交 ${hash}`,
  };
}

async function pushHead(repoRoot, hash, { committed = false } = {}) {
  const push = await runGit(repoRoot, ["push", "origin", "HEAD"], {
    acceptedCodes: [0, 1, 128],
    timeoutMs: 180_000,
  });
  if (push.code !== 0) {
    throw new StudioError(
      committed ? "文章已在本地提交，但推送到 GitHub 失败。" : "推送本地待发布提交失败。",
      {
        code: "GIT_PUSH_FAILED",
        status: 409,
        details: cleanGitOutput(push),
        context: { committed, commit: hash },
      },
    );
  }
  return push;
}

export function runGit(repoRoot, args, { acceptedCodes = [0], timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: repoRoot,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(
        new StudioError("Git 操作超时。", {
          code: "GIT_TIMEOUT",
          status: 504,
          details: `git ${args[0]} 超过 ${Math.round(timeoutMs / 1000)} 秒未完成。`,
        }),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new StudioError("无法启动 Git。", {
          code: "GIT_NOT_AVAILABLE",
          status: 500,
          details: error.message,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = {
        code: Number(code),
        stdout: scrubSecrets(stdout),
        stderr: scrubSecrets(stderr),
      };
      if (!acceptedCodes.includes(result.code)) {
        reject(
          new StudioError(`Git 命令失败：git ${args[0]}`, {
            code: "GIT_COMMAND_FAILED",
            status: 409,
            details: cleanGitOutput(result),
          }),
        );
        return;
      }
      resolve(result);
    });
  });
}

function normalizeGitPath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new StudioError("发布路径无效。", { code: "INVALID_GIT_PATH", status: 422 });
  }
  return normalized;
}

function sanitizeRemote(value) {
  return scrubSecrets(String(value).replace(/^(https?:\/\/)[^/@]+@/i, "$1"));
}

function cleanGitOutput(result) {
  return scrubSecrets([result.stderr, result.stdout].filter(Boolean).join("\n").trim()).slice(0, 12_000);
}

function scrubSecrets(value) {
  return String(value)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]");
}
