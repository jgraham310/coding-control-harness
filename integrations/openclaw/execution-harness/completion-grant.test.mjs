import assert from "node:assert/strict";
import crypto from "node:crypto";
import { hasCompletionGrant } from "./completion-grant.mjs";
const head = "a".repeat(40);
const lane = { id: "civicline-2712-review", issue: 2712, repository: "jgraham310/local-government", workStateId: "cto:civicline", workStateVersion: 51,
  headSha: head, retry: { attempts: 0, maxAttempts: 1 }, lastCommand: { status: "error", evidenceRef: "failure" }, nextAction: { argv: ["codex", "review", "--commit", head] } };
const actionDigest = crypto.createHash("sha256").update(JSON.stringify(lane.nextAction.argv)).digest("hex");
const grant = { schema: "completion-retry-grant/v1", laneId: lane.id, issue: lane.issue, repository: lane.repository, headSha: head, actionDigest };
const runtime = { records: { "cto:civicline": { id: "cto:civicline", phase: "active", version: 51, authorityBoundary: { allowedActions: ["retry_safe"] }, retryPolicy: { maxAttempts: 1 }, evidenceRefs: ["failure", "receipt"] } },
  evidence: { failure: { status: "verified_stopped" }, receipt: { status: "verified" } }, actions: { action: { workStateId: "cto:civicline", stateVersion: 51, class: "retry_safe", status: "prepared", description: JSON.stringify(grant) } } };
assert.equal(hasCompletionGrant(runtime, lane), true);
assert.equal(hasCompletionGrant({ ...runtime, records: { "cto:civicline": { ...runtime.records["cto:civicline"], phase: "blocked" } } }, lane), false);
assert.equal(hasCompletionGrant({ ...runtime, records: { "cto:civicline": { ...runtime.records["cto:civicline"], authorityBoundary: { allowedActions: ["observe"] } } } }, lane), false);
assert.equal(hasCompletionGrant({ ...runtime, records: { "cto:civicline": { ...runtime.records["cto:civicline"], retryPolicy: { maxAttempts: 0 } } } }, lane), false);
assert.equal(hasCompletionGrant(runtime, { ...lane, issue: 2713 }), false);
assert.equal(hasCompletionGrant(runtime, { ...lane, lastCommand: { status: "error", evidenceRef: "other" } }), false);
assert.equal(hasCompletionGrant(runtime, { ...lane, headSha: "b".repeat(40) }), false);
assert.equal(hasCompletionGrant(runtime, { ...lane, nextAction: { argv: ["/bin/echo", "review"] } }), false);
assert.equal(hasCompletionGrant({ ...runtime, evidence: { failure: { status: "verified_stopped" }, receipt: { status: "pending" } } }, lane), false);
assert.equal(hasCompletionGrant({ ...runtime, actions: { action: { ...runtime.actions.action, status: "succeeded" } } }, lane), false);
console.log("completion WorkState grant tests: passed");
