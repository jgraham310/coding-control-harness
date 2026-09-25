#!/usr/bin/env node
import assert from "node:assert/strict";
import { briefing, classifyPane, finishAttempt, handoffRecord, independentReviewRequired, nextAction, observeSnapshot, queueAction, validateManifest, verifyScheduledRun } from "./deterministic-engine.mjs";

const manifest = { id: "surava-growth", parentGoal: "grow-pipeline", successPredicate: "qualified pipeline recorded", deadline: "2026-09-30T00:00:00Z", cadence: "PT1H", sources: ["hubspot"], authority: { allowed: ["observe", "draft", "internal_update"], jasonGated: ["external_send", "spend"] }, escalations: ["strategy", "external_send"], executionContract: { objective: "Record qualified pipeline.", constraints: ["Do not send external messages."], validation: ["HubSpot qualified-stage report contains the record."], stopCondition: "Qualified record exists or a named Jason decision is required.", checkpointCadence: "PT1H" }, independentReview: { enabled: true, triggers: ["security_sensitive", "production_impacting"] } };
assert.equal(validateManifest(manifest), true);
assert.throws(() => validateManifest({ ...manifest, authority: { allowed: ["jason_gated"], jasonGated: [] } }));
assert.throws(() => validateManifest({ ...manifest, executionContract: { ...manifest.executionContract, validation: [] } }));

const queue = [];
assert.equal(queueAction(queue, { id: "a", idempotencyKey: "same", class: "observe", priority: 1, nextAttemptAt: "2026-08-16T12:00:00Z" }).created, true);
assert.equal(queueAction(queue, { id: "duplicate", idempotencyKey: "same", class: "observe", nextAttemptAt: "2026-08-16T12:00:00Z" }).created, false);
assert.equal(nextAction(queue, "2026-08-16T12:00:01Z").id, "a");
finishAttempt(queue[0], "retryable_failure", "2026-08-16T12:00:01Z", 1000);
assert.equal(nextAction(queue, "2026-08-16T12:00:01Z"), null);
assert.equal(nextAction(queue, "2026-08-16T12:00:02Z").id, "a");
finishAttempt(queue[0], "succeeded", "2026-08-16T12:00:02Z");
assert.equal(queue[0].status, "succeeded");

const snapshots = {};
assert.equal(observeSnapshot(snapshots, "hubspot", { b: 2, a: 1 }, "2026-08-16T12:00:00Z").changed, true);
assert.equal(observeSnapshot(snapshots, "hubspot", { a: 1, b: 2 }, "2026-08-16T12:01:00Z").changed, false);
assert.equal(observeSnapshot(snapshots, "hubspot", { a: 1, b: 3 }, "2026-08-16T12:02:00Z").changed, true);

assert.equal(classifyPane("", false).kind, "missing_session");
assert.equal(classifyPane("❯ merge #563 once checks pass").kind, "routine_prompt");
assert.equal(classifyPane("Needs your approval to send email").kind, "jason_or_permission_prompt");
assert.equal(classifyPane("The only thing blocking merge is your call on the privacy decision.").kind, "jason_or_permission_prompt");
const expiredCodexAuth = classifyPane("ERROR: Your access token could not be refreshed. Please log out and sign in again.");
assert.equal(expiredCodexAuth.kind, "recoverable_local_codex_auth");
assert.equal(expiredCodexAuth.modelRequired, false);
assert.equal(expiredCodexAuth.action, "launch_local_codex_reauth_then_verify");
assert.notEqual(expiredCodexAuth.kind, "jason_or_permission_prompt");
assert.equal(classifyPane("running tests\nworking").kind, "active");
assert.equal(classifyPane("Traceback: failed").modelRequired, true);
assert.equal(independentReviewRequired(manifest.independentReview, ["security_sensitive"]), true);
assert.equal(independentReviewRequired(manifest.independentReview, ["disputed_change"]), false);
assert.equal(verifyScheduledRun({ scheduledAt: "2026-08-16T12:00:00Z", startedAt: "2026-08-16T12:00:03Z", completedAt: "2026-08-16T12:00:05Z", exitCode: 0, maxStartDelayMs: 10_000, maxRuntimeMs: 10_000 }, "2026-08-16T12:00:06Z").healthy, true);
assert.equal(verifyScheduledRun({ scheduledAt: "2026-08-16T12:00:00Z", startedAt: "2026-08-16T12:00:03Z", completedAt: "2026-08-16T12:01:05Z", exitCode: 0, maxStartDelayMs: 10_000, maxRuntimeMs: 10_000 }, "2026-08-16T12:01:06Z").reason, "runtime_exceeded");
const handoff = handoffRecord({ id: "handoff", title: "Packet", phase: "implementing", active: true, repository: "jgraham310/example", branch: "feat/example", worktree: "example-wt", pullRequest: 1, successPredicate: "Verified delivery.", nextAction: "Run focused checks.", lastEvidence: { at: "2026-08-16T12:00:00Z", detail: "Commit exists." }, blocker: null, executionContract: manifest.executionContract });
assert.equal(handoff.goal, "Record qualified pipeline.");
assert.deepEqual(handoff.pointers, ["jgraham310/example", "feat/example", "example-wt", 1]);

const view = briefing([{ id: "decision", requiresJason: true, status: "active" }, { id: "late", status: "active", deadline: "2026-08-15T00:00:00Z" }, { id: "soon", status: "active", deadline: "2026-08-18T00:00:00Z" }], "2026-08-16T00:00:00Z");
assert.deepEqual(view.needsAttention.map((item) => item.id), ["decision"]);
assert.deepEqual(view.offTrack.map((item) => item.id), ["late"]);
assert.deepEqual(view.upcoming.map((item) => item.id), ["soon"]);
console.log("deterministic engine tests: passed");
