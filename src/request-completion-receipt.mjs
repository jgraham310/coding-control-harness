#!/usr/bin/env node
/**
 * Versioned engineering completion receipt adapter.
 *
 * A Henry engineering request may only be closed by a typed receipt that is
 * bound to one request, one work item, one repository and one exact reviewed
 * head, carries named deterministic test evidence at that head, and has been
 * confirmed by a verifier that is not the executor.  Everything else -- a
 * generic agent assertion, a stale head, a queued run, an uncertain transport,
 * a replay, a concurrent publisher -- holds or dedupes and never closes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const RECEIPT_SCHEMA = 'engineering_completion_receipt/v1';
export const LEDGER_SCHEMA = 'engineering_completion_ledger/v1';
export const CONTRACT_VERSION = '1.0.0';
export const OUTCOMES = new Set(['completed', 'failed', 'blocked', 'uncertain']);
export const TEST_STATUSES = new Set(['passed', 'failed', 'skipped', 'queued', 'unknown']);
export const TRANSPORTS = new Set(['confirmed', 'uncertain', 'failed']);

/** Durable placement receipt for this control (issue #8). */
export const PLACEMENT_RECEIPT = Object.freeze({
  owner: 'coding-control-harness',
  enforcement: 'typed receipt producer and independent-verification contract',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, held reasons, and explicit non-completion outcomes',
});

const SENSITIVE_KEY = /(token|secret|password|passwd|credential|authorization|api[-_]?key|private[-_]?key|cookie|session)/i;
const RAW_LOG_KEY = /^(log|logs|rawLog|stdout|stderr|output|transcript)$/i;
const SENSITIVE_VALUE = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{16,}|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]{12,}/;

