/**
 * Canonical bounded state for durable work.  The state contains only current
 * operational facts; tool output remains in immutable evidence receipts.
 */
import crypto from "node:crypto";

const ACTIONS = new Set(["inspect", "observe", "draft", "internal_update", "retry_safe"]);
const PHASES = new Set(["identified", "active", "waiting", "blocked", "verified", "completed"]);
const NEXT = new Map([
  ["identified", new Set(["active", "blocked"])], ["active", new Set(["waiting", "blocked", "verified", "completed"])],
  ["waiting", new Set(["active", "blocked"])], ["blocked", new Set(["active", "waiting"])],
  ["verified", new Set(["active", "blocked", "completed"])], ["completed", new Set()],
]);
const fail = (message) => { throw new Error(message); };
const copy = (value) => structuredClone(value);
const text = (value, name) => { if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string`); return value; };
const list = (value, name) => { if (!Array.isArray(value)) fail(`${name} must be an array`); return value; };
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");

export function emptyWorkStateRuntime() { return { schema: "work_state/v1", records: {}, evidence: {}, actions: {}, events: [] }; }

export function validateWorkStateRuntime(runtime) {
  if (!runtime || runtime.schema !== "work_state/v1" || !runtime.records || !runtime.evidence || !runtime.actions || !Array.isArray(runtime.events)) fail("invalid WorkState runtime");
  for (const record of Object.values(runtime.records)) validateRecord(record, runtime);
  return true;
}

function validateRecord(record, runtime) {
  for (const key of ["id", "objective", "owner", "phase", "nextAction", "createdAt", "updatedAt"]) text(record?.[key], `WorkState.${key}`);
  if (!Number.isInteger(record.version) || record.version < 1) fail(`WorkState ${record.id} has invalid version`);
  if (!PHASES.has(record.phase)) fail(`WorkState ${record.id} has invalid phase`);
  list(record.acceptanceTests, `WorkState ${record.id}.acceptanceTests`); if (!record.acceptanceTests.length) fail(`WorkState ${record.id} needs acceptance tests`);
  if (!record.authorityBoundary || !Array.isArray(record.authorityBoundary.allowedActions) || !record.authorityBoundary.allowedActions.every((action) => ACTIONS.has(action))) fail(`WorkState ${record.id} has invalid authority boundary`);
  for (const field of ["dependencies", "blockers", "facts", "decisions", "evidenceRefs"]) list(record[field], `WorkState ${record.id}.${field}`);
  for (const id of record.evidenceRefs) if (!runtime.evidence[id]) fail(`WorkState ${record.id} references missing evidence ${id}`);
}

export function recordEvidence(runtime, receipt, at) {
  validateWorkStateRuntime(runtime); const id = text(receipt?.id, "EvidenceReceipt.id");
  const body = { id, source: text(receipt.source, "EvidenceReceipt.source"), artifact: text(receipt.artifact, "EvidenceReceipt.artifact"), status: text(receipt.status, "EvidenceReceipt.status"), excerpts: list(receipt.excerpts ?? [], "EvidenceReceipt.excerpts"), facts: list(receipt.facts ?? [], "EvidenceReceipt.facts") };
  const hash = digest(body); const existing = runtime.evidence[id];
  if (existing) { if (existing.hash !== hash) fail(`Evidence receipt ${id} is immutable`); return { receipt: copy(existing), created: false }; }
  const stored = { ...body, hash, recordedAt: at }; runtime.evidence[id] = stored; runtime.events.push({ at, kind: "evidence_recorded", evidenceId: id, hash }); return { receipt: copy(stored), created: true };
}

export function registerWorkState(runtime, input, at) {
  validateWorkStateRuntime(runtime); const id = text(input?.id, "WorkState.id"); if (runtime.records[id]) fail(`WorkState ${id} already exists`);
  const record = { id, version: 1, objective: text(input.objective, "WorkState.objective"), acceptanceTests: copy(input.acceptanceTests), authorityBoundary: copy(input.authorityBoundary), phase: input.phase ?? "identified", nextAction: text(input.nextAction, "WorkState.nextAction"), owner: text(input.owner, "WorkState.owner"), dependencies: copy(input.dependencies ?? []), blockers: copy(input.blockers ?? []), facts: copy(input.facts ?? []), decisions: copy(input.decisions ?? []), evidenceRefs: copy(input.evidenceRefs ?? []), createdAt: at, updatedAt: at };
  validateRecord(record, runtime); runtime.records[id] = record; runtime.events.push({ at, kind: "work_state_registered", workStateId: id, version: 1 }); return copy(record);
}

export function transitionWorkState(runtime, id, expectedVersion, patch, action, rationale, at) {
  validateWorkStateRuntime(runtime); const record = runtime.records[id]; if (!record) fail(`Unknown WorkState ${id}`); text(rationale, "transition rationale");
  for (const key of Object.keys(patch ?? {})) if (!["phase", "nextAction", "owner", "dependencies", "blockers", "facts", "decisions", "evidenceRefs"].includes(key)) fail(`State patch cannot change ${key}`);
  text(action?.id, "Action.id"); text(action?.idempotencyKey, "Action.idempotencyKey"); text(action?.description, "Action.description"); if (!record.authorityBoundary.allowedActions.includes(action.class)) fail(`Action ${action.class} is outside the WorkState authority boundary`);
  const duplicate = Object.values(runtime.actions).find((entry) => entry.workStateId === id && entry.idempotencyKey === action.idempotencyKey); if (duplicate) return { record: copy(record), action: copy(duplicate), created: false };
  if (record.version !== expectedVersion) fail(`Stale WorkState version for ${id}: expected ${expectedVersion}, current ${record.version}`);
  if (patch.phase && patch.phase !== record.phase && (!PHASES.has(patch.phase) || !NEXT.get(record.phase).has(patch.phase))) fail(`Illegal WorkState transition ${record.phase} -> ${patch.phase}`);
  if (patch.evidenceRefs) for (const evidenceId of patch.evidenceRefs) if (!runtime.evidence[evidenceId]) fail(`State patch references missing evidence ${evidenceId}`);
  const next = { ...record, ...copy(patch), version: record.version + 1, updatedAt: at }; validateRecord(next, runtime);
  const prepared = { ...copy(action), workStateId: id, stateVersion: next.version, status: "prepared", preparedAt: at, completedAt: null, outcomeEvidenceRef: null };
  runtime.records[id] = next; runtime.actions[action.id] = prepared; runtime.events.push({ at, kind: "transition_prepared", workStateId: id, fromVersion: record.version, toVersion: next.version, actionId: action.id, rationale }); return { record: copy(next), action: copy(prepared), created: true };
}

export function completeAction(runtime, actionId, outcome, evidenceId, at) {
  validateWorkStateRuntime(runtime); const action = runtime.actions[actionId]; if (!action) fail(`Unknown action ${actionId}`); if (!["succeeded", "failed", "cancelled"].includes(outcome)) fail("invalid terminal outcome"); if (!runtime.evidence[evidenceId]) fail(`Action completion requires immutable evidence ${evidenceId}`);
  if (action.status !== "prepared") { if (action.status === outcome && action.outcomeEvidenceRef === evidenceId) return copy(action); fail(`Action ${actionId} is already terminal`); }
  Object.assign(action, { status: outcome, completedAt: at, outcomeEvidenceRef: evidenceId }); runtime.events.push({ at, kind: "action_completed", workStateId: action.workStateId, actionId, outcome, evidenceId }); return copy(action);
}

export function workStateContext(runtime, id, latestEvidenceId = null) {
  validateWorkStateRuntime(runtime); const workState = runtime.records[id]; if (!workState) fail(`Unknown WorkState ${id}`); const evidenceId = latestEvidenceId ?? workState.evidenceRefs.at(-1) ?? null; if (evidenceId && !runtime.evidence[evidenceId]) fail(`Unknown evidence ${evidenceId}`);
  return { workState: copy(workState), latestObservation: evidenceId ? copy(runtime.evidence[evidenceId]) : null, pendingActions: Object.values(runtime.actions).filter((entry) => entry.workStateId === id && entry.status === "prepared").map(copy) };
}
