import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyRuntimeActivation } from "../src/runtime-activation-gate.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-activation-eval-"));
const repo = path.join(temp, "repo");
const old = path.join(temp, "old");
fs.mkdirSync(repo);
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
try {
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Eval"); git(repo, "config", "user.email", "eval@example.invalid");
  fs.writeFileSync(path.join(repo, "watch.mjs"), "console.log('v1')\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "old-runtime");
  const unrelated = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "--detach", old, unrelated);
  git(repo, "checkout", "-qb", "candidate");
  fs.writeFileSync(path.join(repo, "watch.mjs"), "console.log('v2')\n");
  git(repo, "commit", "-qam", "candidate-runtime");
  const candidate = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "--no-ff", "-qm", "merge-candidate", "candidate");
  const mergedHead = git(repo, "rev-parse", "HEAD");
  const evidence = { entrypoint: path.join(repo, "watch.mjs"), mergedHead,
    ci: { status: "passed", headSha: candidate }, review: { status: "passed", headSha: candidate },
    firstCheck: { status: "passed", headSha: mergedHead } };
  assert.equal(verifyRuntimeActivation(evidence).ok, true);
  const link = path.join(temp, "watch-link.mjs");
  fs.symlinkSync(path.join(old, "watch.mjs"), link);
  assert.equal(verifyRuntimeActivation({ ...evidence, entrypoint: link }).reason, "stale_runtime_head");
  fs.appendFileSync(evidence.entrypoint, "// dirty\n");
  assert.equal(verifyRuntimeActivation(evidence).reason, "dirty_runtime_checkout");
  git(repo, "checkout", "--", "watch.mjs");
  assert.equal(verifyRuntimeActivation({ ...evidence, review: { status: "missing", headSha: candidate } }).reason, "evidence_unbound");
  assert.equal(verifyRuntimeActivation({ ...evidence, ci: { status: "passed", headSha: mergedHead } }).reason, "evidence_unbound");
  assert.equal(verifyRuntimeActivation({ ...evidence, ci: { status: "passed", headSha: unrelated },
    review: { status: "passed", headSha: unrelated } }).reason, "candidate_not_merged");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored-watch.mjs\n");
  git(repo, "add", ".gitignore"); git(repo, "commit", "-qm", "ignore-fixture");
  const ignoreHead = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "ignored-watch.mjs"), "console.log('unreviewed')\n");
  assert.equal(verifyRuntimeActivation({ ...evidence, entrypoint: path.join(repo, "ignored-watch.mjs"),
    mergedHead: ignoreHead, ci: { status: "passed", headSha: ignoreHead },
    review: { status: "passed", headSha: ignoreHead }, firstCheck: { status: "passed", headSha: ignoreHead } }).reason,
  "entrypoint_untracked");
  assert.equal(verifyRuntimeActivation({ ...evidence, firstCheck: { status: "failed", headSha: mergedHead } }).reason, "evidence_unbound");
  assert.equal(verifyRuntimeActivation({ ...evidence, entrypoint: path.join(temp, "missing") }).reason, "runtime_unavailable");
  git(repo, "checkout", "-qb", "altered", unrelated);
  git(repo, "merge", "--no-ff", "-qm", "merge-candidate", "candidate");
  fs.writeFileSync(path.join(repo, "watch.mjs"), "console.log('unreviewed merge result')\n");
  git(repo, "add", "watch.mjs");
  git(repo, "commit", "--amend", "-qm", "unreviewed-runtime");
  const unreviewedHead = git(repo, "rev-parse", "HEAD");
  assert.equal(verifyRuntimeActivation({ ...evidence, mergedHead: unreviewedHead,
    firstCheck: { status: "passed", headSha: unreviewedHead } }).reason, "merged_tree_unreviewed");
  console.log("merge-to-runtime eval: clean bound checkout passes; stale link, dirty checkout, and bad evidence hold");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
