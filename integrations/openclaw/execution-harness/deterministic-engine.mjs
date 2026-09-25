#!/usr/bin/env node
/**
 * Model-free primitives shared by every adapter. This module deliberately
 * contains no network or agent calls: callers supply evidence snapshots and
 * execute only the returned, policy-classified action.
 */
import crypto from "node:crypto";

const ACTION_CLASSES = new Set(["observe", "draft", "internal_update", "jason_gated"]);
const TERMINAL_ACTIONS = new Set(["succeeded", "failed", "cancelled"]);
const REVIEW_TRIGGERS = new Set(["security_sensitive", "production_impacting", "disputed_change"]);

function fail(message) { throw new Error(message); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function validateManifest(manifest) {
  for (const key of ["id", "parentGoal", "successPredicate", "deadline", "cadence", "sources", "authority", "escalations", "executionContract"]) {
    if (manifest?.[key] === undefined || manifest[key] === null || manifest[key] === "") fail(`Manifest missing ${key}.`);
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) fail("Manifest needs at least one source of truth.");
  if (!Array.isArray(manifest.authority?.allowed) || !Array.isArray(manifest.authority?.jasonGated)) fail("Manifest authority needs allowed and jasonGated arrays.");
  if (!Array.isArray(manifest.escalations) || manifest.escalations.length === 0) fail("Manifest needs escalation categories.");
  for (const action of manifest.authority.allowed) if (!ACTION_CLASSES.has(action)) fail(`Unknown allowed action class: ${action}.`);
  if (manifest.authority.allowed.includes("jason_gated")) fail("Jason-gated actions cannot be autonomous.");
  validateExecutionContract(manifest.executionContract);
  if (manifest.independentReview !== undefined) validateIndependentReview(manifest.independentReview);
  return true;
}

// A compact, machine-valid version of the goal-loop contract. The controller
// can hand this to an execution lane without reinterpreting narrative plans.
export function validateExecutionContract(contract) {
  for (const key of ["objective", "constraints", "validation", "stopCondition", "checkpointCadence"]) {
    if (contract?.[key] === undefined || contract[key] === null || contract[key] === "") fail(`Execution contract missing ${key}.`);
  }
  if (!Array.isArray(contract.constraints) || contract.constraints.length === 0 || !contract.constraints.every((item) => typeof item === "string" && item.trim())) fail("Execution contract constraints must be non-empty strings.");
  if (!Array.isArray(contract.validation) || contract.validation.length === 0 || !contract.validation.every((item) => typeof item === "string" && item.trim())) fail("Execution contract validation must be non-empty commands or checks.");
  if (typeof contract.objective !== "string" || typeof contract.stopCondition !== "string" || typeof contract.checkpointCadence !== "string") fail("Execution contract fields must be strings.");
  return true;
}

export function validateIndependentReview(policy) {
  if (typeof policy?.enabled !== "boolean") fail("Independent-review policy needs enabled.");
  if (!Array.isArray(policy.triggers) || !policy.triggers.every((item) => REVIEW_TRIGGERS.has(item))) fail("Independent-review policy has an unknown trigger.");
  return true;
}
export function queueAction(queue, action) {
  for (const key of ["id", "idempotencyKey", "class", "nextAttemptAt"]) if (!action?.[key]) fail(`Action missing ${key}.`);
  if (!ACTION_CLASSES.has(action.class)) fail(`Unknown action class: ${action.class}.`);
  const existing = queue.find((item) => item.idempotencyKey === action.idempotencyKey && !TERMINAL_ACTIONS.has(item.status));
  if (existing) return { action: existing, created: false };
  const record = { status: "queued", dependencies: [], attempts: 0, maxAttempts: 3, ...action };
  queue.push(record);
  return { action: record, created: true };
}
export function nextAction(queue, now) {
  const at = Date.parse(now);
  const byId = new Map(queue.map((item) => [item.id, item]));
  return queue
    .filter((item) => item.status === "queued" && Date.parse(item.nextAttemptAt) <= at)
    .filter((item) => item.dependencies.every((id) => byId.get(id)?.status === "succeeded"))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id))[0] ?? null;
}
export function finishAttempt(action, outcome, now, retryDelayMs = 0) {
  if (!["succeeded", "retryable_failure", "failed"].includes(outcome)) fail(`Unknown outcome: ${outcome}.`);
  action.attempts += 1;
  action.lastAttemptAt = now;
  if (outcome === "succeeded") action.status = "succeeded";
  else if (outcome === "failed" || action.attempts >= action.maxAttempts) action.status = "failed";
  else { action.status = "queued"; action.nextAttemptAt = new Date(Date.parse(now) + retryDelayMs).toISOString(); }
  return action;
}
export function observeSnapshot(store, source, snapshot, at) {
  const hash = fingerprint(snapshot);
  const prior = store[source];
  store[source] = { hash, observedAt: at, snapshot };
  return { changed: prior?.hash !== hash, hash, previousHash: prior?.hash ?? null };
}
export function classifyPane(text, exists = true) {
  if (!exists) return { kind: "missing_session", modelRequired: false, action: "recreate_or_attach_verified_lane" };
  const body = String(text ?? "");
  // A local Codex OAuth refresh failure is a recoverable workstation session
  // fault, not a Jason-only decision. The controller must launch the normal
  // browser login flow and verify a real Codex request before escalating. This
  // precedes the generic prompt/error cases because the CLI itself may word the
  // repair as “Please log out and sign in again.”
  if (/invalid refresh token|access token could not be refreshed|provided authentication token is expired|token_expired/i.test(body)) {
    return { kind: "recoverable_local_codex_auth", modelRequired: false, action: "launch_local_codex_reauth_then_verify" };
  }
  if (/needs your approval|approve|permission required|your call|only (?:thing )?blocking|jason-only|human decision/i.test(body)) return { kind: "jason_or_permission_prompt", modelRequired: false, action: "escalate_or_apply_preapproved_authority" };
  if (/❯|^>\s/m.test(body) && /merge|continue|run tests|commit|push|open pr/i.test(body)) return { kind: "routine_prompt", modelRequired: false, action: "send_recorded_next_action" };
  if (/working|thinking|crunched|sautéed|running tests|building/i.test(body) && !/❯|^>\s/m.test(body)) return { kind: "active", modelRequired: false, action: "observe_only" };
  if (/error|failed|traceback|exception/i.test(body)) return { kind: "failure_evidence", modelRequired: true, action: "bounded_diagnosis" };
  return { kind: "unknown", modelRequired: true, action: "bounded_classification" };
}

