/** Exact-lane retry authority from the canonical, versioned WorkState action. */
import crypto from "node:crypto";
import fs from "node:fs";
import { acquireStateLock } from "./state-lock.mjs";
import { validateRuntime } from "./work-state.mjs";

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function hasCompletionGrant(runtime, lane, version = lane.workStateVersion) {
  const work = runtime?.records?.[lane.workStateId];
  if (!work || work.version !== version || work.phase !== "active"
      || !work.authorityBoundary?.allowedActions?.includes("retry_safe")
      || !Number.isInteger(work.retryPolicy?.maxAttempts)
      || lane.retry?.maxAttempts > work.retryPolicy.maxAttempts
      || lane.retry?.attempts > work.retryPolicy.maxAttempts) return false;
  const evidence = runtime.evidence?.[work.evidenceRefs?.at(-1)];
  if (!evidence || evidence.status !== "verified") return false;
  if (!["error", "rejected"].includes(lane.lastCommand?.status)) return false;
  const failureReceipt = runtime.evidence?.[lane.lastCommand?.evidenceRef];
  if (!failureReceipt || !String(failureReceipt.status).startsWith("verified")
      || !work.evidenceRefs.includes(lane.lastCommand.evidenceRef)) return false;
  return Object.values(runtime.actions ?? {}).some((action) => {
    if (action.workStateId !== work.id || action.stateVersion !== version
        || action.class !== "retry_safe" || action.status !== "prepared") return false;
    let grant;
    try { grant = JSON.parse(action.description); } catch { return false; }
    return grant?.schema === "completion-retry-grant/v1"
      && grant.laneId === lane.id && grant.issue === lane.issue
      && grant.repository === lane.repository && grant.headSha === lane.headSha
      && grant.actionDigest === digest(lane.nextAction?.argv);
  });
}

export function withCompletionGrant(file, lane, perform, { validate = validateRuntime } = {}) {
  const release = acquireStateLock(file);
  try {
    const runtime = JSON.parse(fs.readFileSync(file, "utf8"));
    validate(runtime);
    if (!hasCompletionGrant(runtime, lane)) return false;
    return perform();
  } finally { release(); }
}
