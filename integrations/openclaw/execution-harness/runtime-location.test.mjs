import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "execution-harness-location-"));
const ledger = path.join(runtime, "promise-ledger.json");
const observed = JSON.parse(execFileSync("node", [path.join(here, "promise-ledger.mjs"), "status"], {
  env: { ...process.env, PROMISE_LEDGER_STATE: ledger }, encoding: "utf8"
}));
assert.equal(Array.isArray(observed.promises), true);
assert.equal(fs.existsSync(ledger), false, "read-only status must not create a runtime ledger in the repository");
assert.equal(fs.existsSync(path.join(here, "promise-ledger.json")), false, "runtime ledger must not live beside repository source");
fs.mkdirSync(`${ledger}.lockdir`);
fs.writeFileSync(path.join(`${ledger}.lockdir`, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
assert.throws(() => execFileSync("node", [path.join(here, "promise-ledger.mjs"), "status", "--state", ledger], { encoding: "utf8", stdio: "pipe" }), /State is busy/);
fs.rmSync(`${ledger}.lockdir`, { recursive: true });
fs.mkdirSync(`${ledger}.lockdir`);
fs.writeFileSync(path.join(`${ledger}.lockdir`, "owner.json"), JSON.stringify({ pid: 99999999, token: "dead" }));
execFileSync("node", [path.join(here, "promise-ledger.mjs"), "status", "--state", ledger], { encoding: "utf8" });
assert.equal(fs.existsSync(`${ledger}.lockdir`), false, "dead-owner lock is recovered");
console.log("execution harness runtime-location test: passed");
