import crypto from "node:crypto";

export const STATUS_CLAIM_TTL_MS = 5 * 60 * 1000;
export const STATUS_CLAIM_MARKER = /\[\[status-claim:([a-f0-9]{32})\]\]/i;

/** Create one bounded, evidence-backed status-delivery capability. */
export function admitStatusClaim({ content, verified, now = Date.now(), token = crypto.randomUUID().replaceAll("-", ""), ttlMs = STATUS_CLAIM_TTL_MS }, store = new Map()) {
  if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error("status claim token must be 32 hexadecimal characters");
  store.set(token, { content, verified: verified === true, expiresAt: now + ttlMs });
  return { marker: `[[status-claim:${token}]]`, expiresAt: now + ttlMs, store };
}

/** Fail closed only for explicitly tagged automated delivery; ordinary messages never enter this gate. */
export function gateStatusClaim(content, { now = Date.now(), store = new Map() } = {}) {
  const match = String(content ?? "").match(STATUS_CLAIM_MARKER);
  if (!match) return { content };
  const receipt = store.get(match[1]);
  if (receipt?.verified === true && receipt.expiresAt > now) return { content: receipt.content };
  return { cancel: true, cancelReason: "Status claim receipt missing, expired, or not admitted." };
}
