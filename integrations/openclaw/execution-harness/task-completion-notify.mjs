#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const taskDir = process.env.TASK_COMPLETION_DIR ?? "/Users/jasongraham/.openclaw/state/long-tasks/tasks/task-completion-control-20260920";
const gatesPath = path.join(taskDir, "GATES.md");
const statePath = path.join(taskDir, "completion-notification.json");
const target = "7c7da792-adaf-4f0f-9e2d-f15302a31482";
const now = () => new Date().toISOString();

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function atomicWrite(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function remainingGates(text) {
  return text.split("\n").filter((line) => /^- \[ \]/.test(line) && !/direct Signal completion message/.test(line));
}
function completeNotificationGate(text) {
  return text.replace(/^- \[ \] When every prior gate has verified evidence, send Jason one direct Signal completion message; do not send a completion claim earlier\.$/m,
    "- [x] When every prior gate has verified evidence, send Jason one direct Signal completion message; do not send a completion claim earlier.\n  EVIDENCE: host completion watcher transport receipt recorded.");
}

const current = readJson(statePath, { schema: "task_completion_notification/v1", state: "waiting" });
if (current.state === "sent") {
  console.log(JSON.stringify({ state: "sent", receipt: current.receipt }));
  process.exit(0);
}
if (current.state === "send_started" || current.state === "uncertain") {
  console.log(JSON.stringify({ state: "uncertain", reason: "prior send may have reached Signal without a stored transport receipt; refusing duplicate notification" }));
  process.exit(2);
}

const gates = fs.readFileSync(gatesPath, "utf8");
const remaining = remainingGates(gates);
if (remaining.length > 0) {
  console.log(JSON.stringify({ state: "waiting", remainingGates: remaining.length }));
  process.exit(0);
}

atomicWrite(statePath, { schema: "task_completion_notification/v1", state: "send_started", startedAt: now() });
const message = "Task-completion control system is complete. All implementation, integration, review, and notification gates have verified evidence; the seven-day shadow report is armed.";
const result = spawnSync("/opt/homebrew/bin/openclaw", ["message", "send", "--channel", "signal", "--account", "default", "--target", target, "--message", message, "--json"], { encoding: "utf8", timeout: 30000 });
if (result.status !== 0) {
  atomicWrite(statePath, { schema: "task_completion_notification/v1", state: "uncertain", startedAt: readJson(statePath, {}).startedAt, observedAt: now(), reason: String(result.stderr || result.stdout).slice(0, 1000) });
  console.error(result.stderr || result.stdout);
  process.exit(result.status || 1);
}
let receipt;
try { receipt = JSON.parse(result.stdout); } catch { receipt = { raw: result.stdout.trim() }; }
atomicWrite(statePath, { schema: "task_completion_notification/v1", state: "sent", startedAt: readJson(statePath, {}).startedAt, sentAt: now(), receipt });
fs.writeFileSync(gatesPath, completeNotificationGate(gates));
console.log(JSON.stringify({ state: "sent", receipt }));
