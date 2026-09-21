#!/usr/bin/env node
/**
 * Versioned execution-loop receipts (issue #11).
 *
 * The completion adapter in ./request-completion-receipt.mjs closes a Henry
 * engineering request.  This module emits the loop events *underneath* that:
 * PR terminal state, lane liveness, a deterministic regression that failed,
 * and a bounded improvement experiment.  Every receipt binds one exact task,
 * repository, head, event kind and idempotency key, and is verifiable offline
 * from the record alone.  Stale, malformed, duplicate, cross-task or
 * unverifiable receipts fail closed: they authorize nothing and never mutate an
 * accepted record.  No receipt can mark an experiment permanent.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readLedgerFile as readCompletionLedgerFile, redactEvidence, redactionFindings, withLedgerLock } from './request-completion-receipt.mjs';

export const RECEIPT_SCHEMA = 'execution_loop_receipt/v1';
export const LEDGER_SCHEMA = 'execution_loop_ledger/v1';
export const CONTRACT_VERSION = '1.0.0';

/** Event kind -> the only results that kind may carry. */
export const EVENT_RESULTS = Object.freeze({
  pr_terminal: Object.freeze(['merged', 'closed_unmerged', 'superseded']),
  lane_liveness: Object.freeze(['executing', 'idle_at_prompt', 'stopped', 'unknown']),
  regression_failed: Object.freeze(['reproduced_at_head', 'not_reproduced']),
  improvement_experiment: Object.freeze(['improved', 'regressed', 'inconclusive']),
});
export const EVENT_KINDS = Object.freeze(Object.keys(EVENT_RESULTS));
/** Invariant 3: only an idle lane authorizes dispatch; unknown never does. */
export const DISPATCH_AUTHORIZING_STATE = 'idle_at_prompt';

/** Durable cross-repository placement receipt for this control (issue #11). */
export const PLACEMENT_RECEIPT = Object.freeze({
  owner: 'coding-control-harness',
  enforcement: 'typed execution-loop receipt producer with exact task/repo/head/event/idempotency binding',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, fail-closed hold reasons, and permanently bounded experiments',
});

const fail = (message) => { throw new Error(message); };
const text = (value, name) => (typeof value === 'string' && value.trim() ? value.trim() : fail(`${name} must be a non-empty string`));
const stable = (value) => (Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value);
const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const instant = (value, name) => {
  const at = text(value, name);
  if (Number.isNaN(Date.parse(at))) fail(`${name} must be an ISO-8601 instant`);
  return at;
};
const headSha = (value) => {
  const sha = text(value, 'headSha').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail('headSha must be a full 40-character commit sha');
  return sha;
};
const positive = (value, name) => (Number.isInteger(value) && value > 0 ? value : fail(`${name} must be a positive integer`));

export function receiptDigest(receipt) {
  const { digest, ...body } = receipt ?? {};
  return sha256(JSON.stringify(stable(body)));
}

/**
 * The idempotency key is derived, never supplied: a producer cannot mint a key
 * that belongs to another task, head or event, and any consumer can re-derive
 * it offline from the receipt alone.  `occurrence` separates legitimate repeats
 * of the same event at the same head (a later liveness poll, a repair attempt).
 */
export function deriveIdempotencyKey({ taskId, repository, headSha: head, eventKind, occurrence }) {
  return sha256([
    RECEIPT_SCHEMA, CONTRACT_VERSION,
    text(taskId, 'taskId'), text(repository, 'repository'), headSha(head),
    text(eventKind, 'eventKind'), text(occurrence, 'occurrence'),
  ].join('\n'));
}

function normalizeDetails(eventKind, details) {
  if (eventKind === 'lane_liveness') {
    return {
      laneId: text(details?.laneId, 'details.laneId'),
      observedAt: instant(details?.observedAt, 'details.observedAt'),
      staleAfterSeconds: positive(details?.staleAfterSeconds, 'details.staleAfterSeconds'),
    };
  }
  if (eventKind === 'improvement_experiment') {
    return {
      experimentId: text(details?.experimentId, 'details.experimentId'),
      hypothesis: text(details?.hypothesis, 'details.hypothesis'),
      // Invariant 4: permanence is not a producer-settable field.  It is written
      // false here and re-checked on evaluation, so no receipt can promote an
      // experiment to permanent.
      permanent: false,
      bounds: {
        maxIterations: positive(details?.bounds?.maxIterations, 'details.bounds.maxIterations'),
        expiresAt: instant(details?.bounds?.expiresAt, 'details.bounds.expiresAt'),
      },
    };
  }
  if (eventKind === 'pr_terminal') {
    return {
      pullRequest: positive(details?.pullRequest, 'details.pullRequest'),
      mergeCommitSha: details?.mergeCommitSha == null ? null : headSha(details.mergeCommitSha),
    };
  }
  return {
    testName: text(details?.testName, 'details.testName'),
    command: text(details?.command, 'details.command'),
    exitCode: Number.isInteger(details?.exitCode) ? details.exitCode : fail('details.exitCode must be an integer'),
  };
}

