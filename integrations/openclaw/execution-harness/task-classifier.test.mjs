#!/usr/bin/env node
import assert from "node:assert/strict";
import { classifyTask, validateTaskEnvelope } from "./task-classifier.mjs";

const route = (request, extra = {}) => classifyTask({ request, ...extra });

assert.equal(route("Read this paper and assess its sources", { attachments: ["paper.pdf"] }).protocol.id, "research");
assert.equal(route("Review this PR and run the focused tests", { repository: "example/repo" }).protocol.id, "coding");
assert.equal(route("Prepare the weekly operations briefing from HubSpot").protocol.id, "operations");
assert.equal(route("Verify the merged PR in the release window", { signals: ["merged_pr", "release_window"] }).protocol.id, "release_verification");
assert.equal(route("Deploy the merged PR", { signals: ["merged_pr", "release_window"] }).protocol.id, "jason_gated");
assert.equal(route("Send this customer email draft").protocol.id, "jason_gated");
assert.equal(route("Change the production API key").protocol.id, "jason_gated");
assert.equal(route("Read the paper and fix the repository test", { repository: "example/repo" }).protocol.id, "governed_general");
assert.equal(route("Think about this").reason[0], "no_deterministic_match");
assert.throws(() => validateTaskEnvelope({ request: "" }));
assert.throws(() => validateTaskEnvelope({ request: "valid", signals: [42] }));

console.log("task classifier tests: passed (10 cases)");
