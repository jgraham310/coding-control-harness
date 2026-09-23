#!/usr/bin/env node
/**
 * Versioned offline trace-evaluation admission gate (issue #13).
 *
 * Converts approved, bounded failure traces into calibrated evaluators and
 * deterministic regression gates.  The ledger stores only redacted trace
 * metadata plus an immutable source digest, and metadata is a closed allowlist
 * of single-token triage fields -- so raw trace content has no field to travel
 * in, under a banned key or a benign-looking one.  Raw content, prompts,
 * responses, private logs and credentials are rejected, never stored and never
 * digested.
 *
 * A failure mode is opened by deduplicating samples on their stable metadata
 * digest, admitted only on human-labeled calibration plus a held-out set with
 * a threshold and confusion counts, and marked protected only by a named
 * deterministic test that passed at the exact candidate head.  Everything
 * else -- an LLM self-score, evaluator disagreement, an uncalibrated
 * evaluator, a stale or cross candidate head, a missing source digest, a
 * replayed sample or a replayed pass -- is a typed hold, never a pass.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readLedgerFile as readSiblingLedger, redactionFindings, withLedgerLock } from './request-completion-receipt.mjs';

export const MODE_SCHEMA = 'trace_failure_mode/v1';
export const LEDGER_SCHEMA = 'trace_evaluation_ledger/v1';
export const CONTRACT_VERSION = '1.0.0';

/** Only a terminal failure is admissible evidence of a failure mode. */
export const TERMINAL_OUTCOMES = Object.freeze(['failed', 'timed_out', 'crashed', 'aborted']);
export const PROTECTION_STATES = Object.freeze(['unknown', 'diagnostic', 'protected']);
/**
 * Keys that obviously carry raw trace payload.  This denylist only sharpens the
 * rejection reason -- it is not the defense.  A denylist cannot hold, because
 * raw content travels just as happily under a benign key like `note` or
 * `summary`, so admission is decided by the allowlist below.
 */
export const RAW_TRACE_KEY = /^(raw|rawTrace|trace|traces|content|contents|body|prompt|prompts|response|responses|completion|message|messages|secret|secrets)$/i;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Invariant 1.  Metadata is a closed allowlist of failure-triage fields, and
 * every string value must be a single token: no whitespace, so a sentence of
 * trace content cannot be spelled in any admitted field, under any key.
 */
export const METADATA_FIELDS = Object.freeze({
  failureSignature: 'token',
  failureClass: 'token',
  component: 'token',
  tool: 'token',
  status: 'token',
  exitClass: 'token',
  exitCode: 'integer',
  attempts: 'integer',
  count: 'integer',
  environment: 'token',
});
export const METADATA_KEY_LIMIT = Object.keys(METADATA_FIELDS).length;
export const METADATA_TOKEN_LIMIT = 80;
export const METADATA_TOKEN = /^[A-Za-z0-9][\w.:@/-]{0,79}$/;
export const METADATA_COUNT_LIMIT = 1_000_000;
/** The sample envelope is closed too: an unknown field is never a place to park a trace. */
export const SAMPLE_FIELDS = Object.freeze(['sampleId', 'source', 'observedAt', 'outcome', 'sourceDigest', 'metadata']);

/** Durable cross-repository placement receipt for this control (issue #13). */
export const PLACEMENT_RECEIPT = Object.freeze({
  owner: 'coding-control-harness',
  enforcement: 'trace-evaluation admission gate: redacted metadata, calibrated evaluators, exact-head deterministic regression evidence',
  governanceConsumer: 'Henry Operating System',
  contract: `${MODE_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable source digests, deduplicated failure modes, typed holds, and protection bound to one candidate head',
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
const headSha = (value, name = 'headSha') => {
  const sha = text(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${name} must be a full 40-character commit sha`);
  return sha;
};
const digestRef = (value, name) => (DIGEST_PATTERN.test(value ?? '') ? value : fail(`${name} must be a sha256: digest`));
const counted = (value, name) => (Number.isInteger(value) && value >= 0 ? value : fail(`${name} must be a non-negative integer`));

