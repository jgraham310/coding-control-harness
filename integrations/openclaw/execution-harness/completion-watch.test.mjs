import assert from "node:assert/strict";
import { observeCompletionLane, reconcileCompletionLanes } from "./completion-watch.mjs";

const at = "2026-09-28T20:00:00Z";
const lane = {
  id: "synthetic-2712", issue: 2712, owner: "claude", sessionName: "synthetic-2712", worktree: "/tmp",
  completionPredicate: "exact-head review", deadlineAt: "2026-09-29T20:00:00Z",
  state: "executing", retry: { attempts: 0, maxAttempts: 1 },
  nextAction: { argv: ["/bin/echo", "review"] },
};
const observation = { pane: "idle_prompt", lastCommand: { status: "rejected", evidenceRef: "failure", at } };
const state = { completionLanes: [structuredClone(lane)] };
const saved = [];
let dispatches = 0;
const options = { at, apply: true, observe: () => observation, authorize: () => true,
  save: (value) => saved.push(structuredClone(value.completionLanes[0])),
  dispatch: () => { dispatches++; return { pid: 123 }; } };
const first = reconcileCompletionLanes(state, options);
assert.equal(first[0].kind, "completion_command_rejected");
assert.equal(dispatches, 1);
assert.equal(saved[0].retry.attempts, 1, "attempt must persist before dispatch");
assert.equal(saved[0].lastDispatch.pid, undefined);
assert.equal(saved[1].lastDispatch.pid, 123);
assert.equal(reconcileCompletionLanes(state, options).length, 0, "same observation cannot claim twice");
assert.equal(dispatches, 1);
assert.equal(state.completionLanes[0].retry.attempts, 1);

const deniedState = { completionLanes: [structuredClone(lane)] };
assert.equal(reconcileCompletionLanes(deniedState, { ...options, authorize: () => false })[0].kind, "completion_workstate_grant_missing");
assert.equal(deniedState.completionLanes[0].state, "blocked");
assert.equal(dispatches, 1, "stale WorkState cannot dispatch");

const reviewState = { completionLanes: [{ ...structuredClone(lane), reviewRequired: true, headSha: "a".repeat(40),
  nextAction: { kind: "independent_review", registrationId: "x", reviewer: "codex", headSha: "a".repeat(40), argv: ["/bin/echo", "review"] } }] };
const staleCompletion = { pane: "executing", completedEvidence: true, error: "MODULE_NOT_FOUND", lastCommand: { evidenceRef: "failure" } };
const held = reconcileCompletionLanes(reviewState, { ...options, observe: () => staleCompletion, registrationLoader: () => null });
assert.equal(held[0].kind, "completion_independent_review_action_unregistered");
assert.equal(reviewState.completionLanes[0].state, "blocked");
assert.equal(dispatches, 1);
assert.equal(reconcileCompletionLanes(reviewState, { ...options, observe: () => staleCompletion }).length, 0, "held lane is terminal until explicit state transition");
assert.equal(observeCompletionLane(lane, { capture: () => { throw new Error("tmux timeout"); }, listSessions: () => lane.sessionName }).blockedReason, "pane_observation_failed");
assert.equal(observeCompletionLane(lane, { capture: () => { throw new Error("tmux offline"); }, listSessions: () => { throw new Error("server offline"); } }).blockedReason, "pane_observation_failed");
assert.equal(observeCompletionLane(lane, { capture: () => { throw new Error("missing"); }, listSessions: () => "unrelated-session" }).pane, "exited");
assert.equal(observeCompletionLane(lane, { capture: () => "Handled Error: expected input\n$ " }).pane, "idle_prompt", "pane text is not authoritative command failure");
assert.equal(observeCompletionLane({ ...lane, lastCommand: observation.lastCommand }, { capture: () => { throw new Error("timeout"); }, listSessions: () => { throw new Error("offline"); } }).blockedReason, "pane_observation_failed", "cached command failure cannot override sensor failure");
const launchedLane = { ...lane, reviewRequired: true, headSha: "a".repeat(40), lastDispatch: { pid: 123 } };
assert.equal(observeCompletionLane(launchedLane, { processStatus: () => `codex review --commit ${launchedLane.headSha}` }).pane, "executing");
assert.equal(observeCompletionLane(launchedLane, { processStatus: () => "unrelated process" }).blockedReason, "dispatched_process_unverifiable");
assert.equal(observeCompletionLane(launchedLane, { processStatus: () => { throw new Error("exited"); } }).blockedReason, "dispatched_process_finished_requires_verification");
console.log("completion live-watch tests: passed");
