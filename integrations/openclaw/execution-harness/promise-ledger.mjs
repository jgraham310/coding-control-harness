#!/usr/bin/env node
/**
 * Durable, model-free promise ledger for outbound agent commitments.
 *
 * The delivery gateway must call `preflight-send` before sending any message.
 * This program never sends a message itself; it proves whether a proposed
 * message is permitted and emits durable update/overdue events for a resolver.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireStateLock } from "./state-lock.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultState = process.env.PROMISE_LEDGER_STATE || path.join(here, "promise-ledger.json");
const statuses = new Set(["active", "breached", "completed", "cancelled"]);
const classifications = new Set(["commitment", "noncommitment", "remedy"]);
const commitmentLanguage = /\b(?:i|we)\s+(?:will|shall|promise|commit|intend|plan|expect|am going to|are going to|am resuming|are resuming)\b|\b(?:next update|within\s+\d|by\s+(?:\d|tomorrow|tonight|end of day|eod)|keep you updated)\b/i;
// Advice and analysis are not execution claims.  This companion gate only
// recognizes a remedy when the sender represents that it has actually begun
// or completed the corrective work.  The semantic delivery gate handles the
// contextual distinction; keeping this pattern narrow prevents an ordinary
// opinion (for example, “the best fix is …”) from being treated as a promise.
const remedyLanguage = /\b(?:i|we)\s+(?:have|has|already|just|now)\s+(?:fixed|implemented|created|installed|dispatched|remediated)\b/i;

function fail(message) { console.error(message); process.exit(2); }
function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fail(`Missing value for ${name}.`));
}
function flag(name) { return process.argv.includes(name); }
function at() { return arg("--at", new Date().toISOString()); }
function iso(value, label) {
  if (!value || Number.isNaN(Date.parse(value))) fail(`${label} must be an ISO-8601 timestamp.`);
  return value;
}
function read(file) {
  if (!fs.existsSync(file)) return { schemaVersion: 1, promises: [], events: [] };
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Unable to read promise ledger: ${error.message}`); }
}
function validate(state) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.promises) || !Array.isArray(state.events)) fail("Invalid promise ledger schema.");
  const ids = new Set();
  for (const item of state.promises) {
    if (!item.id || ids.has(item.id) || !item.owner || !item.deliverable || !item.successPredicate || !item.escalation || !statuses.has(item.status)) fail("Invalid promise record.");
    ids.add(item.id);
    iso(item.dueAt, `Promise ${item.id} dueAt`);
    // Completed historical records intentionally retire their resolver and
    // update deadline.  Active/breached records must retain both fields.
    if (item.status !== "completed" && item.status !== "cancelled") {
      iso(item.updateDueAt, `Promise ${item.id} updateDueAt`);
      if (!item.resolver?.jobId || !item.resolver?.cadence) fail(`Promise ${item.id} has no resolver.`);
    }
  }
  return state;
}
function save(file, state) {
  state.updatedAt = new Date().toISOString();
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function promise(state, id) {
  const item = state.promises.find((candidate) => candidate.id === id);
  if (!item) fail(`Unknown promise ${id}.`);
  return item;
}
function active(item) { return item.status === "active" || item.status === "breached"; }
function event(state, item, kind, dueAt, observedAt) {
  const id = `${item.id}:${kind}:${dueAt}`;
  let record = state.events.find((candidate) => candidate.id === id);
  if (!record) {
    record = { id, promiseId: item.id, kind, dueAt, observedAt, notification: "pending" };
    state.events.push(record);
  }
  return record;
}
function ids(value) { return value.split(",").map((item) => item.trim()).filter(Boolean); }

const command = process.argv[2];
const stateFile = arg("--state", defaultState);
acquireStateLock(stateFile);
const state = validate(read(stateFile));

if (command === "register") {
  const id = arg("--id");
  const owner = arg("--owner");
  const deliverable = arg("--deliverable");
  const dueAt = iso(arg("--due"), "--due");
  const updateDueAt = iso(arg("--update-due"), "--update-due");
  const successPredicate = arg("--success-predicate");
  const resolverJobId = arg("--resolver-job-id");
  const resolverCadence = arg("--resolver-cadence");
  const escalation = arg("--escalation");
  const observedAt = at();
  iso(observedAt, "--at");
  if (!id || !owner || !deliverable || !successPredicate || !resolverJobId || !resolverCadence || !escalation) fail("register requires id, owner, deliverable, due, update-due, success-predicate, resolver-job-id, resolver-cadence, and escalation.");
  if (state.promises.some((item) => item.id === id)) fail(`Promise ${id} already exists.`);
  if (Date.parse(updateDueAt) < Date.parse(observedAt) && !flag("--allow-overdue")) fail("--update-due is already overdue; use --allow-overdue to record a breached legacy promise explicitly.");
  const status = Date.parse(dueAt) <= Date.parse(observedAt) ? "breached" : "active";
  const item = { id, owner, deliverable, dueAt, updateDueAt, successPredicate, resolver: { jobId: resolverJobId, cadence: resolverCadence }, escalation, status, createdAt: observedAt, completedAt: null, evidence: null };
  state.promises.push(item);
  if (status === "breached") event(state, item, "promise_due", dueAt, observedAt);
  save(stateFile, state);
  print({ promise: item, pendingEvents: state.events.filter((item) => item.notification === "pending") });
} else if (command === "preflight-send") {
  const message = arg("--message");
  const classification = arg("--classification");
  const promiseIds = ids(arg("--promise-ids", ""));
  const remedyReceipt = arg("--remedy-receipt", "");
  if (!message || !classifications.has(classification)) fail("preflight-send requires --message and --classification commitment|noncommitment|remedy.");
  const detected = commitmentLanguage.test(message);
  const detectedRemedy = remedyLanguage.test(message);
  if (detected && classification !== "commitment") fail("Potential commitment language requires --classification commitment and an active promise ID.");
  if (detectedRemedy && classification !== "remedy") fail("Actionable remedy language requires --classification remedy and a recorded execution receipt.");
  if (classification === "commitment" && promiseIds.length === 0) fail("A commitment message requires --promise-ids.");
  if (classification === "remedy" && !remedyReceipt.trim()) fail("A remedy message requires --remedy-receipt proving the in-scope corrective action was created before reporting it.");
  if (classification === "remedy" && promiseIds.length > 0) fail("A remedy message records its execution receipt directly; do not attach promise IDs.");
  if (classification === "noncommitment" && promiseIds.length > 0) fail("A noncommitment message must not carry promise IDs.");
  const referenced = promiseIds.map((id) => promise(state, id));
  if (referenced.some((item) => !active(item))) fail("A commitment message may reference only active or breached promises.");
  print({ authorized: true, classification, promiseIds, detectedCommitmentLanguage: detected, detectedRemedyLanguage: detectedRemedy, remedyReceipt: classification === "remedy" ? remedyReceipt : null });
} else if (command === "watch") {
  const observedAt = at();
  iso(observedAt, "--at");
  for (const item of state.promises.filter(active)) {
    if (Date.parse(item.dueAt) <= Date.parse(observedAt)) {
      item.status = "breached";
      event(state, item, "promise_due", item.dueAt, observedAt);
    }
    if (Date.parse(item.updateDueAt) <= Date.parse(observedAt)) event(state, item, "promise_update_due", item.updateDueAt, observedAt);
  }
  if (flag("--apply")) save(stateFile, state);
  print({ at: observedAt, pendingEvents: state.events.filter((item) => item.notification === "pending") });
} else if (command === "record-update") {
  const item = promise(state, arg("--id"));
  const evidence = arg("--evidence");
  const nextUpdateDueAt = iso(arg("--next-update-due"), "--next-update-due");
  const observedAt = at();
  iso(observedAt, "--at");
  if (!active(item) || !evidence.trim()) fail("record-update requires an active promise and non-empty evidence.");
  if (Date.parse(nextUpdateDueAt) <= Date.parse(observedAt)) fail("--next-update-due must be in the future.");
  for (const pending of state.events.filter((event) => event.promiseId === item.id && event.notification === "pending")) {
    pending.notification = "sent";
    pending.acknowledgedAt = observedAt;
    pending.evidence = evidence;
  }
  item.updateDueAt = nextUpdateDueAt;
  item.lastUpdateAt = observedAt;
  item.lastUpdateEvidence = evidence;
  save(stateFile, state);
  print({ promise: item });
} else if (command === "complete") {
  const item = promise(state, arg("--id"));
  const evidence = arg("--evidence");
  const observedAt = at();
  iso(observedAt, "--at");
  if (!active(item) || !evidence.trim()) fail("complete requires an active promise and non-empty verification evidence.");
  item.status = "completed";
  item.completedAt = observedAt;
  item.evidence = evidence;
  for (const pending of state.events.filter((event) => event.promiseId === item.id && event.notification === "pending")) {
    pending.notification = "sent";
    pending.acknowledgedAt = observedAt;
    pending.evidence = `Closed with evidence: ${evidence}`;
  }
  save(stateFile, state);
  print({ promise: item });
} else if (command === "status") {
  print({ promises: state.promises, pendingEvents: state.events.filter((item) => item.notification === "pending") });
} else {
  fail("Usage: promise-ledger.mjs <register|preflight-send|watch|record-update|complete|status> [options]");
}
