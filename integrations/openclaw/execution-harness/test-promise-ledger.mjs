#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ledger = path.join(dir, "promise-ledger.mjs");
const state = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "promise-ledger-")), "ledger.json");
function run(...args) { return JSON.parse(execFileSync("node", [ledger, ...args, "--state", state], { encoding: "utf8" })); }
function fails(...args) { assert.throws(() => run(...args), /requires|Potential commitment|non-empty|already overdue/); }

run("preflight-send", "--message", "The check is complete.", "--classification", "noncommitment");
fails("preflight-send", "--message", "I will send an update.", "--classification", "noncommitment");
run("preflight-send", "--message", "I think this memory design is promising, but its tradeoff is operational complexity.", "--classification", "noncommitment");
run("preflight-send", "--message", "The required fix is to create the controller.", "--classification", "noncommitment");
fails("preflight-send", "--message", "We have implemented the controller.", "--classification", "noncommitment");
fails("preflight-send", "--message", "We have implemented the controller.", "--classification", "remedy");
const remedy = run("preflight-send", "--message", "We have implemented the controller.", "--classification", "remedy", "--remedy-receipt", "controller created; tests passed");
assert.equal(remedy.authorized, true);
assert.equal(remedy.detectedRemedyLanguage, true);
run("register", "--id", "cleanup", "--owner", "Portfolio controller", "--deliverable", "Publish the verified cleanup update.", "--due", "2026-08-20T16:00:00Z", "--update-due", "2026-08-20T15:10:00Z", "--success-predicate", "The update is sent with live GitHub evidence.", "--resolver-job-id", "resolver-1", "--resolver-cadence", "PT30M", "--escalation", "Jason", "--at", "2026-08-20T15:00:00Z");
fails("preflight-send", "--message", "I will send an update.", "--classification", "commitment");
const preflight = run("preflight-send", "--message", "I will send an update.", "--classification", "commitment", "--promise-ids", "cleanup");
assert.equal(preflight.authorized, true);
const dueUpdate = run("watch", "--apply", "--at", "2026-08-20T15:11:00Z");
assert.equal(dueUpdate.pendingEvents.some((event) => event.kind === "promise_update_due"), true);
fails("record-update", "--id", "cleanup", "--evidence", "", "--next-update-due", "2026-08-20T15:30:00Z", "--at", "2026-08-20T15:11:00Z");
run("record-update", "--id", "cleanup", "--evidence", "Live GitHub queue checked; blocker recorded.", "--next-update-due", "2026-08-20T15:30:00Z", "--at", "2026-08-20T15:11:00Z");
const overdue = run("watch", "--apply", "--at", "2026-08-20T16:01:00Z");
assert.equal(overdue.pendingEvents.some((event) => event.kind === "promise_due"), true);
fails("complete", "--id", "cleanup", "--evidence", "", "--at", "2026-08-20T16:01:00Z");
const completed = run("complete", "--id", "cleanup", "--evidence", "GitHub state and sent update are recorded.", "--at", "2026-08-20T16:02:00Z");
assert.equal(completed.promise.status, "completed");
assert.equal(run("watch", "--apply", "--at", "2026-08-20T17:00:00Z").pendingEvents.length, 0);
console.log("promise-ledger tests: passed");
