import fs from "node:fs";
import path from "node:path";

export const commitmentLanguage = /\b(?:i|we)\s+(?:will|shall|promise|commit|intend|plan|expect|am going to|are going to|am resuming|are resuming)\b|\b(?:next update|within\s+\d|by\s+(?:\d|tomorrow|tonight|end of day|eod)|keep you updated)\b/i;
export const markerPattern = /\s*\[\[promise-ledger:([a-z0-9][a-z0-9._-]*)\]\]\s*/ig;
export const receiptPattern = /\s*\[\[execution-receipt:([a-z0-9][a-z0-9._-]*)\]\]\s*/ig;

function loadLedger(ledgerPath) {
  const state = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  if (state?.schemaVersion !== 1 || !Array.isArray(state.promises)) {
    throw new Error("invalid Promise Ledger schema");
  }
  return state;
}

function activeReceipt(state, id) {
  const record = state.promises.find((item) => item?.id === id);
  // Registering a promise is not evidence that the solution was started. A
  // receipt exists only after its resolver has recorded observed progress.
  return record && ["active", "breached", "completed"].includes(record.status) && typeof record.lastUpdateEvidence === "string" && record.lastUpdateEvidence.trim()
    ? record
    : null;
}

function executionReceipt(executionReceiptPath, id) {
  if (!executionReceiptPath || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return null;
  const root = path.resolve(executionReceiptPath);
  const candidate = path.resolve(root, `${id}.json`);
  if (path.dirname(candidate) !== root) return null;
  try {
    const record = JSON.parse(fs.readFileSync(candidate, "utf8"));
    if (record?.receiptId !== id || typeof record.recordedAt !== "string" || !record.recordedAt.trim()) return null;
    return record;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function receiptContext(ledgerPath, executionReceiptPath = null, receiptIds = []) {
  const state = loadLedger(ledgerPath);
  const promises = state.promises
    .map((record) => ({
      id: record?.id,
      status: record?.status,
      deliverable: record?.deliverable,
      successPredicate: record?.successPredicate,
      evidence: record?.lastUpdateEvidence ?? record?.evidence ?? null,
    }))
    .filter((record) => record.id && record.evidence && ["active", "breached", "completed"].includes(record.status));
  const requested = [...new Set(receiptIds)].sort();
  const executionReceipts = requested
    .map((id) => executionReceipt(executionReceiptPath, id))
    .filter(Boolean)
    .map((record) => ({
      id: record.receiptId,
      status: "recorded",
      deliverable: record.scope ?? null,
      successPredicate: null,
      evidence: record,
    }));
  return [...promises, ...executionReceipts];
}

export function gateOutboundMessage(params, { ledgerPath, executionReceiptPath = null, agentId, semanticVerdict = null }) {
  if (params.action && params.action !== "send") return { allow: true };
  if (!agentId || agentId !== "cos") return { allow: true };
  const message = typeof params.message === "string" ? params.message : "";
  const markerIds = [...message.matchAll(markerPattern)].map((match) => match[1]);
  const receiptIds = [...message.matchAll(receiptPattern)].map((match) => match[1]);
  const detectsCommitment = commitmentLanguage.test(message);

  let state;
  try {
    state = loadLedger(ledgerPath);
  } catch (error) {
    return { block: true, reason: `Outbound semantic gate blocked: Promise Ledger unavailable (${error.message}).` };
  }

  if (!semanticVerdict || typeof semanticVerdict.actionable !== "boolean" || !["completed", "active_closure", "jason_decision", "non_operational"].includes(semanticVerdict.terminal_state) || !Array.isArray(semanticVerdict.receipt_ids)) {
    return { block: true, reason: "Outbound semantic gate blocked: no valid semantic review verdict." };
  }
  if (!detectsCommitment && markerIds.length > 0) {
    return { block: true, reason: "Promise Ledger markers are permitted only in messages containing a future commitment." };
  }
  if (detectsCommitment && markerIds.length !== 1) {
    return { block: true, reason: "Outbound commitment blocked: include exactly one [[promise-ledger:<active-id>]] marker." };
  }
  if (detectsCommitment) {
    const record = state.promises.find((item) => item?.id === markerIds[0]);
    if (!record || !["active", "breached"].includes(record.status)) {
      return { block: true, reason: "Outbound commitment blocked: the cited Promise Ledger record is not active." };
    }
  }

  const verdictReceiptIds = [...new Set(semanticVerdict.receipt_ids)].sort();
  const markedReceiptIds = [...new Set(receiptIds)].sort();
  if (semanticVerdict.terminal_state === "active_closure" && verdictReceiptIds.length === 0) {
    return { block: true, reason: "Outbound status blocked: an active closure requires an [[execution-receipt:<id>]] marker backed by observed progress." };
  }
  if (!semanticVerdict.actionable && semanticVerdict.terminal_state !== "active_closure" && markedReceiptIds.length > 0) {
    return { block: true, reason: "Execution-receipt markers are permitted only when the semantic review finds an actionable solution." };
  }
  if (semanticVerdict.actionable || semanticVerdict.terminal_state === "active_closure") {
    if (markedReceiptIds.length === 0) {
      return { block: true, reason: semanticVerdict.terminal_state === "active_closure"
        ? "Outbound status blocked: an active closure requires an [[execution-receipt:<id>]] marker."
        : "Outbound solution blocked: semantic review found an actionable solution without an [[execution-receipt:<id>]] marker." };
    }
    if (JSON.stringify(markedReceiptIds) !== JSON.stringify(verdictReceiptIds)) {
      return { block: true, reason: "Outbound solution blocked: execution-receipt markers do not match the semantic review verdict." };
    }
    const missing = markedReceiptIds.find((id) => !activeReceipt(state, id) && !executionReceipt(executionReceiptPath, id));
    if (missing) {
      return { block: true, reason: `Outbound solution blocked: execution receipt ${missing} has no recorded observed progress.` };
    }
  }

  const cleanMessage = message.replace(markerPattern, " ").replace(receiptPattern, " ").replace(/\s{2,}/g, " ").trim();
  return { allow: true, params: { ...params, message: cleanMessage } };
}