/** Build a typed execution-loop receipt.  Emission is not authorization. */
export function buildExecutionReceipt(input) {
  const eventKind = EVENT_KINDS.includes(input?.eventKind) ? input.eventKind : fail(`invalid eventKind ${input?.eventKind}`);
  const result = EVENT_RESULTS[eventKind].includes(input?.result) ? input.result : fail(`invalid result ${input?.result} for ${eventKind}`);
  const body = {
    schema: RECEIPT_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    taskId: text(input.taskId, 'taskId'),
    repository: text(input.repository, 'repository'),
    headSha: headSha(input.headSha),
    eventKind,
    result,
    occurrence: text(input.occurrence, 'occurrence'),
    idempotencyKey: deriveIdempotencyKey({ ...input, eventKind }),
    producer: text(input.producer, 'producer'),
    producedAt: instant(input.producedAt, 'producedAt'),
    details: normalizeDetails(eventKind, input.details),
    evidence: redactEvidence(input.evidence ?? {}),
  };
  return { ...body, digest: receiptDigest(body) };
}

const REQUIRED_FIELDS = ['schema', 'contractVersion', 'taskId', 'repository', 'headSha', 'eventKind', 'result',
  'occurrence', 'idempotencyKey', 'producer', 'producedAt', 'details', 'evidence', 'digest'];

/**
 * Decide whether a receipt is admissible.  Reasons are stable and sorted; an
 * empty list is the only acceptance.  `expected` comes from the dispatcher, not
 * from the receipt: a missing expectation holds rather than matching itself.
 */
export function evaluateExecutionReceipt(receipt, { expected, at, maxStaleSeconds } = {}) {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object' || REQUIRED_FIELDS.some((key) => receipt[key] === undefined)) {
    return { accepted: false, reasons: ['malformed-receipt'] };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) reasons.push('schema-mismatch');
  if (receipt.contractVersion !== CONTRACT_VERSION) reasons.push('contract-version-mismatch');
  if (receipt.digest !== receiptDigest(receipt)) reasons.push('digest-mismatch');
  if (!EVENT_KINDS.includes(receipt.eventKind)) reasons.push('unknown-event-kind');
  else if (!EVENT_RESULTS[receipt.eventKind].includes(receipt.result)) reasons.push('invalid-result');

  let derived = null;
  try { derived = deriveIdempotencyKey(receipt); } catch { reasons.push('malformed-receipt'); }
  if (derived && derived !== receipt.idempotencyKey) reasons.push('idempotency-key-unbound');

  const binding = ['taskId', 'repository', 'headSha', 'eventKind', 'idempotencyKey'];
  if (!expected || binding.some((key) => !expected[key])) reasons.push('expected-binding-missing');
  if (expected?.taskId && receipt.taskId !== expected.taskId) reasons.push('cross-task-receipt');
  if (expected?.repository && receipt.repository !== expected.repository) reasons.push('repository-mismatch');
  if (expected?.headSha && receipt.headSha !== expected.headSha) reasons.push('stale-head');
  if (expected?.eventKind && receipt.eventKind !== expected.eventKind) reasons.push('event-kind-mismatch');
  if (expected?.idempotencyKey && receipt.idempotencyKey !== expected.idempotencyKey) reasons.push('idempotency-key-mismatch');

  const now = at === undefined ? null : Date.parse(at);
  const needsClock = receipt.eventKind === 'lane_liveness' || receipt.eventKind === 'improvement_experiment';
  if (needsClock && !Number.isFinite(now)) reasons.push('evaluation-time-missing');

  if (receipt.eventKind === 'lane_liveness') {
    const observed = Date.parse(receipt.details?.observedAt ?? '');
    const window = receipt.details?.staleAfterSeconds;
    if (!Number.isFinite(observed) || !Number.isInteger(window) || window <= 0) reasons.push('malformed-receipt');
    else {
      // The freshness window is producer-attested, so a consumer may cap it;
      // an uncapped claim cannot be stretched past the dispatcher's own policy.
      if (Number.isInteger(maxStaleSeconds) && window > maxStaleSeconds) reasons.push('liveness-window-too-wide');
      if (Number.isFinite(now) && (now - observed > window * 1000 || observed > now)) reasons.push('stale-liveness-observation');
    }
  }

  if (receipt.eventKind === 'improvement_experiment') {
    const bounds = receipt.details?.bounds;
    if (receipt.details?.permanent !== false) reasons.push('experiment-marked-permanent');
    if (!bounds || !Number.isInteger(bounds.maxIterations) || bounds.maxIterations <= 0 || !Number.isFinite(Date.parse(bounds.expiresAt ?? ''))) reasons.push('experiment-bounds-missing');
    else if (Number.isFinite(now) && now > Date.parse(bounds.expiresAt)) reasons.push('experiment-expired');
  }

  if (redactionFindings(receipt).length) reasons.push('sensitive-content');
  const unique = [...new Set(reasons)].sort();
  return { accepted: unique.length === 0, reasons: unique };
}

