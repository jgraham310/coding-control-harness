#!/usr/bin/env node
/** Atomic file-backed adapter for the WorkState engine. */
import fs from "node:fs";
import path from "node:path";
import { emptyWorkStateRuntime, recordEvidence, registerWorkState, transitionWorkState, completeAction, validateWorkStateRuntime, workStateContext } from "./work-state.mjs";
const fail = (message) => { console.error(message); process.exit(2); };
const argument = (name, fallback = null) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1] ?? fail(`missing ${name}`); };
const parse = (value, name) => { try { return JSON.parse(value); } catch { fail(`${name} must be JSON`); } };
const statePath = path.resolve(argument("--state", path.join(process.cwd(), "work-state.json")));
const at = argument("--at", new Date().toISOString()); const command = process.argv[2];
function mutate(fn) { const lock = `${statePath}.lock`; let descriptor; try { fs.mkdirSync(path.dirname(statePath), { recursive: true }); descriptor = fs.openSync(lock, "wx"); const runtime = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : emptyWorkStateRuntime(); validateWorkStateRuntime(runtime); const result = fn(runtime); const temporary = `${statePath}.${process.pid}.tmp`; fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`); fs.renameSync(temporary, statePath); return result; } catch (error) { fail(error.message); } finally { if (descriptor !== undefined) fs.closeSync(descriptor); try { fs.unlinkSync(lock); } catch {} } }
let output;
if (command === "record-evidence") output = mutate((runtime) => recordEvidence(runtime, parse(argument("--receipt"), "--receipt"), at));
else if (command === "register") output = mutate((runtime) => ({ record: registerWorkState(runtime, parse(argument("--record"), "--record"), at) }));
else if (command === "transition") output = mutate((runtime) => transitionWorkState(runtime, argument("--id"), Number(argument("--expected-version")), parse(argument("--patch"), "--patch"), parse(argument("--action"), "--action"), argument("--rationale"), at));
else if (command === "complete-action") output = mutate((runtime) => ({ action: completeAction(runtime, argument("--action-id"), argument("--outcome"), argument("--evidence-id"), at) }));
else if (command === "context") { const runtime = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : emptyWorkStateRuntime(); validateWorkStateRuntime(runtime); output = workStateContext(runtime, argument("--id"), argument("--latest-evidence")); }
else fail("usage: work-state-runtime <record-evidence|register|transition|complete-action|context>");
process.stdout.write(`${JSON.stringify(output)}\n`);
