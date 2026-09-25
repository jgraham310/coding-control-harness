#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { acknowledgeCompletionDelivery, claimPendingDelivery, hasPendingDelivery, recordTelegramFailure } from "./completion-delivery-store.mjs";

const statePath = process.env.COMPLETION_DELIVERY_STATE
  ?? "/Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/completion-delivery.json";
const command = process.argv[2];

function isProceduralPlaceholder(content) {
  const normalized = String(content ?? "")
    .replace(/[*_`#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "");
  return new Set([
    "no jason-only authority is required",
    "no jason-only authority is needed",
    "no jason-only decision is required",
    "no jason-only decision is needed",
  ]).has(normalized);
}

if (command === "has-pending") {
  process.stdout.write(JSON.stringify({ pending: hasPendingDelivery({ statePath }) }));
} else if (command === "claim") {
  process.stdout.write(JSON.stringify({ record: claimPendingDelivery({ statePath }) }));
} else if (command === "deliver") {
  const record = claimPendingDelivery({ statePath });
  if (!record) {
    process.stdout.write(JSON.stringify({ delivered: false, reason: "no-pending-record" }));
  } else if (isProceduralPlaceholder(record.content)) {
    acknowledgeCompletionDelivery({ statePath, id: record.id, messageId: "suppressed-procedural-placeholder" });
    process.stdout.write(JSON.stringify({ delivered: false, id: record.id, reason: "suppressed-procedural-placeholder" }));
  } else {
    try {
      const output = execFileSync("openclaw", [
        "message", "send", "--channel", "telegram", "--target", "8334862495",
        "--message", record.content, "--json",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      let response = null;
      try { response = JSON.parse(output); } catch { /* successful CLI exit is the delivery receipt */ }
      acknowledgeCompletionDelivery({ statePath, id: record.id, messageId: response?.messageId ?? response?.id ?? null });
      process.stdout.write(JSON.stringify({ delivered: true, id: record.id }));
    } catch (error) {
      recordTelegramFailure({ statePath, content: record.content });
      throw new Error(`Telegram completion delivery failed for ${record.id}: ${error.stderr?.toString().trim() || error.message}`);
    }
  }
} else {
  throw new Error("usage: completion-delivery.mjs has-pending|claim|deliver");
}
