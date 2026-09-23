/**
 * Deterministic completion controller for a single durable coding lane.
 *
 * This is deliberately not an agent. It consumes a bounded observation of a
 * named lane and emits one safe next action. The caller is responsible for
 * executing the returned argv through tmux and recording the receipt.
 */
import crypto from "node:crypto";

export const COMPLETION_CONTROLLER_SCHEMA = "completion_controller/v1";
const ACTIVE = new Set(["executing", "awaiting_ci", "awaiting_review"]);
const TERMINAL = new Set(["completed", "blocked", "failed"]);
const RECOVERABLE_FAILURES = new Set(["idle_prompt", "command_rejected", "process_exited", "lease_expired"]);

const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value) => typeof value === "string" ? value.trim() : "";
const isIso = (value) => Number.isFinite(Date.parse(value));

export function validateLane(lane) {
  const errors = [];
  if (!lane || typeof lane !== "object") return { valid: false, errors: ["lane must be an object"] };
  for (const key of ["id", "owner", "sessionName", "worktree", "completionPredicate", "deadlineAt"]) {
    if (!text(lane[key])) errors.push(`${key} is required`);
  }
  if (!isIso(lane.deadlineAt)) errors.push("deadlineAt must be ISO-8601");
  if (!Array.isArray(lane.nextAction?.argv) || lane.nextAction.argv.length < 2 || lane.nextAction.argv.some((part) => !text(part))) {
    errors.push("nextAction.argv must be a non-empty executable argument array");
  }
  if (!Number.isInteger(lane.retry?.maxAttempts) || lane.retry.maxAttempts < 0) errors.push("retry.maxAttempts must be a non-negative integer");
  if (!Number.isInteger(lane.retry?.attempts) || lane.retry.attempts < 0) errors.push("retry.attempts must be a non-negative integer");
  return { valid: errors.length === 0, errors };
}

export function classifyObservation(observation = {}) {
  if (observation.completedEvidence === true) return "completed";
  if (observation.blockedReason) return "blocked";
  if (observation.pane === "executing") return "executing";
  if (observation.pane === "waiting_ci") return "awaiting_ci";
  if (observation.pane === "waiting_review") return "awaiting_review";
  if (observation.pane === "idle_prompt") return "idle_prompt";
  if (observation.pane === "exited") return "process_exited";
  if (observation.lastCommand?.status === "rejected") return "command_rejected";
  return "unknown";
}

export function reconcileLane(lane, observation, { now = new Date().toISOString() } = {}) {
  const validation = validateLane(lane);
  if (!validation.valid) return { state: "blocked", action: "hold", reason: "invalid_lane_contract", errors: validation.errors };
  if (TERMINAL.has(lane.state)) return { state: lane.state, action: "none", reason: "terminal_lane" };
  if (Date.parse(lane.deadlineAt) <= Date.parse(now)) return { state: "blocked", action: "hold", reason: "deadline_exceeded" };
  const observed = classifyObservation(observation);
  if (observed === "completed") return { state: "completed", action: "verify_completion", reason: "completion_evidence_observed" };
  if (observed === "blocked") return { state: "blocked", action: "hold", reason: text(observation.blockedReason) };
  if (ACTIVE.has(observed)) return { state: observed, action: "heartbeat", reason: "lane_active" };
  if (RECOVERABLE_FAILURES.has(observed)) {
    if (lane.retry.attempts >= lane.retry.maxAttempts) return { state: "blocked", action: "hold", reason: "retry_budget_exhausted", observed };
    return {
      state: "recovering", action: "redispatch_registered_action", reason: observed,
      observed, attempt: lane.retry.attempts + 1,
      argv: [...lane.nextAction.argv], actionDigest: digest(lane.nextAction.argv),
    };
  }
  return { state: "blocked", action: "hold", reason: "unclassifiable_lane_state", observed };
}

export function applyDecision(lane, decision, { now = new Date().toISOString() } = {}) {
  if (!decision || !text(decision.action)) throw new Error("decision.action is required");
  const next = structuredClone(lane);
  next.updatedAt = now;
  next.history ||= [];
  next.history.push({ at: now, state: decision.state, action: decision.action, reason: decision.reason });
  if (decision.action === "redispatch_registered_action") {
    next.state = "executing";
    next.retry.attempts += 1;
    next.lastDispatch = { at: now, argvDigest: decision.actionDigest, reason: decision.reason };
  } else if (decision.action === "heartbeat") {
    next.state = decision.state;
    next.lastHeartbeatAt = now;
  } else if (decision.action === "verify_completion") {
    // The controller emits this action only after its registered completion
    // check has supplied terminal evidence. There is no intermediate prose
    // state that another scheduler must remember to advance.
    next.state = "completed";
    next.completedAt = now;
  } else if (decision.action === "hold") {
    next.state = "blocked";
    next.blockedReason = decision.reason;
  }
  return next;
}

export function completionReceipt(lane, observation, decision, { now = new Date().toISOString() } = {}) {
  return {
    schema: COMPLETION_CONTROLLER_SCHEMA,
    observedAt: now,
    laneId: lane.id,
    sessionName: lane.sessionName,
    worktree: lane.worktree,
    state: decision.state,
    action: decision.action,
    reason: decision.reason,
    observationDigest: digest(observation),
    actionDigest: decision.actionDigest ?? null,
    retryAttempt: decision.attempt ?? lane.retry?.attempts ?? 0,
  };
}
