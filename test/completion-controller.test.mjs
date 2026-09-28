import assert from "node:assert/strict";
import crypto from "node:crypto";
import { collectCommentPages, loadReviewRegistration } from "../src/review-registration.mjs";
import { applyDecision, completionReceipt, reconcileLane } from "../src/completion-controller.mjs";

const lane = {
  id: "tems-624", owner: "tems-cto", sessionName: "tems-pr625-repair", worktree: "/work/tems-624",
  completionPredicate: "named tests pass and candidate is pushed", deadlineAt: "2026-09-24T12:00:00.000Z",
  state: "executing", retry: { attempts: 0, maxAttempts: 2 },
  nextAction: { argv: ["claude", "-p", "resume bounded remediation"] },
};
const at = "2026-09-23T10:00:00.000Z";

let decision = reconcileLane(lane, { pane: "idle_prompt", lastCommand: { status: "rejected", evidenceRef: "failure-1" } }, { now: at });
assert.equal(decision.action, "redispatch_registered_action");
assert.deepEqual(decision.argv, lane.nextAction.argv);
let next = applyDecision(lane, decision, { now: at });
assert.equal(next.retry.attempts, 1);
assert.equal(next.state, "executing");

decision = reconcileLane({ ...next, retry: { attempts: 2, maxAttempts: 2 } }, { pane: "idle_prompt", lastCommand: { status: "rejected", evidenceRef: "failure-2", at: "2026-09-23T10:01:00.000Z" } }, { now: at });
assert.equal(decision.action, "hold");
assert.equal(decision.reason, "retry_budget_exhausted");

decision = reconcileLane(lane, { lastCommand: { status: "rejected", evidenceRef: "failure-1" } }, { now: at });
assert.equal(decision.action, "redispatch_registered_action");
assert.equal(decision.reason, "command_rejected");
assert.equal(decision.priority, "immediate");

const reviewLane = { ...lane, owner: "claude", headSha: "2bb4952623c9e4623a77b3ca7e0449e9a8bddb10", reviewRequired: true };
decision = reconcileLane(reviewLane, { pane: "executing", error: "MODULE_NOT_FOUND", lastCommand: { evidenceRef: "failure-1" } }, { now: at });
assert.equal(decision.action, "hold", "a stale executing label cannot hide a runtime error");
assert.equal(decision.reason, "independent_review_action_unregistered");
assert.equal(decision.observed, "runtime_error");
assert.equal(decision.priority, "immediate");
assert.equal(applyDecision(reviewLane, decision, { now: at }).state, "blocked");
assert.equal(completionReceipt(reviewLane, { error: "MODULE_NOT_FOUND", lastCommand: { evidenceRef: "failure-1" } }, decision, { now: at }).priority, "immediate");

const registeredReview = { ...reviewLane, repository: "jgraham310/local-government", issue: 2712, implementerLogin: "jgraham310", nextAction: { kind: "independent_review", registrationId: "review-2712", reviewer: "codex", headSha: reviewLane.headSha, argv: ["codex", "review", "--commit", reviewLane.headSha] } };
const record = { schema: "independent-review-registration/v1", laneId: registeredReview.id, id: "review-2712", reviewer: "codex", headSha: reviewLane.headSha, actionDigest: crypto.createHash("sha256").update(JSON.stringify(registeredReview.nextAction.argv)).digest("hex"), implementerLogin: registeredReview.implementerLogin };
const comment = { id: 7, user: { login: "independent-reviewer" }, author_association: "COLLABORATOR", body: `independent-review-registration/v1 ${JSON.stringify(record)}` };
assert.equal(reconcileLane(registeredReview, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at, reviewRegistration: { ...record, registrar: "independent-reviewer" } }).action, "hold", "caller-computable approval cannot bypass authentication");
assert.equal(loadReviewRegistration(registeredReview, { client: () => [{ ...comment, author_association: "NONE" }] }), null, "untrusted GitHub actor cannot register review");
assert.equal(collectCommentPages((page) => page === 1 ? Array.from({ length: 100 }, (_, id) => ({ id })) : [comment]).length, 101, "registration beyond first page remains reachable");
const authenticated = loadReviewRegistration(registeredReview, { client: () => [comment] });
assert.equal(authenticated.githubCommentId, 7);
decision = reconcileLane(registeredReview, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at, reviewRegistration: authenticated });
assert.equal(decision.action, "redispatch_registered_action");
assert.equal(decision.priority, "immediate");
assert.deepEqual(decision.argv, registeredReview.nextAction.argv);
assert.equal(reconcileLane({ ...registeredReview, nextAction: { ...registeredReview.nextAction, reviewer: "claude" } }, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at, reviewRegistration: authenticated }).action, "hold");
assert.equal(reconcileLane({ ...registeredReview, nextAction: { ...registeredReview.nextAction, headSha: "a".repeat(40) } }, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at, reviewRegistration: authenticated }).action, "hold");
assert.equal(reconcileLane(registeredReview, { completedEvidence: true, lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at }).reason, "independent_review_action_unregistered", "error outranks stale completion");
assert.equal(reconcileLane({ ...registeredReview, nextAction: { ...registeredReview.nextAction, argv: ["codex", "review", reviewLane.headSha] } }, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at, reviewRegistration: authenticated }).action, "hold", "a prompt is not an exact-commit executable review");

assert.equal(reconcileLane(lane, { pane: "idle_prompt" }, { now: at }).reason, "outcome_unverified", "idle prompt is not failure evidence");
assert.equal(reconcileLane(lane, { lastCommand: { status: "error" } }, { now: at }).reason, "unverified_failure_evidence", "uncited error cannot dispatch");
decision = reconcileLane(lane, { pane: "executing" }, { now: at });
assert.equal(decision.action, "heartbeat");
decision = reconcileLane(lane, { completedEvidence: true }, { now: at });
assert.equal(decision.action, "verify_completion");
assert.equal(completionReceipt(lane, { completedEvidence: true }, decision, { now: at }).laneId, "tems-624");
assert.equal(applyDecision(lane, decision, { now: at }).state, "completed");

decision = reconcileLane({ ...lane, deadlineAt: "2026-09-23T09:59:00.000Z" }, { lastCommand: { status: "error", evidenceRef: "failure-1" } }, { now: at });
assert.equal(decision.reason, "deadline_exceeded");
console.log("completion controller tests: passed");