const fail = (message) => { throw new Error(message); };
const text = (value, name) => (typeof value === 'string' && value.trim() ? value.trim() : fail(`${name} must be a non-empty string`));
const stable = (value) => (Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function receiptDigest(receipt) {
  const { digest, ...body } = receipt;
  return `sha256:${sha256(JSON.stringify(stable(body)))}`;
}

function headSha(value) {
  const sha = text(value, 'headSha').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('headSha must be a full 40-character commit sha');
  return sha;
}

function normalizeTests(tests) {
  if (!Array.isArray(tests)) fail('tests must be an array');
  return tests
    .map((entry) => ({
      name: text(entry?.name, 'test.name'),
      command: text(entry?.command, 'test.command'),
      status: TEST_STATUSES.has(entry?.status) ? entry.status : fail(`invalid test status ${entry?.status}`),
      headSha: headSha(entry?.headSha),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeRecovery(recovery) {
  return {
    reason: text(recovery?.reason, 'recovery.reason'),
    nextAction: text(recovery?.nextAction, 'recovery.nextAction'),
    escalation: text(recovery?.escalation, 'recovery.escalation'),
  };
}

/**
 * Drop credential-shaped fields, replace raw logs with a digest handle, and
 * reduce any credential-shaped string to a handle wherever it is nested --
 * including inside arrays, which is exactly where a leak hides.
 */
export function redactEvidence(value) {
  if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) return `redacted:sha256:${sha256(value)}`;
  if (Array.isArray(value)) return value.map(redactEvidence);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (SENSITIVE_KEY.test(key)) continue;
    const entry = value[key];
    if (RAW_LOG_KEY.test(key)) { out[`${key}Digest`] = `sha256:${sha256(JSON.stringify(entry ?? null))}`; continue; }
    out[key] = redactEvidence(entry);
  }
  return out;
}

/** Findings a Henry-side consumer would reject the receipt for. */
export function redactionFindings(value, trail = 'receipt') {
  if (Array.isArray(value)) return value.flatMap((entry, index) => redactionFindings(entry, `${trail}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.keys(value).flatMap((key) => {
      const at = `${trail}.${key}`;
      if (SENSITIVE_KEY.test(key)) return [`${at} exposes a credential field`];
      if (RAW_LOG_KEY.test(key)) return [`${at} exposes a raw private log`];
      return redactionFindings(value[key], at);
    });
  }
  if (typeof value === 'string' && SENSITIVE_VALUE.test(value)) return [`${trail} contains a credential-shaped value`];
  return [];
}

/** Build a typed receipt.  Claimed completion is not acceptance; see evaluateReceipt. */
export function buildReceipt(input) {
  const outcome = OUTCOMES.has(input?.outcome) ? input.outcome : fail(`invalid outcome ${input?.outcome}`);
  const body = {
    schema: RECEIPT_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    henryRequestId: text(input.henryRequestId, 'henryRequestId'),
    workItemId: text(input.workItemId, 'workItemId'),
    repository: text(input.repository, 'repository'),
    headSha: headSha(input.headSha),
    outcome,
    executor: text(input.executor, 'executor'),
    producedAt: text(input.producedAt, 'producedAt'),
    tests: normalizeTests(input.tests ?? []),
    evidence: redactEvidence(input.evidence ?? {}),
    // Invariant 4: a non-completion is only publishable with recovery metadata.
    recovery: outcome === 'completed' ? null : normalizeRecovery(input.recovery),
  };
  return { ...body, digest: receiptDigest(body) };
}

/**
 * Independent verification.  The verifier recomputes the digest and re-checks
 * the head binding from the receipt alone; it never trusts the executor's claim.
 */
export function verifyIndependently(receipt, { verifierId, at }) {
  const id = text(verifierId, 'verifierId');
  const recomputed = receiptDigest(receipt);
  const bound = Array.isArray(receipt?.tests)
    && receipt.tests.length > 0
    && receipt.tests.every((entry) => entry.headSha === receipt.headSha && entry.status === 'passed');
  return {
    verifierId: id,
    verifiedAt: text(at, 'verifiedAt'),
    headSha: receipt?.headSha ?? null,
    receiptDigest: recomputed,
    result: recomputed === receipt?.digest && bound ? 'verified' : 'rejected',
  };
}

/** Decide whether a receipt may close its Henry request.  Reasons are stable and sorted. */
export function evaluateReceipt(receipt, { expected, verification, transport = 'confirmed' } = {}) {
  const reasons = [];
  if (receipt?.schema !== RECEIPT_SCHEMA) reasons.push('schema-mismatch');
  if (receipt?.contractVersion !== CONTRACT_VERSION) reasons.push('contract-version-mismatch');
  if (receipt?.digest !== receiptDigest(receipt ?? {})) reasons.push('digest-mismatch');

  // The binding is supplied by the request, not the receipt: an absent expectation
  // is a hold, never an implicit match.
  if (!expected?.henryRequestId || !expected?.workItemId || !expected?.repository || !expected?.headSha) reasons.push('expected-binding-missing');
  if (expected?.henryRequestId && receipt?.henryRequestId !== expected.henryRequestId) reasons.push('request-id-mismatch');
  if (expected?.workItemId && receipt?.workItemId !== expected.workItemId) reasons.push('work-item-mismatch');
  if (expected?.repository && receipt?.repository !== expected.repository) reasons.push('repository-mismatch');
  if (expected?.headSha && receipt?.headSha !== expected.headSha) reasons.push('stale-head');

  if (receipt?.outcome !== 'completed') reasons.push('non-completion-outcome');
  const tests = Array.isArray(receipt?.tests) ? receipt.tests : [];
  if (!tests.length) reasons.push('missing-test-evidence');
  if (tests.some((entry) => entry.status !== 'passed')) reasons.push('test-not-passed');
  if (tests.some((entry) => entry.headSha !== receipt?.headSha)) reasons.push('test-evidence-off-head');

  if (!verification) reasons.push('verification-missing');
  else {
    if (verification.result !== 'verified') reasons.push('verification-not-verified');
    if (!verification.verifierId || verification.verifierId === receipt?.executor) reasons.push('verifier-not-independent');
    if (verification.headSha !== receipt?.headSha) reasons.push('verification-head-mismatch');
    if (verification.receiptDigest !== receipt?.digest) reasons.push('verification-digest-mismatch');
  }

  if (!TRANSPORTS.has(transport)) reasons.push('invalid-transport');
  else if (transport !== 'confirmed') reasons.push(`transport-${transport}`);

  reasons.push(...redactionFindings(receipt).map(() => 'sensitive-content'));
  const unique = [...new Set(reasons)].sort();
  return { accepted: unique.length === 0, reasons: unique };
}

export function emptyLedger() { return { schema: LEDGER_SCHEMA, contractVersion: CONTRACT_VERSION, receipts: {}, holds: [] }; }

export function validateLedger(ledger) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA || !ledger.receipts || !Array.isArray(ledger.holds)) fail('invalid completion ledger');
  return ledger;
}

/**
 * Publish into the ledger.  Uniqueness is per Henry request, so a replay of the
 * same receipt dedupes and a different receipt for an already-closed request is
 * held rather than creating a second completion.
 */
export function publishReceipt(ledger, receipt, context = {}) {
  validateLedger(ledger);
  const requestId = text(receipt?.henryRequestId, 'henryRequestId');
  const { accepted, reasons } = evaluateReceipt(receipt, context);
  const at = text(context.at ?? receipt?.producedAt, 'at');
  const existing = ledger.receipts[requestId] ?? null;

  if (!accepted) {
    const hold = { at, henryRequestId: requestId, digest: receipt?.digest ?? null, outcome: receipt?.outcome ?? null, reasons, recovery: receipt?.recovery ?? null };
    const duplicate = ledger.holds.find((entry) => entry.digest === hold.digest && entry.henryRequestId === requestId && String(entry.reasons) === String(reasons));
    const holds = duplicate ? ledger.holds : [...ledger.holds, hold];
    return { ledger: { ...ledger, holds }, decision: duplicate ? 'deduplicated_hold' : 'held', closesHenryRequest: false, reasons, entry: duplicate ?? hold };
  }
  if (existing && existing.digest === receipt.digest) {
    return { ledger, decision: 'deduplicated', closesHenryRequest: true, reasons: [], entry: existing };
  }
  if (existing) {
    const hold = { at, henryRequestId: requestId, digest: receipt.digest, outcome: receipt.outcome, reasons: ['duplicate-completion-conflict'], recovery: null };
    return { ledger: { ...ledger, holds: [...ledger.holds, hold] }, decision: 'held', closesHenryRequest: false, reasons: hold.reasons, entry: hold };
  }
  const entry = { ...receipt, acceptedAt: at, verification: context.verification, transport: context.transport ?? 'confirmed' };
  return { ledger: { ...ledger, receipts: { ...ledger.receipts, [requestId]: entry } }, decision: 'accepted', closesHenryRequest: true, reasons: [], entry };
}

// ---------------------------------------------------------------- file adapter

// ponytail: exclusive-create lock with a bounded spin. Fine for a handful of
// publishers; swap for a real queue if concurrent publishers ever exceed that.
// The shape hooks let a sibling ledger (execution-loop receipts) reuse the lock
// without a second copy of it.
export function withLedgerLock(ledgerPath, fn, { empty = emptyLedger, validate = validateLedger } = {}) {
  ledgerPath = path.resolve(ledgerPath);
  const lock = `${ledgerPath}.lock`;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  let descriptor;
  for (let attempt = 0; attempt < 200 && descriptor === undefined; attempt += 1) {
    try { descriptor = fs.openSync(lock, 'wx'); } catch { Atomics.wait(sleeper, 0, 0, 25); }
  }
  if (descriptor === undefined) fail(`could not acquire completion ledger lock at ${lock}`);
  try {
    const ledger = fs.existsSync(ledgerPath) ? validate(JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))) : empty();
    const result = fn(ledger);
    const temporary = `${ledgerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(result.ledger, null, 2)}\n`);
    fs.renameSync(temporary, ledgerPath);
    return result;
  } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(lock); } catch {}
  }
}

export function publishToLedgerFile(ledgerPath, receipt, context) {
  return withLedgerLock(ledgerPath, (ledger) => publishReceipt(ledger, receipt, context));
}

export function readLedgerFile(ledgerPath, { empty = emptyLedger, validate = validateLedger } = {}) {
  const resolved = path.resolve(ledgerPath);
  return fs.existsSync(resolved) ? validate(JSON.parse(fs.readFileSync(resolved, 'utf8'))) : empty();
}

function cli() {
  const argument = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fail(`missing ${name}`);
  };
  const command = process.argv[2];
  const ledgerPath = text(argument('--ledger'), '--ledger');
  let out;
  if (command === 'publish') {
    const receipt = JSON.parse(text(argument('--receipt'), '--receipt'));
    const context = JSON.parse(argument('--context', '{}'));
    const { ledger, ...result } = publishToLedgerFile(ledgerPath, receipt, context);
    out = result;
  } else if (command === 'read') {
    out = readLedgerFile(ledgerPath);
  } else {
    fail('usage: request-completion-receipt.mjs <publish|read> --ledger PATH [--receipt JSON] [--context JSON]');
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
