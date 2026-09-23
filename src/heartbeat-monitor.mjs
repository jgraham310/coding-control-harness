#!/usr/bin/env node
// Model-free replacement for a main-session heartbeat. It records one
// idempotent scheduler-health receipt and never enters an agent session.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function evaluateScheduler(snapshot, selfDeclarationKey = "heartbeat:cos:deterministic") {
  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  const unhealthy = jobs
    .filter((job) => job?.enabled && job?.declarationKey !== selfDeclarationKey)
    .filter((job) => job?.state?.lastRunStatus === "error" || Number(job?.state?.consecutiveErrors || 0) > 0)
    .map((job) => ({
      declarationKey: job.declarationKey || job.id,
      name: job.name || job.displayName || "unnamed",
      error: job.state?.lastError || job.lastRunError || "scheduler error",
      consecutiveErrors: Number(job.state?.consecutiveErrors || 0),
    }));
  return {
    schema: "deterministic_heartbeat_receipt/v1",
    status: unhealthy.length ? "attention" : "healthy",
    checkedJobs: jobs.filter((job) => job?.enabled && job?.declarationKey !== selfDeclarationKey).length,
    unhealthy,
  };
}

export function writeReceipt(file, receipt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function main() {
  const root = process.env.HEARTBEAT_MONITOR_ROOT || path.resolve(process.cwd(), ".runtime/heartbeat-cos");
  const receiptFile = path.join(root, "latest.json");
  const snapshot = process.argv[2]
    ? JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
    : JSON.parse(execFileSync(process.env.OPENCLAW_BIN || "openclaw", ["cron", "list", "--json"], { encoding: "utf8", timeout: 15000 }));
  const receipt = {
    ...evaluateScheduler(snapshot),
    observedAt: new Date().toISOString(),
    monitor: "heartbeat-cos-deterministic",
  };
  writeReceipt(receiptFile, receipt);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status !== "healthy") process.exitCode = 2;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
