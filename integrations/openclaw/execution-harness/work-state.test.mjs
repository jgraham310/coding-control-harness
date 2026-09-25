#!/usr/bin/env node
import assert from "node:assert/strict";
import { completeAction, emptyRuntime, recordEvidence, registerWorkState, transitionWorkState, workStateContext } from "./work-state.mjs";

const at = "2026-09-19T12:00:00.000Z";
const runtime = emptyRuntime();
recordEvidence(runtime, { id: "evidence-intake", source: "test", artifact: "sha256:intake", status: "observed", excerpts: ["incoming CI failure"], facts: ["CI is red"] }, at);
const state = registerWorkState(runtime, {
  id: "closure-ci-1", objective: "Restore CI without duplicate repair dispatch.", acceptanceTests: ["one action per idempotency key", "stale state writes are rejected"],
  authorityBoundary: { allowedActions: ["inspect", "retry_safe"] }, phase: "identified", nextAction: "Inspect exact failed run.", owner: "Portfolio controller",
  evidenceRefs: ["evidence-intake"], retryPolicy: { maxAttempts: 3 }, deadline: "2026-09-20T12:00:00.000Z",
}, at);
assert.equal(state.version, 1);

const prepared = transitionWorkState(runtime, "closure-ci-1", 1, { phase: "active", nextAction: "Run the exact safe inspection.", facts: ["CI is red"], evidenceRefs: ["evidence-intake"] }, { id: "inspect-1", idempotencyKey: "closure-ci-1:inspect:1", class: "inspect", description: "Inspect exact CI result." }, "The immutable intake receipt identifies a failed CI run.", at);
assert.equal(prepared.created, true);
assert.equal(prepared.record.version, 2);
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 1, { phase: "waiting" }, { id: "stale", idempotencyKey: "stale", class: "inspect", description: "Stale action." }, "stale", at), /Stale WorkState version/);
assert.equal(transitionWorkState(runtime, "closure-ci-1", 2, { phase: "waiting" }, { id: "inspect-duplicate", idempotencyKey: "closure-ci-1:inspect:1", class: "inspect", description: "Duplicate action." }, "retry", at).created, false);
recordEvidence(runtime, { id: "evidence-inspection", source: "test", artifact: "sha256:inspection", status: "passed", excerpts: ["focused test passed"], facts: ["no repair needed"] }, at);
assert.equal(completeAction(runtime, "inspect-1", "succeeded", "evidence-inspection", at).status, "succeeded");
assert.equal(completeAction(runtime, "inspect-1", "succeeded", "evidence-inspection", at).status, "succeeded");
const context = workStateContext(runtime, "closure-ci-1", "evidence-inspection");
assert.equal(context.workState.version, 2);
assert.equal(context.latestObservation.id, "evidence-inspection");
assert.equal(context.pendingActions.length, 0);
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 2, { evidenceRefs: ["missing"] }, { id: "bad-evidence", idempotencyKey: "bad-evidence", class: "inspect", description: "Invalid." }, "invalid", at), /missing evidence/);
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 2, { phase: "completed" }, { id: "forbidden", idempotencyKey: "forbidden", class: "internal_update", description: "Forbidden." }, "invalid", at), /outside the WorkState authority boundary/);
console.log("work-state tests: passed");
