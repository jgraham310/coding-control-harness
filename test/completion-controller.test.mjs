import assert from "node:assert/strict";
import { applyDecision, completionReceipt, reconcileLane } from "../src/completion-controller.mjs";

const lane = {
  id: "tems-624", owner: "tems-cto", sessionName: "tems-pr625-repair", worktree: "/work/tems-624",
  completionPredicate: "named tests pass and candidate is pushed", deadlineAt: "2026-09-24T12:00:00.000Z",
  state: "executing", retry: { attempts: 0, maxAttempts: 2 },
  nextAction: { argv: ["claude", "-p", "resume bounded remediation"] },
};
const at = "2026-09-23T10:00:00.000Z";

let decision = reconcileLane(lane, { pane: "idle_prompt" }, { now: at });
assert.equal(decision.action, "redispatch_registered_action");
assert.deepEqual(decision.argv, lane.nextAction.argv);
let next = applyDecision(lane, decision, { now: at });
assert.equal(next.retry.attempts, 1);
assert.equal(next.state, "executing");

decision = reconcileLane({ ...next, retry: { attempts: 2, maxAttempts: 2 } }, { pane: "idle_prompt" }, { now: at });
assert.equal(decision.action, "hold");
assert.equal(decision.reason, "retry_budget_exhausted");

decision = reconcileLane(lane, { lastCommand: { status: "rejected" } }, { now: at });
assert.equal(decision.action, "redispatch_registered_action");
assert.equal(decision.reason, "command_rejected");

decision = reconcileLane(lane, { pane: "executing" }, { now: at });
assert.equal(decision.action, "heartbeat");
decision = reconcileLane(lane, { completedEvidence: true }, { now: at });
assert.equal(decision.action, "verify_completion");
assert.equal(completionReceipt(lane, { completedEvidence: true }, decision, { now: at }).laneId, "tems-624");
assert.equal(applyDecision(lane, decision, { now: at }).state, "completed");

decision = reconcileLane({ ...lane, deadlineAt: "2026-09-23T09:59:00.000Z" }, { pane: "idle_prompt" }, { now: at });
assert.equal(decision.reason, "deadline_exceeded");
console.log("completion controller tests: passed");
