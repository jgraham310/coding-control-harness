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
  const candidate = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "--detach", old, candidate);
  fs.writeFileSync(path.join(repo, "watch.mjs"), "console.log('v2')\n");
  git(repo, "commit", "-qam", "merged-runtime");
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
  assert.equal(verifyRuntimeActivation({ ...evidence, firstCheck: { status: "failed", headSha: mergedHead } }).reason, "evidence_unbound");
  assert.equal(verifyRuntimeActivation({ ...evidence, entrypoint: path.join(temp, "missing") }).reason, "runtime_unavailable");
  console.log("merge-to-runtime eval: clean bound checkout passes; stale link, dirty checkout, and bad evidence hold");
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
