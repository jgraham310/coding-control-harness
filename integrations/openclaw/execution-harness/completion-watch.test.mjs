import assert from "node:assert/strict";
import { reconcileCompletionLanes } from "./completion-watch.mjs";

const at = "2026-09-28T20:00:00Z";
const lane = {
  id: "synthetic-2712", issue: 2712, owner: "claude", sessionName: "synthetic-2712", worktree: "/tmp",
  completionPredicate: "exact-head review", deadlineAt: "2026-09-29T20:00:00Z",
  state: "executing", retry: { attempts: 0, maxAttempts: 1 },
  nextAction: { argv: ["/bin/echo", "review"] },
};
const observation = { pane: "idle_prompt", lastCommand: { status: "rejected", at } };
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
const staleCompletion = { pane: "executing", completedEvidence: true, error: "MODULE_NOT_FOUND" };
const held = reconcileCompletionLanes(reviewState, { ...options, observe: () => staleCompletion, registrationLoader: () => null });
assert.equal(held[0].kind, "completion_independent_review_action_unregistered");
assert.equal(reviewState.completionLanes[0].state, "blocked");
assert.equal(dispatches, 1);
assert.equal(reconcileCompletionLanes(reviewState, { ...options, observe: () => staleCompletion }).length, 0, "held lane is terminal until explicit state transition");
console.log("completion live-watch tests: passed");
