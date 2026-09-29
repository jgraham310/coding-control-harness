/** Bind a reviewed merge to the exact clean checkout a live command executes. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;
function git(cwd, ...args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 }).trim(); }

export function verifyRuntimeActivation({ entrypoint, mergedHead, ci, review, firstCheck }) {
  if (!SHA.test(mergedHead ?? "") || !entrypoint || ci?.status !== "passed" || review?.status !== "passed" ||
      !SHA.test(ci?.headSha ?? "") || ci.headSha !== review?.headSha || firstCheck?.status !== "passed" ||
      firstCheck?.headSha !== mergedHead) return { ok: false, reason: "evidence_unbound" };
  try {
    const real = fs.realpathSync(entrypoint);
    if (!fs.statSync(real).isFile()) return { ok: false, reason: "entrypoint_not_file" };
    const root = git(path.dirname(real), "rev-parse", "--show-toplevel");
    if (git(root, "rev-parse", "HEAD") !== mergedHead) return { ok: false, reason: "stale_runtime_head" };
    // The reviewed tree must be byte-for-byte the runtime tree. This also
    // accepts squash merges, whose reviewed candidate is not a parent.
    if (ci.headSha !== mergedHead && git(root, "rev-parse", `${ci.headSha}^{tree}`) !==
        git(root, "rev-parse", `${mergedHead}^{tree}`))
      return { ok: false, reason: "merged_tree_unreviewed" };
    const relative = path.relative(root, real);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." ||
        !git(root, "ls-files", "--", relative))
      return { ok: false, reason: "entrypoint_untracked" };
    if (git(root, "status", "--porcelain", "--untracked-files=normal")) return { ok: false, reason: "dirty_runtime_checkout" };
    return { ok: true, reason: "verified", root, entrypoint: real, headSha: mergedHead };
  } catch { return { ok: false, reason: "runtime_unavailable" }; }
}
