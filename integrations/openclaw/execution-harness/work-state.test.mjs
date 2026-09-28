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
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 2, { phase: "waiting" }, { id: "inspect-1", idempotencyKey: "different-key", class: "inspect", description: "Collision." }, "collision", at), /already in use/);
assert.equal(runtime.actions["inspect-1"].idempotencyKey, "closure-ci-1:inspect:1");
recordEvidence(runtime, { id: "evidence-inspection", source: "test", artifact: "sha256:inspection", status: "passed", excerpts: ["focused test passed"], facts: ["no repair needed"] }, at);
assert.equal(completeAction(runtime, "inspect-1", "succeeded", "evidence-inspection", at).status, "succeeded");
assert.equal(completeAction(runtime, "inspect-1", "succeeded", "evidence-inspection", at).status, "succeeded");
const context = workStateContext(runtime, "closure-ci-1", "evidence-inspection");
assert.equal(context.workState.version, 2);
assert.equal(context.latestObservation.id, "evidence-inspection");
assert.equal(context.pendingActions.length, 0);
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 2, { evidenceRefs: ["missing"] }, { id: "bad-evidence", idempotencyKey: "bad-evidence", class: "inspect", description: "Invalid." }, "invalid", at), /missing evidence/);
assert.throws(() => transitionWorkState(runtime, "closure-ci-1", 2, { phase: "completed" }, { id: "forbidden", idempotencyKey: "forbidden", class: "internal_update", description: "Forbidden." }, "invalid", at), /outside the WorkState authority boundary/);
const civic = emptyRuntime();
recordEvidence(civic, {id:"civicline-merge-staging-grant-20260928",source:"Jason",artifact:"signal:grant",status:"verified"},at);
recordEvidence(civic, {id:"deployment",source:"isolated staging",artifact:`sha256:${"a".repeat(64)}`,status:"verified"},at);
registerWorkState(civic,{id:"cto:civicline",objective:"Bound CivicLine controls",acceptanceTests:["exact deployment proof"],authorityBoundary:{allowedActions:["internal_update"]},phase:"active",nextAction:"Keep merge held",owner:"civicline-cto",evidenceRefs:["civicline-merge-staging-grant-20260928","deployment"]},at);
const operationAction={id:"grant-1",idempotencyKey:"grant-1",class:"internal_update",description:"Select bounded operations and deployment"};
assert.throws(()=>transitionWorkState(civic,"cto:civicline",1,{authorizedOperations:["merge_green_pr"],evidenceRefs:["deployment"]},operationAction,"missing grant",at),/lacks bounded operation grant evidence/);
const granted=transitionWorkState(civic,"cto:civicline",1,{authorizedOperations:["merge_green_pr"],currentDeploymentEvidenceRef:"deployment"},operationAction,"immutable grant and selected deployment",at);
assert.deepEqual(granted.record.authorizedOperations,["merge_green_pr"]);
assert.equal(granted.record.currentDeploymentEvidenceRef,"deployment");
assert.throws(()=>transitionWorkState(civic,"cto:civicline",2,{currentDeploymentEvidenceRef:"missing"},{...operationAction,id:"bad-selection",idempotencyKey:"bad-selection"},"missing receipt",at),/unselected deployment evidence/);
console.log("work-state tests: passed");
