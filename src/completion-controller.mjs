/**
 * Deterministic completion controller for a single durable coding lane.
 *
 * This is deliberately not an agent. It consumes a bounded observation of a
 * named lane and emits one safe next action. The caller is responsible for
 * executing the returned argv through tmux and recording the receipt.
 */
import crypto from "node:crypto";
import { isAuthenticatedReviewRegistration } from "./review-registration.mjs";

export const COMPLETION_CONTROLLER_SCHEMA = "completion_controller/v1";
const ACTIVE = new Set(["executing", "awaiting_ci", "awaiting_review"]);
const TERMINAL = new Set(["completed", "blocked", "failed"]);
const RECOVERABLE_FAILURES = new Set(["command_rejected", "runtime_error", "lease_expired"]);

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
  // Failure evidence outranks an aggregate completion flag and pane label.
  if (observation.blockedReason) return "blocked";
  if (text(observation.laneError)) return "lane_error";
  if (observation.lastCommand?.status === "rejected") return "command_rejected";
  if (observation.lastCommand?.status === "error" || observation.error) return "runtime_error";
  if (observation.pane === "exited") return "process_exited";
  if (observation.completedEvidence === true) return "completed";
  if (observation.pane === "idle_prompt") return "idle_prompt";
  if (observation.pane === "executing") return "executing";
  if (observation.pane === "waiting_ci") return "awaiting_ci";
  if (observation.pane === "waiting_review") return "awaiting_review";
  return "unknown";
}

// Match only explicit error lines; ordinary prose mentioning a prior failure is not a gate.
export function detectPaneError(pane = "") {
  return String(pane).split(/\r?\n/).map((part) => part.trim())
    .find((part) => /^(?:Error:\s+Cannot find module\b|(?:Error\s+)?\[?MODULE_NOT_FOUND\]?\b|hook_module_not_found\b)/i.test(part)) || "";
}

export function reconcileLane(lane, observation, { now = new Date().toISOString(), reviewRegistration = null } = {}) {
  const validation = validateLane(lane);
  if (!validation.valid) return { state: "blocked", action: "hold", reason: "invalid_lane_contract", errors: validation.errors };
  if (TERMINAL.has(lane.state)) return { state: lane.state, action: "none", reason: "terminal_lane" };
  if (Date.parse(lane.deadlineAt) <= Date.parse(now)) return { state: "blocked", action: "hold", reason: "deadline_exceeded" };
  const observed = classifyObservation(observation);
  if (observed === "lane_error" || (observed === "command_rejected" && observation.pane === "executing" && !lane.reviewRequired)) {
    const reason = observed === "lane_error" ? text(observation.laneError) : "command_rejected";
    if (lane.state === "recovering" && lane.lastError?.reason === reason) return { state: "recovering", action: "none", reason: "error_already_in_triage" };
    return { state: "recovering", action: "triage_error", reason, priority: "immediate" };
  }
  if (observed === "completed") return { state: "completed", action: "verify_completion", reason: "completion_evidence_observed" };
  if (observed === "blocked") return { state: "blocked", action: "hold", reason: text(observation.blockedReason) };
  if (ACTIVE.has(observed)) return { state: observed, action: "heartbeat", reason: "lane_active" };
  if (observed === "idle_prompt" || observed === "process_exited") return { state: "blocked", action: "hold", reason: "outcome_unverified", observed, priority: "immediate" };
  if (RECOVERABLE_FAILURES.has(observed)) {
    if (!text(observation.lastCommand?.evidenceRef)) return { state: "blocked", action: "hold", reason: "unverified_failure_evidence", observed, priority: "immediate" };
    if (lane.lastDispatch?.observationDigest === digest(observation)) return { state: lane.state, action: "none", reason: "attempt_already_claimed", observed };
    // Detection is an immediate recover-or-hold gate, never a backlog heartbeat.
    // An implementer cannot certify its own candidate by redispatching a
    // self-review prompt. Review recovery needs a distinct registered actor,
    // exact head, and executable argv before any retry is possible.
    const approvedReview = isAuthenticatedReviewRegistration(reviewRegistration, lane)
      && reviewRegistration.actionDigest === digest(lane.nextAction?.argv);
    if (lane.reviewRequired && (lane.nextAction?.kind !== "independent_review"
      || lane.nextAction.reviewer !== "codex"
      || JSON.stringify(lane.nextAction.argv) !== JSON.stringify(["codex", "review", "--commit", lane.headSha])
      || !text(lane.nextAction.reviewer) || lane.nextAction.reviewer === lane.owner
      || !/^[0-9a-f]{40}$/i.test(text(lane.headSha))
      || lane.nextAction.headSha !== lane.headSha || !approvedReview)) {
      return { state: "blocked", action: "hold", reason: "independent_review_action_unregistered", observed, priority: "immediate" };
    }
    if (lane.retry.attempts >= lane.retry.maxAttempts) return { state: "blocked", action: "hold", reason: "retry_budget_exhausted", observed, priority: "immediate" };
    return {
      state: "recovering", action: "redispatch_registered_action", reason: observed,
      observed, priority: "immediate", attempt: lane.retry.attempts + 1, observationDigest: digest(observation),
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
    next.lastDispatch = { at: now, argvDigest: decision.actionDigest, observationDigest: decision.observationDigest, reason: decision.reason };
  } else if (decision.action === "triage_error") {
    next.state = "recovering";
    next.lastError = { at: now, reason: decision.reason };
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
    priority: decision.priority ?? "routine",
    observationDigest: digest(observation),
    actionDigest: decision.actionDigest ?? null,
    retryAttempt: decision.attempt ?? lane.retry?.attempts ?? 0,
  };
}
