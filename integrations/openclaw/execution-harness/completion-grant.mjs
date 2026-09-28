/** Exact-lane retry authority from the canonical, versioned WorkState action. */
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { acquireStateLock } from "./state-lock.mjs";
import { validateRuntime } from "./work-state.mjs";

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function verifyExactWorktree(lane) {
  if (!lane?.worktree || !/^[0-9a-f]{40}$/i.test(lane.headSha ?? "")) return false;
  try {
    const head = execFileSync("git", ["-C", lane.worktree, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 5000 }).trim();
    const dirty = execFileSync("git", ["-C", lane.worktree, "status", "--porcelain"], { encoding: "utf8", timeout: 5000 }).trim();
    return head === lane.headSha && !dirty;
  } catch { return false; }
}

function matchingCompletionGrant(runtime, lane, version = lane.workStateVersion) {
  const work = runtime?.records?.[lane.workStateId];
  if (!work || work.version !== version || work.phase !== "active"
      || !work.authorityBoundary?.allowedActions?.includes("retry_safe")
      || !Number.isInteger(work.retryPolicy?.maxAttempts)
      || lane.retry?.maxAttempts > work.retryPolicy.maxAttempts
      || lane.retry?.attempts > work.retryPolicy.maxAttempts) return null;
  const evidence = runtime.evidence?.[work.evidenceRefs?.at(-1)];
  if (!evidence || evidence.status !== "verified") return null;
  if (!["error", "rejected"].includes(lane.lastCommand?.status)) return null;
  const failureReceipt = runtime.evidence?.[lane.lastCommand?.evidenceRef];
  if (!failureReceipt || failureReceipt.status !== "verified_command_failure"
      || !work.evidenceRefs.includes(lane.lastCommand.evidenceRef)
      || !failureReceipt.facts?.some((fact) => fact?.schema === "command_failure/v1"
        && fact.laneId === lane.id && fact.issue === lane.issue
        && fact.repository === lane.repository && fact.headSha === lane.headSha
        && fact.commandStatus === lane.lastCommand.status)) return null;
  return Object.values(runtime.actions ?? {}).find((action) => {
    if (action.workStateId !== work.id || action.stateVersion !== version
        || action.class !== "retry_safe" || action.status !== "prepared" || action.dispatchClaim) return null;
    let grant;
    try { grant = JSON.parse(action.description); } catch { return null; }
    return grant?.schema === "completion-retry-grant/v1"
      && grant.laneId === lane.id && grant.issue === lane.issue
      && grant.repository === lane.repository && grant.headSha === lane.headSha
      && grant.failureEvidenceRef === lane.lastCommand.evidenceRef
      && grant.actionDigest === digest(lane.nextAction?.argv);
  }) ?? null;
}

export function hasCompletionGrant(runtime, lane, version = lane.workStateVersion) {
  return !!matchingCompletionGrant(runtime, lane, version);
}

export function recoverUnclaimedReservation(file, lane, restore, { validate = validateRuntime, verifyWorktree = verifyExactWorktree } = {}) {
  const release = acquireStateLock(file);
  try {
    const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(runtime);
    if (!matchingCompletionGrant(runtime, lane) || !verifyWorktree(lane)) return false;
    restore();
    return true;
  } catch { return false; }
  finally { release(); }
}

export function withCompletionGrant(file, lane, reserve, launch, { validate = validateRuntime, verifyWorktree = verifyExactWorktree } = {}) {
  const release = acquireStateLock(file);
  try {
    const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(runtime);
    const action = matchingCompletionGrant(runtime, lane);
    if (!action || !verifyWorktree(lane)) return false;
    reserve();
    action.dispatchClaim = { id: crypto.randomUUID(), laneId: lane.id, headSha: lane.headSha,
      claimedAt: new Date().toISOString(), status: "pending" };
    const temporary = `${file}.${process.pid}.completion-claim.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    const result = launch();
    action.dispatchClaim.status = "launched";
    fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return result;
  } finally { release(); }
}
