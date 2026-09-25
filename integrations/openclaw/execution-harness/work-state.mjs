/**
 * Canonical, bounded execution state for durable agent work.
 *
 * This deliberately stores neither model reasoning nor raw tool output. Raw
 * artifacts are immutable evidence receipts; an agent gets the current state
 * and an explicitly selected receipt instead of an ever-growing transcript.
 */
import crypto from "node:crypto";

const ACTION_CLASSES = new Set(["inspect", "observe", "draft", "internal_update", "retry_safe"]);
const TERMINAL_ACTIONS = new Set(["succeeded", "failed", "cancelled"]);
const PHASES = new Set(["identified", "active", "waiting", "blocked", "verified", "completed"]);
const TRANSITIONS = new Map([
  ["identified", new Set(["active", "blocked"])],
  ["active", new Set(["waiting", "blocked", "verified", "completed"])],
  ["waiting", new Set(["active", "blocked"])],
  ["blocked", new Set(["active", "waiting"])],
  ["verified", new Set(["active", "completed", "blocked"])],
  ["completed", new Set()],
]);

function fail(message) { throw new Error(message); }
function clone(value) { return structuredClone(value); }
function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string.`);
  return value;
}
function iso(value, name) {
  if (value !== null && value !== undefined && !Number.isFinite(Date.parse(value))) fail(`${name} must be an ISO timestamp.`);
  return value ?? null;
}
function array(value, name) {
  if (!Array.isArray(value)) fail(`${name} must be an array.`);
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export function emptyRuntime() {
  return { schemaVersion: 1, records: {}, evidence: {}, actions: {}, events: [] };
}

export function validateRuntime(runtime) {
  if (!runtime || runtime.schemaVersion !== 1 || typeof runtime.records !== "object" || typeof runtime.evidence !== "object" || typeof runtime.actions !== "object" || !Array.isArray(runtime.events)) fail("Invalid WorkState runtime document.");
  for (const record of Object.values(runtime.records)) validateRecord(record, runtime);
  return true;
}

function validateRecord(record, runtime) {
  for (const key of ["id", "objective", "phase", "nextAction", "owner", "createdAt", "updatedAt"]) requiredString(record?.[key], `WorkState.${key}`);
  if (!record.authorityBoundary || typeof record.authorityBoundary !== "object" || !Array.isArray(record.authorityBoundary.allowedActions) || !record.authorityBoundary.allowedActions.every((action) => ACTION_CLASSES.has(action))) fail(`WorkState ${record.id} has invalid authority boundary.`);
  if (!Number.isInteger(record.version) || record.version < 1) fail(`WorkState ${record.id} has invalid version.`);
  if (!PHASES.has(record.phase)) fail(`WorkState ${record.id} has invalid phase.`);
  array(record.acceptanceTests, `WorkState ${record.id}.acceptanceTests`);
  if (!record.acceptanceTests.length || !record.acceptanceTests.every((item) => typeof item === "string" && item.trim())) fail(`WorkState ${record.id} needs named acceptance tests.`);
  for (const field of ["dependencies", "blockers", "facts", "decisions", "evidenceRefs"]) array(record[field], `WorkState ${record.id}.${field}`);
  iso(record.deadline, `WorkState ${record.id}.deadline`);
  iso(record.lastVerifiedAt, `WorkState ${record.id}.lastVerifiedAt`);
  if (record.retryPolicy !== null && record.retryPolicy !== undefined && typeof record.retryPolicy !== "object") fail(`WorkState ${record.id}.retryPolicy must be an object or null.`);
  for (const evidenceRef of record.evidenceRefs) if (!runtime.evidence[evidenceRef]) fail(`WorkState ${record.id} references missing evidence ${evidenceRef}.`);
}

export function registerWorkState(runtime, input, at) {
  validateRuntime(runtime);
  const id = requiredString(input?.id, "WorkState.id");
  if (runtime.records[id]) fail(`WorkState ${id} already exists.`);
  const record = {
    id,
    version: 1,
    status: input.status ?? "active",
    objective: requiredString(input.objective, "WorkState.objective"),
    acceptanceTests: clone(input.acceptanceTests),
    authorityBoundary: clone(input.authorityBoundary),
    phase: input.phase ?? "identified",
    nextAction: requiredString(input.nextAction, "WorkState.nextAction"),
    owner: requiredString(input.owner, "WorkState.owner"),
    dependencies: clone(input.dependencies ?? []),
    blockers: clone(input.blockers ?? []),
    facts: clone(input.facts ?? []),
    decisions: clone(input.decisions ?? []),
    evidenceRefs: clone(input.evidenceRefs ?? []),
    retryPolicy: input.retryPolicy ?? null,
    deadline: input.deadline ?? null,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    createdAt: at,
    updatedAt: at,
  };
  validateRecord(record, runtime);
  runtime.records[id] = record;
  runtime.events.push({ at, kind: "work_state_registered", workStateId: id, version: record.version, evidenceRefs: record.evidenceRefs });
  return clone(record);
}

export function recordEvidence(runtime, receipt, at) {
  validateRuntime(runtime);
  const id = requiredString(receipt?.id, "EvidenceReceipt.id");
  const canonicalReceipt = {
    id,
    source: requiredString(receipt.source, "EvidenceReceipt.source"),
    artifact: requiredString(receipt.artifact, "EvidenceReceipt.artifact"),
    status: requiredString(receipt.status, "EvidenceReceipt.status"),
    excerpts: array(receipt.excerpts ?? [], "EvidenceReceipt.excerpts"),
    facts: array(receipt.facts ?? [], "EvidenceReceipt.facts"),
    recordedAt: at,
  };
  const hash = fingerprint({ ...canonicalReceipt, recordedAt: undefined });
  const existing = runtime.evidence[id];
  if (existing) {
    if (existing.hash !== hash) fail(`Evidence receipt ${id} is immutable and conflicts with existing content.`);
    return { receipt: clone(existing), created: false };
  }
  const stored = { ...canonicalReceipt, hash };
  runtime.evidence[id] = stored;
  runtime.events.push({ at, kind: "evidence_recorded", evidenceId: id, hash });
  return { receipt: clone(stored), created: true };
}

function validatePatch(record, patch, runtime) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("State patch must be an object.");
  const allowed = new Set(["status", "phase", "nextAction", "owner", "dependencies", "blockers", "facts", "decisions", "evidenceRefs", "retryPolicy", "deadline", "lastVerifiedAt"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`State patch cannot change ${key}.`);
  if (patch.phase !== undefined) {
    if (!PHASES.has(patch.phase)) fail(`Invalid target phase ${patch.phase}.`);
    if (patch.phase !== record.phase && !TRANSITIONS.get(record.phase).has(patch.phase)) fail(`Illegal WorkState transition ${record.phase} -> ${patch.phase}.`);
  }
  if (patch.nextAction !== undefined) requiredString(patch.nextAction, "State patch nextAction");
  if (patch.owner !== undefined) requiredString(patch.owner, "State patch owner");
  for (const field of ["dependencies", "blockers", "facts", "decisions", "evidenceRefs"]) if (patch[field] !== undefined) array(patch[field], `State patch ${field}`);
  if (patch.evidenceRefs) for (const evidenceRef of patch.evidenceRefs) if (!runtime.evidence[evidenceRef]) fail(`State patch references missing evidence ${evidenceRef}.`);
  if (patch.deadline !== undefined) iso(patch.deadline, "State patch deadline");
  if (patch.lastVerifiedAt !== undefined) iso(patch.lastVerifiedAt, "State patch lastVerifiedAt");
}

function validateAction(record, action) {
  for (const key of ["id", "idempotencyKey", "class", "description"]) requiredString(action?.[key], `Action.${key}`);
  if (!ACTION_CLASSES.has(action.class)) fail(`Unsupported action class ${action.class}.`);
  if (Array.isArray(record.authorityBoundary.allowedActions) && !record.authorityBoundary.allowedActions.includes(action.class)) fail(`Action ${action.class} is outside the WorkState authority boundary.`);
}

export function transitionWorkState(runtime, id, expectedVersion, patch, action, rationale, at) {
  validateRuntime(runtime);
  const record = runtime.records[id];
  if (!record) fail(`Unknown WorkState ${id}.`);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) fail("expectedVersion must be a positive integer.");
  validateAction(record, action);
  requiredString(rationale, "State transition rationale");
  const duplicate = Object.values(runtime.actions).find((item) => item.workStateId === id && item.idempotencyKey === action.idempotencyKey);
  if (duplicate) return { record: clone(record), action: clone(duplicate), created: false };
  if (runtime.actions[action.id]) fail(`Action ID ${action.id} is already in use.`);
  if (record.version !== expectedVersion) fail(`Stale WorkState version for ${id}: expected ${expectedVersion}, current ${record.version}.`);
  validatePatch(record, patch, runtime);
  const next = { ...record, ...clone(patch), version: record.version + 1, updatedAt: at };
  validateRecord(next, runtime);
  const actionRecord = { ...clone(action), workStateId: id, stateVersion: next.version, status: "prepared", preparedAt: at, completedAt: null, outcomeEvidenceRef: null };
  runtime.records[id] = next;
  runtime.actions[action.id] = actionRecord;
  runtime.events.push({ at, kind: "state_transition_prepared", workStateId: id, fromVersion: record.version, toVersion: next.version, actionId: action.id, rationale, evidenceRefs: next.evidenceRefs });
  return { record: clone(next), action: clone(actionRecord), created: true };
}

export function completeAction(runtime, actionId, outcome, evidenceRef, at) {
  validateRuntime(runtime);
  const action = runtime.actions[actionId];
  if (!action) fail(`Unknown action ${actionId}.`);
  if (!TERMINAL_ACTIONS.has(outcome)) fail(`Unsupported terminal action outcome ${outcome}.`);
  if (!runtime.evidence[evidenceRef]) fail(`Action completion requires immutable evidence ${evidenceRef}.`);
  if (action.status !== "prepared") {
    if (action.status === outcome && action.outcomeEvidenceRef === evidenceRef) return clone(action);
    fail(`Action ${actionId} is already terminal.`);
  }
  action.status = outcome;
  action.completedAt = at;
  action.outcomeEvidenceRef = evidenceRef;
  runtime.events.push({ at, kind: "action_completed", workStateId: action.workStateId, actionId, outcome, evidenceRef });
  return clone(action);
}

export function workStateContext(runtime, id, latestEvidenceId = null) {
  validateRuntime(runtime);
  const record = runtime.records[id];
  if (!record) fail(`Unknown WorkState ${id}.`);
  if (latestEvidenceId !== null && !runtime.evidence[latestEvidenceId]) fail(`Unknown evidence ${latestEvidenceId}.`);
  const evidenceId = latestEvidenceId ?? record.evidenceRefs.at(-1) ?? null;
  const latestObservation = evidenceId ? runtime.evidence[evidenceId] : null;
  return {
    // Compatibility fields keep existing recovery adapters deterministic while
    // the bounded state remains the only operational model context.
    goal: record.objective,
    currentState: { phase: record.phase, status: record.status, version: record.version, blockers: clone(record.blockers) },
    validation: clone(record.acceptanceTests),
    nextAction: record.nextAction,
    blocker: record.blockers.at(0) ?? null,
    workState: clone(record),
    latestObservation: latestObservation ? clone(latestObservation) : null,
    pendingActions: Object.values(runtime.actions).filter((item) => item.workStateId === id && item.status === "prepared").map(clone),
  };
}