// This is a policy classifier, not a reviewer invocation. It preserves the
// expensive independent-review model call for the few changes that warrant it.
export function independentReviewRequired(policy, riskTags = []) {
  if (!policy?.enabled) return false;
  validateIndependentReview(policy);
  return riskTags.some((tag) => policy.triggers.includes(tag));
}

// A scheduler is healthy only after a completed, bounded, successful run. A
// queued cron record or a started run is deliberately not counted as proof.
export function verifyScheduledRun(run, now) {
  for (const key of ["scheduledAt", "startedAt", "completedAt", "exitCode", "maxStartDelayMs", "maxRuntimeMs"]) {
    if (run?.[key] === undefined || run[key] === null) fail(`Scheduled run missing ${key}.`);
  }
  const scheduled = Date.parse(run.scheduledAt);
  const started = Date.parse(run.startedAt);
  const completed = Date.parse(run.completedAt);
  const observed = Date.parse(now);
  if (![scheduled, started, completed, observed].every(Number.isFinite)) fail("Scheduled run timestamps must be valid ISO dates.");
  const startDelayMs = started - scheduled;
  const runtimeMs = completed - started;
  const stale = observed - scheduled > run.maxStartDelayMs + run.maxRuntimeMs;
  const healthy = run.exitCode === 0 && startDelayMs >= 0 && startDelayMs <= run.maxStartDelayMs && runtimeMs >= 0 && runtimeMs <= run.maxRuntimeMs && !stale;
  return { healthy, startDelayMs, runtimeMs, reason: healthy ? "completed_within_bounds" : run.exitCode !== 0 ? "nonzero_exit" : startDelayMs > run.maxStartDelayMs ? "late_start" : runtimeMs > run.maxRuntimeMs ? "runtime_exceeded" : stale ? "overdue" : "invalid_timing" };
}

// State-only handoff data. Formatting/presentation layers may render this,
// but no model is needed to transfer the facts a replacement lane requires.
export function handoffRecord(lane) {
  for (const key of ["id", "title", "phase", "successPredicate", "nextAction", "lastEvidence"]) if (!lane?.[key]) fail(`Lane handoff missing ${key}.`);
  return {
    title: lane.title,
    goal: lane.executionContract?.objective ?? lane.successPredicate,
    currentState: { phase: lane.phase, active: Boolean(lane.active), evidence: lane.lastEvidence },
    constraints: lane.executionContract?.constraints ?? [],
    validation: lane.executionContract?.validation ?? [],
    stopCondition: lane.executionContract?.stopCondition ?? lane.successPredicate,
    nextAction: lane.nextAction,
    blocker: lane.blocker ?? null,
    pointers: [lane.repository, lane.branch, lane.worktree, lane.pullRequest].filter(Boolean)
  };
}
export function briefing(records, now) {
  const at = Date.parse(now);
  const decisions = records.filter((item) => item.requiresJason);
  const offTrack = records.filter((item) => item.status === "blocked" || (item.deadline && Date.parse(item.deadline) < at && item.status !== "achieved"));
  const upcoming = records.filter((item) => item.deadline && Date.parse(item.deadline) >= at && Date.parse(item.deadline) - at <= 7 * 86400000);
  return { generatedAt: now, needsAttention: decisions, offTrack, upcoming };
}
