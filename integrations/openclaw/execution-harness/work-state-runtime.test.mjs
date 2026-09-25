#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(dir, "work-state-runtime.mjs");
const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "work-state-runtime-")), "state.json");
const at = "2026-09-19T12:00:00.000Z";
function run(command, args = []) {
  return JSON.parse(execFileSync("node", [runtime, command, "--state", state, "--at", at, ...args], { encoding: "utf8" }));
}
function expectFailure(command, args, pattern) {
  const result = spawnSync("node", [runtime, command, "--state", state, "--at", at, ...args], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
}
const receipt = { id: "intake", source: "test", artifact: "sha256:intake", status: "observed", excerpts: ["failure"], facts: ["CI failed"] };
assert.equal(run("record-evidence", ["--receipt", JSON.stringify(receipt)]).created, true);
const record = { id: "lane-1", objective: "Repair a bounded failure.", acceptanceTests: ["stale transitions fail", "duplicate action does not replay"], authorityBoundary: { allowedActions: ["inspect", "retry_safe"] }, phase: "identified", nextAction: "Inspect the evidence.", owner: "controller", evidenceRefs: ["intake"], dependencies: [], blockers: [], facts: [], decisions: [], retryPolicy: { maxAttempts: 2 }, deadline: "2026-09-20T12:00:00.000Z" };
assert.equal(run("register", ["--record", JSON.stringify(record)]).record.version, 1);
fs.mkdirSync(`${state}.lockdir`);
fs.writeFileSync(path.join(`${state}.lockdir`, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
expectFailure("record-evidence", ["--receipt", JSON.stringify({ ...receipt, id: "blocked" })], /State is busy/);
fs.rmSync(`${state}.lockdir`, { recursive: true });
fs.mkdirSync(`${state}.lockdir`);
fs.writeFileSync(path.join(`${state}.lockdir`, "owner.json"), JSON.stringify({ pid: 99999999, token: "dead" }));
assert.equal(run("record-evidence", ["--receipt", JSON.stringify({ ...receipt, id: "after-death" })]).created, true);
assert.equal(fs.existsSync(`${state}.lockdir`), false);
const action = { id: "inspect", idempotencyKey: "lane-1:inspect", class: "inspect", description: "Inspect failure." };
const transition = run("transition", ["--id", "lane-1", "--expected-version", "1", "--patch", JSON.stringify({ phase: "active", nextAction: "Inspect exact logs.", evidenceRefs: ["intake"] }), "--action", JSON.stringify(action), "--rationale", "The intake receipt requires exact inspection."]);
assert.equal(transition.record.version, 2);
assert.equal(run("transition", ["--id", "lane-1", "--expected-version", "1", "--patch", JSON.stringify({ phase: "waiting" }), "--action", JSON.stringify({ ...action, id: "retry" }), "--rationale", "duplicate"]).created, false);
expectFailure("transition", ["--id", "lane-1", "--expected-version", "1", "--patch", JSON.stringify({ phase: "waiting" }), "--action", JSON.stringify({ id: "stale", idempotencyKey: "stale", class: "inspect", description: "stale" }), "--rationale", "stale"], /Stale WorkState version/);
run("record-evidence", ["--receipt", JSON.stringify({ id: "result", source: "test", artifact: "sha256:result", status: "passed", excerpts: ["passed"], facts: ["safe"] })]);
assert.equal(run("complete-action", ["--action-id", "inspect", "--outcome", "succeeded", "--evidence-ref", "result"]).action.status, "succeeded");
const context = run("context", ["--id", "lane-1", "--latest-evidence", "result"]);
assert.equal(context.workState.version, 2);
assert.equal(context.latestObservation.id, "result");
assert.equal(context.pendingActions.length, 0);
console.log("work-state runtime restart tests: passed");