/**
 * Invariant 3.  Only an admissible liveness receipt reporting an idle lane
 * authorizes dispatch; executing, stopped and unknown all hold.
 */
export function dispatchDecision(receipt, context = {}) {
  const { accepted, reasons } = evaluateExecutionReceipt(receipt, context);
  if (!accepted) return { authorized: false, reasons };
  if (receipt.eventKind !== 'lane_liveness') return { authorized: false, reasons: ['not-a-liveness-receipt'] };
  if (receipt.result !== DISPATCH_AUTHORIZING_STATE) return { authorized: false, reasons: [`lane-${receipt.result.replace(/_/g, '-')}`] };
  return { authorized: true, reasons: [] };
}

export function emptyLedger() { return { schema: LEDGER_SCHEMA, contractVersion: CONTRACT_VERSION, records: {}, holds: [] }; }

export function validateLedger(ledger) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA || !ledger.records || !Array.isArray(ledger.holds)) fail('invalid execution-loop ledger');
  return ledger;
}

/**
 * Record a receipt.  Uniqueness is per idempotency key, so a replay dedupes and
 * a different receipt under the same key is held.  An accepted record is never
 * overwritten, and a task's PR terminal state is written once.
 */
export function recordExecutionReceipt(ledger, receipt, context = {}) {
  validateLedger(ledger);
  const { accepted, reasons } = evaluateExecutionReceipt(receipt, context);
  // A malformed record must hold, not throw: an unusable timestamp is recorded
  // as null on the hold rather than crashing the publisher mid-loop.
  const at = [context.at, receipt?.producedAt].find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))) ?? null;
  const key = accepted ? receipt.idempotencyKey : (receipt?.idempotencyKey ?? null);

  const held = (holdReasons) => {
    const hold = { at, idempotencyKey: key, taskId: receipt?.taskId ?? null, eventKind: receipt?.eventKind ?? null, digest: receipt?.digest ?? null, reasons: holdReasons };
    const duplicate = ledger.holds.find((entry) => entry.digest === hold.digest && entry.idempotencyKey === key && String(entry.reasons) === String(holdReasons));
    return {
      ledger: duplicate ? ledger : { ...ledger, holds: [...ledger.holds, hold] },
      decision: duplicate ? 'deduplicated_hold' : 'held',
      recorded: false, authorizes: false, reasons: holdReasons, entry: duplicate ?? hold,
    };
  };

  if (!accepted) return held(reasons);
  const existing = ledger.records[key] ?? null;
  if (existing) {
    return existing.digest === receipt.digest
      ? { ledger, decision: 'deduplicated', recorded: true, authorizes: existing.authorizes, reasons: [], entry: existing }
      : held(['idempotency-conflict']);
  }
  if (receipt.eventKind === 'pr_terminal') {
    // ponytail: linear scan over records; a per-task index only if a ledger
    // ever grows past a few thousand entries.
    const terminal = Object.values(ledger.records).find((entry) => entry.eventKind === 'pr_terminal' && entry.taskId === receipt.taskId);
    if (terminal) return held(['terminal-state-conflict']);
  }
  const entry = { ...receipt, recordedAt: at, authorizes: dispatchDecision(receipt, context).authorized };
  return { ledger: { ...ledger, records: { ...ledger.records, [key]: entry } }, decision: 'recorded', recorded: true, authorizes: entry.authorizes, reasons: [], entry };
}

// ---------------------------------------------------------------- file adapter

export function recordToLedgerFile(ledgerPath, receipt, context) {
  return withLedgerLock(ledgerPath, (ledger) => recordExecutionReceipt(ledger, receipt, context), { empty: emptyLedger, validate: validateLedger });
}

export function readLedgerFile(ledgerPath) {
  return readCompletionLedgerFile(ledgerPath, { empty: emptyLedger, validate: validateLedger });
}

function cli() {
  const argument = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fail(`missing ${name}`);
  };
  const command = process.argv[2];
  const ledgerPath = text(argument('--ledger'), '--ledger');
  let out;
  if (command === 'record') {
    const receipt = JSON.parse(text(argument('--receipt'), '--receipt'));
    const { ledger, ...result } = recordToLedgerFile(ledgerPath, receipt, JSON.parse(argument('--context', '{}')));
    out = result;
  } else if (command === 'read') {
    out = readLedgerFile(ledgerPath);
  } else {
    fail('usage: execution-loop-receipt.mjs <record|read> --ledger PATH [--receipt JSON] [--context JSON]');
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
