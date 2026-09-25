#!/usr/bin/env node
/** File-backed, lock-protected WorkState runtime. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completeAction, emptyRuntime, recordEvidence, registerWorkState, transitionWorkState, validateRuntime, workStateContext } from "./work-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback = null) { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1] ?? fail(`Missing ${name}.`); }
function fail(message) { console.error(message); process.exit(2); }
function json(value, name) { try { return JSON.parse(value); } catch { fail(`${name} must be valid JSON.`); } }
function now() { return arg("--at", new Date().toISOString()); }
function load(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : emptyRuntime(); }
function save(file, value) { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(temp, file); }
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function locked(file, fn) {
  const lock = `${file}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lock, "wx"); }
  catch { fail(`WorkState runtime is busy: ${lock}`); }
  try {
    const runtime = load(file);
    validateRuntime(runtime);
    const result = fn(runtime);
    save(file, runtime);
    return result;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(lock); } catch {}
  }
}

const command = process.argv[2];
const stateFile = path.resolve(arg("--state", path.join(here, "work-state.json")));
const at = now();
if (command === "register") {
  const input = json(arg("--record"), "--record");
  print({ record: locked(stateFile, (runtime) => registerWorkState(runtime, input, at)) });
} else if (command === "record-evidence") {
  const receipt = json(arg("--receipt"), "--receipt");
  print(locked(stateFile, (runtime) => recordEvidence(runtime, receipt, at)));
} else if (command === "transition") {
  const id = arg("--id");
  const version = Number(arg("--expected-version"));
  const patch = json(arg("--patch"), "--patch");
  const action = json(arg("--action"), "--action");
  const rationale = arg("--rationale");
  print(locked(stateFile, (runtime) => transitionWorkState(runtime, id, version, patch, action, rationale, at)));
} else if (command === "complete-action") {
  print(locked(stateFile, (runtime) => ({ action: completeAction(runtime, arg("--action-id"), arg("--outcome"), arg("--evidence-ref"), at) })));
} else if (command === "context") {
  const runtime = load(stateFile);
  validateRuntime(runtime);
  print(workStateContext(runtime, arg("--id"), arg("--latest-evidence")));
} else if (command === "status") {
  const runtime = load(stateFile);
  validateRuntime(runtime);
  print(runtime);
} else {
  fail("Usage: work-state-runtime.mjs <register|record-evidence|transition|complete-action|context|status> [options]");
}
