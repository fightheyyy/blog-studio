import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getGitStatus, publishPaths } from "../lib/git.mjs";

test("publishPaths commits and pushes only the requested article paths", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "blog-studio-git-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repo = path.join(sandbox, "repo");
  const remote = path.join(sandbox, "remote.git");
  await mkdir(path.join(repo, "posts"), { recursive: true });
  await writeFile(path.join(repo, "index.html"), "initial index\n");
  await writeFile(path.join(repo, "posts", "note.html"), "initial note\n");

  git(sandbox, ["init", "--bare", remote]);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Studio Test"]);
  git(repo, ["config", "user.email", "studio@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);

  await writeFile(path.join(repo, "index.html"), "updated index\n");
  await writeFile(path.join(repo, "posts", "note.html"), "updated note\n");
  await writeFile(path.join(repo, "unrelated.txt"), "do not include\n");
  git(repo, ["add", "unrelated.txt"]);

  const result = await publishPaths(repo, ["index.html", "posts/note.html"], "publish: scoped note");
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.match(result.commit, /^[0-9a-f]+$/);
  assert.equal(git(repo, ["show", "HEAD:index.html"]), "updated index");
  assert.equal(git(repo, ["show", "HEAD:posts/note.html"]), "updated note");
  assert.throws(() => git(repo, ["show", "HEAD:unrelated.txt"]));
  assert.equal(git(repo, ["diff", "--cached", "--name-only"]), "unrelated.txt");
  assert.equal(git(sandbox, [`--git-dir=${remote}`, "rev-parse", "refs/heads/main"]), git(repo, ["rev-parse", "HEAD"]));

  const status = await getGitStatus(repo);
  assert.equal(status.branch, "main");
  assert.equal(status.ahead, 0);
  assert.equal(status.behind, 0);
  assert.ok(status.dirtyPaths.some((line) => line.includes("unrelated.txt")));
});

test("publishPaths does not create or push an empty commit", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "blog-studio-git-empty-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repo = path.join(sandbox, "repo");
  const remote = path.join(sandbox, "remote.git");
  await mkdir(path.join(repo, "posts"), { recursive: true });
  await writeFile(path.join(repo, "index.html"), "same\n");
  await writeFile(path.join(repo, "posts", "note.html"), "same\n");
  git(sandbox, ["init", "--bare", remote]);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Studio Test"]);
  git(repo, ["config", "user.email", "studio@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const before = git(repo, ["rev-parse", "HEAD"]);

  const result = await publishPaths(repo, ["index.html", "posts/note.html"], "publish: no changes");
  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), before);
});

test("publishPaths retries an existing ahead commit when article files are unchanged", async (t) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "blog-studio-git-retry-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const repo = path.join(sandbox, "repo");
  const remote = path.join(sandbox, "remote.git");
  await mkdir(path.join(repo, "posts"), { recursive: true });
  await writeFile(path.join(repo, "index.html"), "same\n");
  await writeFile(path.join(repo, "posts", "note.html"), "same\n");
  git(sandbox, ["init", "--bare", remote]);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Studio Test"]);
  git(repo, ["config", "user.email", "studio@example.test"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "already-committed.txt"), "waiting to push\n");
  git(repo, ["add", "already-committed.txt"]);
  git(repo, ["commit", "-m", "local pending commit"]);

  const result = await publishPaths(repo, ["index.html", "posts/note.html"], "publish: retry push");
  assert.equal(result.committed, false);
  assert.equal(result.pushed, true);
  assert.equal(git(sandbox, [`--git-dir=${remote}`, "rev-parse", "refs/heads/main"]), git(repo, ["rev-parse", "HEAD"]));
});

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}