/** Trails where raw trace content would be stored.  Empty is the only clean result. */
export function rawTraceFindings(value, trail = 'sample') {
  if (Array.isArray(value)) return value.flatMap((entry, index) => rawTraceFindings(entry, `${trail}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.keys(value).flatMap((key) => (RAW_TRACE_KEY.test(key)
      ? [`${trail}.${key} carries raw trace content`]
      : rawTraceFindings(value[key], `${trail}.${key}`)));
  }
  return [];
}

/**
 * Typed reasons a metadata object is inadmissible.  An unknown key is
 * `unsafe-metadata` whatever it is called; a key that is a known content
 * carrier keeps the sharper `raw-content-field`.
 */
export function metadataFindings(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return ['unsafe-metadata'];
  const keys = Object.keys(metadata);
  const reasons = keys.length ? [] : ['unsafe-metadata'];
  for (const key of keys) {
    if (RAW_TRACE_KEY.test(key)) { reasons.push('raw-content-field'); continue; }
    const kind = METADATA_FIELDS[key];
    if (!kind) { reasons.push('unsafe-metadata'); continue; }
    const value = metadata[key];
    const ok = kind === 'integer'
      ? Number.isInteger(value) && value >= 0 && value <= METADATA_COUNT_LIMIT
      : typeof value === 'string' && METADATA_TOKEN.test(value.trim());
    if (!ok) reasons.push('unsafe-metadata');
  }
  return [...new Set(reasons)].sort();
}

/** Typed reasons the sample envelope is inadmissible. */
export function envelopeFindings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['malformed-sample'];
  const reasons = Object.keys(input)
    .filter((key) => !SAMPLE_FIELDS.includes(key))
    .map((key) => (RAW_TRACE_KEY.test(key) ? 'raw-content-field' : 'unsafe-metadata'));
  // sampleId and source are persisted, so they are tokens too -- otherwise the
  // whole trace just moves into the identifier.
  for (const key of ['sampleId', 'source']) {
    const value = input[key];
    if (typeof value === 'string' && !METADATA_TOKEN.test(value.trim())) reasons.push('unsafe-metadata');
  }
  return [...new Set(reasons)].sort();
}

function normalizeMetadata(metadata) {
  const findings = metadataFindings(metadata);
  if (findings.length) fail(`metadata rejected: ${findings.join(', ')}`);
  return Object.fromEntries(Object.keys(metadata).sort().map((key) => {
    const value = metadata[key];
    return [key, METADATA_FIELDS[key] === 'integer' ? value : value.trim()];
  }));
}

const token = (value, name) => {
  const scalar = text(value, name);
  return METADATA_TOKEN.test(scalar) ? scalar : fail(`${name} must be a single token of at most ${METADATA_TOKEN_LIMIT} characters`);
};

/**
 * The mode key is derived from the redacted metadata alone, never supplied, so
 * two equivalent traces from different sources deduplicate onto one mode and a
 * producer cannot mint a key that belongs to another failure mode.
 */
export function metadataDigest(metadata) { return sha256(JSON.stringify(stable(normalizeMetadata(metadata)))); }
export function deriveModeKey(metadata) { return sha256([MODE_SCHEMA, CONTRACT_VERSION, metadataDigest(metadata)].join('\n')); }

/** Build a typed sample.  Admission is decided by the gate, not by the producer. */
export function buildSample(input) {
  const findings = [...envelopeFindings(input ?? {}), ...rawTraceFindings(input ?? {}), ...redactionFindings(input ?? {}, 'sample')];
  if (findings.length) fail(`sample rejected: ${[...new Set(findings)].sort().join(', ')}`);
  const outcome = TERMINAL_OUTCOMES.includes(input?.outcome) ? input.outcome : fail(`invalid terminal outcome ${input?.outcome}`);
  const metadata = normalizeMetadata(input.metadata);
  const body = {
    schema: MODE_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    sampleId: token(input.sampleId, 'sampleId'),
    source: token(input.source, 'source'),
    observedAt: instant(input.observedAt, 'observedAt'),
    outcome,
    sourceDigest: digestRef(input.sourceDigest, 'sourceDigest'),
    metadata,
    metadataDigest: metadataDigest(metadata),
    modeKey: deriveModeKey(metadata),
  };
  return { ...body, digest: sha256(JSON.stringify(stable(body))) };
}

/** Typed admissibility of one sample.  Reasons are stable and sorted. */
export function evaluateSample(input) {
  const reasons = [...envelopeFindings(input ?? {}), ...metadataFindings(input?.metadata)];
  if (rawTraceFindings(input ?? {}).length) reasons.push('raw-content-field');
  if (redactionFindings(input ?? {}, 'sample').length) reasons.push('sensitive-content');
  if (!DIGEST_PATTERN.test(input?.sourceDigest ?? '')) reasons.push('missing-source-digest');
  if (!TERMINAL_OUTCOMES.includes(input?.outcome)) reasons.push('non-terminal-sample');
  let sample = null;
  try { sample = buildSample(input); } catch { if (!reasons.length) reasons.push('malformed-sample'); }
  const unique = [...new Set(reasons)].sort();
  return { accepted: unique.length === 0, reasons: unique, sample: unique.length ? null : sample };
}

// ------------------------------------------------------------- calibration

const confusionOf = (confusion, samples, label) => {
  const counts = {
    truePositives: counted(confusion?.truePositives, `${label}.confusion.truePositives`),
    falsePositives: counted(confusion?.falsePositives, `${label}.confusion.falsePositives`),
    trueNegatives: counted(confusion?.trueNegatives, `${label}.confusion.trueNegatives`),
    falseNegatives: counted(confusion?.falseNegatives, `${label}.confusion.falseNegatives`),
  };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total !== samples) fail(`${label}.confusion must account for all ${samples} samples`);
  return counts;
};

/** Precision and recall from a confusion matrix; an empty positive class scores 0. */
export function scoreConfusion({ truePositives: tp, falsePositives: fp, falseNegatives: fn }) {
  return { precision: tp + fp === 0 ? 0 : tp / (tp + fp), recall: tp + fn === 0 ? 0 : tp / (tp + fn) };
}

/**
 * Invariant 2.  An evaluator is calibrated only on human-labeled evidence plus
 * a held-out set, a recorded threshold, and confusion counts that the held-out
 * set actually meets.  A model scoring its own output, a single reviewer, or
 * any disagreement is a typed hold -- never an admission.
 */
export function evaluateCalibration(input) {
  const reasons = [];
  const evaluatorId = typeof input?.evaluatorId === 'string' ? input.evaluatorId.trim() : '';
  const threshold = input?.threshold;
  if (!(typeof threshold === 'number' && threshold > 0 && threshold <= 1)) reasons.push('threshold-missing');

  const setOf = (set, label, missing) => {
    if (!set || !Number.isInteger(set.samples) || set.samples <= 0) { reasons.push(missing); return null; }
    try { return { samples: set.samples, confusion: confusionOf(set.confusion, set.samples, label) }; }
    catch { reasons.push('confusion-matrix-missing'); return null; }
  };
  const calibration = setOf(input?.calibration, 'calibration', 'calibration-incomplete');
  const heldOut = setOf(input?.heldOut, 'heldOut', 'held-out-missing');

  const labeler = input?.calibration?.labeler;
  // Invariant 2: the calibration labels must come from a human who is not the
  // evaluator.  A model-labeled set is exactly the self-score this gate exists
  // to refuse, whatever it is named.
  if (labeler?.kind !== 'human' || !labeler?.id || labeler.id === evaluatorId) reasons.push('self-score-only');

  const reviewers = Array.isArray(input?.reviewers) ? input.reviewers : [];
  const ids = new Set(reviewers.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id.trim()));
  if (ids.size < 2 || ids.has(evaluatorId)) reasons.push('independent-review-missing');
  if (reviewers.some((entry) => entry?.verdict !== 'agree')) reasons.push('evaluator-disagreement');

  if (heldOut && typeof threshold === 'number') {
    const { precision, recall } = scoreConfusion(heldOut.confusion);
    if (Math.min(precision, recall) < threshold) reasons.push('held-out-below-threshold');
  }
  if (!evaluatorId) reasons.push('malformed-calibration');

  const unique = [...new Set(reasons)].sort();
  if (unique.length) return { accepted: false, reasons: unique, evaluator: null };
  const body = {
    schema: MODE_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    evaluatorId,
    threshold,
    calibration: { samples: calibration.samples, confusion: calibration.confusion, labeler: { id: labeler.id, kind: 'human' } },
    heldOut: { samples: heldOut.samples, confusion: heldOut.confusion, ...scoreConfusion(heldOut.confusion) },
    reviewers: [...reviewers].map((entry) => ({ id: entry.id, verdict: entry.verdict })).sort((a, b) => a.id.localeCompare(b.id)),
    calibratedAt: instant(input.calibratedAt, 'calibratedAt'),
  };
  return { accepted: true, reasons: [], evaluator: { ...body, digest: sha256(JSON.stringify(stable(body))) } };
}

// ------------------------------------------------------------------ ledger

export function emptyLedger() { return { schema: LEDGER_SCHEMA, contractVersion: CONTRACT_VERSION, modes: {}, evidence: {}, holds: [] }; }

export function validateLedger(ledger) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA || !ledger.modes || !ledger.evidence || !Array.isArray(ledger.holds)) fail('invalid trace-evaluation ledger');
  return ledger;
}

const clockOf = (...candidates) => candidates.find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))) ?? null;

/** A hold is the only non-pass outcome; identical holds dedupe rather than pile up. */
function held(ledger, hold) {
  const duplicate = ledger.holds.find((entry) => entry.kind === hold.kind && entry.modeKey === hold.modeKey
    && entry.digest === hold.digest && String(entry.reasons) === String(hold.reasons));
  return {
    ledger: duplicate ? ledger : { ...ledger, holds: [...ledger.holds, hold] },
    decision: duplicate ? 'deduplicated_hold' : 'held',
    admitted: false, protectedAtHead: null, modeKey: hold.modeKey, reasons: hold.reasons, entry: duplicate ?? hold,
  };
}

/**
 * Invariants 1 and 4.  Equivalent redacted samples collapse onto one failure
 * mode with a stable digest; a replayed source digest adds no observation and
 * never opens a second mode.
 */
export function ingestSample(ledger, input, context = {}) {
  validateLedger(ledger);
  const { accepted, reasons, sample } = evaluateSample(input);
  const at = clockOf(context.at, input?.observedAt);
  if (!accepted) return held(ledger, { at, kind: 'ingest', modeKey: null, digest: null, reasons });

  const observation = { sampleId: sample.sampleId, source: sample.source, observedAt: sample.observedAt, outcome: sample.outcome, sourceDigest: sample.sourceDigest, digest: sample.digest };
  const existing = ledger.modes[sample.modeKey] ?? null;
  if (!existing) {
    const mode = {
      schema: MODE_SCHEMA,
      contractVersion: CONTRACT_VERSION,
      modeKey: sample.modeKey,
      metadata: sample.metadata,
      metadataDigest: sample.metadataDigest,
      // The mode digest is derived from the redacted metadata alone, so it is
      // stable no matter how many equivalent samples arrive or in what order.
      digest: sha256([MODE_SCHEMA, CONTRACT_VERSION, sample.metadataDigest].join('\n')),
      openedAt: at,
      observations: [observation],
      evaluator: null,
      protection: null,
    };
    return { ledger: { ...ledger, modes: { ...ledger.modes, [mode.modeKey]: mode } }, decision: 'mode_opened', admitted: false, protectedAtHead: null, modeKey: mode.modeKey, reasons: [], entry: mode };
  }
  if (existing.observations.some((entry) => entry.sourceDigest === sample.sourceDigest)) {
    return { ...held(ledger, { at, kind: 'ingest', modeKey: sample.modeKey, digest: sample.digest, reasons: ['replayed-sample'] }), decision: 'deduplicated' };
  }
  const mode = { ...existing, observations: [...existing.observations, observation].sort((a, b) => a.sourceDigest.localeCompare(b.sourceDigest)) };
  return { ledger: { ...ledger, modes: { ...ledger.modes, [mode.modeKey]: mode } }, decision: 'mode_extended', admitted: false, protectedAtHead: null, modeKey: mode.modeKey, reasons: [], entry: mode };
}

/** Invariant 2.  Calibration admits a mode for evaluation; it never protects it. */
export function calibrateEvaluator(ledger, modeKey, input, context = {}) {
  validateLedger(ledger);
  const key = typeof modeKey === 'string' ? modeKey : '';
  const at = clockOf(context.at, input?.calibratedAt);
  const existingMode = ledger.modes[key] ?? null;
  const { accepted, reasons, evaluator } = evaluateCalibration(input);
  if (!existingMode) return held(ledger, { at, kind: 'calibrate', modeKey: key || null, digest: evaluator?.digest ?? null, reasons: [...new Set([...reasons, 'unknown-failure-mode'])].sort() });
  if (!accepted) return held(ledger, { at, kind: 'calibrate', modeKey: key, digest: null, reasons });

  if (existingMode.evaluator?.digest === evaluator.digest) {
    return { ledger, decision: 'deduplicated', admitted: true, protectedAtHead: existingMode.protection?.candidateHead ?? null, modeKey: key, reasons: [], entry: existingMode };
  }
  // A different evaluator has not proven anything about the old evaluator's
  // pass, so recalibration drops the protection instead of inheriting it.
  const mode = { ...existingMode, evaluator, admittedAt: at, protection: existingMode.evaluator ? null : existingMode.protection };
  return {
    ledger: { ...ledger, modes: { ...ledger.modes, [key]: mode } },
    decision: existingMode.evaluator ? 'recalibrated' : 'admitted',
    admitted: true, protectedAtHead: mode.protection?.candidateHead ?? null, modeKey: key, reasons: [], entry: mode,
  };
}

/**
 * Invariants 3, 4 and 5.  A mode becomes protected only when a named
 * deterministic test is recorded as passed at the exact candidate head the
 * caller expects.  Stale heads, cross-candidate evidence, an uncalibrated
 * evaluator and replayed passes stay diagnostic.
 */
export function claimProtection(ledger, modeKey, claim, context = {}) {
  validateLedger(ledger);
  const key = typeof modeKey === 'string' ? modeKey : '';
  const at = clockOf(context.at, claim?.executedAt);
  const mode = ledger.modes[key] ?? null;
  const reasons = [];
  if (!mode) reasons.push('unknown-failure-mode');
  else if (!mode.evaluator) reasons.push('evaluator-uncalibrated');

  let evidence = null;
  try {
    const body = {
      schema: MODE_SCHEMA,
      contractVersion: CONTRACT_VERSION,
      modeKey: key,
      candidateHead: headSha(claim?.candidateHead, 'candidateHead'),
      testName: text(claim?.testName, 'testName'),
      command: text(claim?.command, 'command'),
      status: claim?.status,
      headSha: headSha(claim?.headSha, 'headSha'),
      producer: text(claim?.producer, 'producer'),
      executedAt: instant(claim?.executedAt, 'executedAt'),
    };
    // The run digest deliberately excludes the mode and the candidate head:
    // it identifies the *observed test run*, so the same pass cannot be
    // re-offered as coverage for a second failure mode.
    const { modeKey: _mode, candidateHead: _head, ...run } = body;
    evidence = { ...body, runDigest: sha256(JSON.stringify(stable(run))), digest: sha256(JSON.stringify(stable(body))) };
  } catch { reasons.push('missing-test-evidence'); }

  if (!context?.expected?.candidateHead) reasons.push('expected-binding-missing');
  if (evidence) {
    if (evidence.status !== 'passed') reasons.push('test-not-passed');
    // The test must have run at the head it is offered for, and that head must
    // be the one the caller is gating -- a pass from a sibling candidate is
    // cross-candidate evidence, not coverage.
    if (evidence.headSha !== evidence.candidateHead) reasons.push('cross-candidate-evidence');
    if (context?.expected?.candidateHead && evidence.candidateHead !== String(context.expected.candidateHead).toLowerCase()) reasons.push('stale-candidate-head');
    if (rawTraceFindings(claim, 'claim').length) reasons.push('raw-content-field');
    if (redactionFindings(claim, 'claim').length) reasons.push('sensitive-content');
    const prior = ledger.evidence[evidence.runDigest] ?? null;
    if (prior && prior.modeKey !== key) reasons.push('replayed-test-evidence');
  }

  const unique = [...new Set(reasons)].sort();
  if (unique.length) return held(ledger, { at, kind: 'claim', modeKey: key || null, digest: evidence?.digest ?? null, reasons: unique });

  const priorProtection = mode.protection;
  if (priorProtection?.digest === evidence.digest) {
    return { ledger, decision: 'deduplicated', admitted: true, protectedAtHead: priorProtection.candidateHead, modeKey: key, reasons: [], entry: mode };
  }
  const next = { ...mode, protection: { ...evidence, recordedAt: at } };
  return {
    ledger: { ...ledger, modes: { ...ledger.modes, [key]: next }, evidence: { ...ledger.evidence, [evidence.runDigest]: { modeKey: key, candidateHead: evidence.candidateHead, recordedAt: at } } },
    decision: 'protected', admitted: true, protectedAtHead: evidence.candidateHead, modeKey: key, reasons: [], entry: next,
  };
}

/** Typed protection status for one candidate head.  Unknown is never protected. */
export function protectionStatus(ledger, modeKey, candidateHead) {
  const mode = ledger?.modes?.[modeKey] ?? null;
  if (!mode) return { status: 'unknown', isProtected: false, reasons: ['unknown-failure-mode'] };
  if (!mode.evaluator) return { status: 'diagnostic', isProtected: false, reasons: ['evaluator-uncalibrated'] };
  if (!mode.protection) return { status: 'diagnostic', isProtected: false, reasons: ['missing-test-evidence'] };
  if (mode.protection.candidateHead !== String(candidateHead ?? '').toLowerCase()) return { status: 'diagnostic', isProtected: false, reasons: ['stale-candidate-head'] };
  return { status: 'protected', isProtected: true, reasons: [] };
}

// ---------------------------------------------------------------- file adapter

const apply = (ledgerPath, fn) => withLedgerLock(ledgerPath, fn, { empty: emptyLedger, validate: validateLedger });
export const ingestToLedgerFile = (ledgerPath, sample, context) => apply(ledgerPath, (ledger) => ingestSample(ledger, sample, context));
export const calibrateToLedgerFile = (ledgerPath, modeKey, input, context) => apply(ledgerPath, (ledger) => calibrateEvaluator(ledger, modeKey, input, context));
export const claimToLedgerFile = (ledgerPath, modeKey, claim, context) => apply(ledgerPath, (ledger) => claimProtection(ledger, modeKey, claim, context));
export const readLedgerFile = (ledgerPath) => readSiblingLedger(ledgerPath, { empty: emptyLedger, validate: validateLedger });

function cli() {
  const argument = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fail(`missing ${name}`);
  };
  const command = process.argv[2];
  const ledgerPath = text(argument('--ledger'), '--ledger');
  const context = JSON.parse(argument('--context', '{}'));
  const payload = () => JSON.parse(text(argument('--json'), '--json'));
  let out;
  if (command === 'ingest') {
    const { ledger, ...result } = ingestToLedgerFile(ledgerPath, payload(), context);
    out = result;
  } else if (command === 'calibrate') {
    const { ledger, ...result } = calibrateToLedgerFile(ledgerPath, text(argument('--mode'), '--mode'), payload(), context);
    out = result;
  } else if (command === 'claim') {
    const { ledger, ...result } = claimToLedgerFile(ledgerPath, text(argument('--mode'), '--mode'), payload(), context);
    out = result;
  } else if (command === 'status') {
    out = protectionStatus(readLedgerFile(ledgerPath), text(argument('--mode'), '--mode'), argument('--head'));
  } else if (command === 'read') {
    out = readLedgerFile(ledgerPath);
  } else {
    fail('usage: trace-evaluation-gate.mjs <ingest|calibrate|claim|status|read> --ledger PATH [--mode KEY] [--json JSON] [--context JSON] [--head SHA]');
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
