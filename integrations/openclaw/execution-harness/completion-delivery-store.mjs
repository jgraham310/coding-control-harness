import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireStateLock } from "./state-lock.mjs";

const SCHEMA_VERSION = 1;
const CLAIM_TIMEOUT_MS = 90_000;
function locked(statePath, fn) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); const release = acquireStateLock(statePath); try { return fn(); } finally { release(); } }

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, records: [] };
}

function readState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(state.records)) throw new Error("invalid schema");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new Error(`invalid completion-delivery state: ${error.message}`);
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function recoverExpiredClaims(state, now) {
  for (const record of state.records) {
    if (record.status === "claimed" && now - record.claimedAtMs >= CLAIM_TIMEOUT_MS) {
      // A timed-out send may already have reached the channel. Hold for
      // transport reconciliation rather than creating a duplicate claim.
      record.status = "uncertain";
      record.lastFailureAtMs = now;
      delete record.claimedAtMs;
    }
  }
}

export function recordCompletion({ statePath, runId, sessionKey, content, now = Date.now() }) {
  if (typeof content !== "string" || !content.trim()) return null;
  return locked(statePath, () => {
  const state = readState(statePath);
  recoverExpiredClaims(state, now);
  const id = runId || `completion-${contentHash(content).slice(0, 16)}`;
  let record = state.records.find((entry) => entry.id === id);
  if (!record) {
    record = {
      id,
      content,
      contentHash: contentHash(content),
      sessionKey: sessionKey ?? null,
      status: "pending",
      createdAtMs: now,
      attempts: 0,
    };
    state.records.push(record);
  }
  writeState(statePath, state);
  return record;
  });
}

export function acknowledgeTelegramDelivery({ statePath, content, messageId, now = Date.now() }) {
  return locked(statePath, () => {
  const state = readState(statePath);
  const hash = contentHash(content);
  let updated = 0;
  for (const record of state.records) {
    if (record.status !== "delivered" && record.contentHash === hash) {
      record.status = "delivered";
      record.deliveredAtMs = now;
      record.telegramMessageId = messageId ?? null;
      delete record.claimedAtMs;
      updated += 1;
    }
  }
  if (updated) writeState(statePath, state);
  return updated;
  });
}

export function acknowledgeCompletionDelivery({ statePath, id, messageId, now = Date.now() }) {
  return locked(statePath, () => {
  const state = readState(statePath);
  const record = state.records.find((entry) => entry.id === id);
  if (!record || record.status === "delivered") return false;
  record.status = "delivered";
  record.deliveredAtMs = now;
  record.telegramMessageId = messageId ?? null;
  delete record.claimedAtMs;
  writeState(statePath, state);
  return true;
  });
}

export function recordTelegramFailure({ statePath, content, now = Date.now() }) {
  return locked(statePath, () => {
  const state = readState(statePath);
  const hash = contentHash(content);
  let updated = 0;
  for (const record of state.records) {
    if (record.status === "claimed" && record.contentHash === hash) {
      record.status = "uncertain";
      record.lastFailureAtMs = now;
      delete record.claimedAtMs;
      updated += 1;
    }
  }
  if (updated) writeState(statePath, state);
  return updated;
  });
}

export function hasPendingDelivery({ statePath, now = Date.now() }) {
  return locked(statePath, () => {
  const state = readState(statePath);
  recoverExpiredClaims(state, now);
  const pending = state.records.some((record) => record.status === "pending");
  writeState(statePath, state);
  return pending;
  });
}

export function claimPendingDelivery({ statePath, now = Date.now() }) {
  return locked(statePath, () => {
  const state = readState(statePath);
  recoverExpiredClaims(state, now);
  const record = state.records.find((entry) => entry.status === "pending");
  if (record) {
    record.status = "claimed";
    record.claimedAtMs = now;
    record.attempts += 1;
  }
  writeState(statePath, state);
  return record ?? null;
  });
}
