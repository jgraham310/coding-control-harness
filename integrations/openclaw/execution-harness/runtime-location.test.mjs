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
console.log("execution harness runtime-location test: passed");
