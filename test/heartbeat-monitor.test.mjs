import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateScheduler, writeReceipt } from "../src/heartbeat-monitor.mjs";

const clean = evaluateScheduler({ jobs: [
  { declarationKey: "heartbeat:cos:deterministic", enabled: true, state: { lastRunStatus: "error", consecutiveErrors: 1 } },
  { declarationKey: "healthy", enabled: true, state: { lastRunStatus: "ok" } },
] });
assert.equal(clean.status, "healthy", "the monitor never self-amplifies a prior failure");

const failed = evaluateScheduler({ jobs: [{ declarationKey: "release", name: "Release gate", enabled: true, state: { lastRunStatus: "error", lastError: "timeout", consecutiveErrors: 2 } }] });
assert.equal(failed.status, "attention");
assert.deepEqual(failed.unhealthy[0], { declarationKey: "release", name: "Release gate", error: "timeout", consecutiveErrors: 2 });

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-monitor-"));
const receipt = path.join(temporary, "latest.json");
writeReceipt(receipt, { status: "healthy" });
assert.deepEqual(JSON.parse(fs.readFileSync(receipt, "utf8")), { status: "healthy" });
console.log("heartbeat monitor tests: passed");
