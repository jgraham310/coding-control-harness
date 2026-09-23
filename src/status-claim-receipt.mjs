#!/usr/bin/env node
/**
 * Versioned offline status-claim receipts (issue #15).
 *
 * ./request-completion-receipt.mjs closes an engineering request and
 * ./execution-loop-receipt.mjs records the loop events underneath it.  This
 * module governs the layer above both: the operational *statements* a report
 * makes -- "GitHub is reachable", "the TLS chain is trusted", "auth is valid",
 * "the artifact published".  Each statement must be bound to one claim class,
 * one runtime identity, one command/result digest observed on that runtime,
 * one observation time, the artifact and head where the class has one, and one
 * idempotency key derived from all of it.
 *
 * Everything else renders as `unverified` and authorizes no factual claim:
 * stale observations, evidence from another runtime, replays, receipts whose
 * declared result contradicts its command evidence, and malformed bodies.
 * Receipts carry structured result metadata and digests only -- raw command
 * output, credential fields, and secret-bearing URLs are rejected at
 * construction rather than redacted, so they are never stored at all.  One
 * receipt supports one logical claim and one delivery; a second use of either
 * key is held.
 */
import crypto from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readLedgerFile as readSiblingLedgerFile, redactionFindings, withLedgerLock } from './request-completion-receipt.mjs';

export const RECEIPT_SCHEMA = 'status_claim_receipt/v1';
export const LEDGER_SCHEMA = 'status_claim_ledger/v1';
export const CONTRACT_VERSION = '1.0.0';

/**
 * Claim class -> the results that class may carry -> the disposition each one
 * renders as.  The classes are capability-shaped, not service-shaped: a new
 * service is a new `runtimeId`/`source.command`, never a new class here.
 */
export const CLAIM_RESULTS = Object.freeze({
  service_reachability: Object.freeze({ reachable: 'success', unreachable: 'failure', blocked_by_policy: 'blocker' }),
  transport_trust: Object.freeze({ trusted: 'success', untrusted: 'failure', unverifiable_chain: 'blocker' }),
  credential_validity: Object.freeze({ valid: 'success', invalid: 'failure', unavailable: 'blocker' }),
  artifact_publication: Object.freeze({ published: 'success', absent: 'failure', publication_blocked: 'blocker' }),
  command_outcome: Object.freeze({ succeeded: 'success', failed: 'failure', could_not_run: 'blocker' }),
});
export const CLAIM_CLASSES = Object.freeze(Object.keys(CLAIM_RESULTS));
/** Invariant 4: only these three are factual; `unverified` never is. */
export const FACTUAL_DISPOSITIONS = Object.freeze(['success', 'failure', 'blocker']);
export const UNVERIFIED = 'unverified';
/** Classes whose statement is about a specific artifact at a specific head. */
export const ARTIFACT_BOUND_CLASSES = Object.freeze(['artifact_publication']);

/** Durable cross-repository placement receipt for this control (issue #15). */
export const PLACEMENT_RECEIPT = Object.freeze({
  owner: 'coding-control-harness',
  enforcement: 'typed status-claim receipt producer with exact class/runtime/evidence/observation/idempotency binding',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, unverified-safe renderings, and one claim and delivery per receipt',
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
const headSha = (value, name = 'artifact.headSha') => {
  const sha = text(value, name).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`${name} must be a full 40-character commit sha`);
  return sha;
};
const positive = (value, name) => (Number.isInteger(value) && value > 0 ? value : fail(`${name} must be a positive integer`));
const digestHandle = (value, name) => {
  const handle = text(value, name);
  if (!/^sha256:[0-9a-f]{64}$/.test(handle)) fail(`${name} must be a sha256 digest handle`);
  return handle;
};

export function receiptDigest(receipt) {
  const { digest, ...body } = receipt ?? {};
  return sha256(JSON.stringify(stable(body)));
}

// -------------------------------------------------------- prohibited content

// A URL is evidence only as an endpoint; one carrying a credential in its
// userinfo or query string is a secret in transit and is never stored.
const SECRET_URL = /https?:\/\/\S*[?&#](?:access[-_]?token|token|api[-_]?key|key|sig|signature|password|secret)=/i;
const CREDENTIAL_URL = /https?:\/\/[^\s/@]*:[^\s/@]*@/;

/** Secret-bearing URLs, on top of the shared credential/raw-log findings. */
export function urlFindings(value, trail = 'receipt') {
  if (typeof value === 'string') return SECRET_URL.test(value) || CREDENTIAL_URL.test(value) ? [`${trail} contains a secret-bearing URL`] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => urlFindings(entry, `${trail}[${index}]`));
  if (value && typeof value === 'object') return Object.keys(value).flatMap((key) => urlFindings(value[key], `${trail}.${key}`));
  return [];
}

/** Invariant 3.  Everything a consumer would refuse the receipt for. */
export function prohibitedFindings(value, trail = 'receipt') {
  return [...redactionFindings(value, trail), ...urlFindings(value, trail)];
}

// ------------------------------------------------------------- normalization

// Raw output is smuggled in as a long or multi-line string far more often than
// as a field literally named `stdout`, so metadata values are bounded scalars.
const METADATA_MAX_STRING = 200;

function normalizeMetadata(value, trail = 'metadata') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail(`${trail} must be a finite number`);
  if (typeof value === 'string') {
    if (value.length > METADATA_MAX_STRING || /[\n\r]/.test(value)) fail(`${trail} must be structured metadata, not raw command output`);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => normalizeMetadata(entry, `${trail}[${index}]`));
  if (typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeMetadata(value[key], `${trail}.${key}`)]));
  return fail(`${trail} must be structured metadata`);
}

function normalizeSource(source) {
  return {
    command: text(source?.command, 'source.command'),
    exitCode: Number.isInteger(source?.exitCode) ? source.exitCode : fail('source.exitCode must be an integer'),
    // The producer hashes the output; the output itself never travels.
    resultDigest: digestHandle(source?.resultDigest, 'source.resultDigest'),
  };
}

function normalizeArtifact(claimClass, artifact) {
  if (!ARTIFACT_BOUND_CLASSES.includes(claimClass)) {
    return artifact == null ? null : fail(`${claimClass} claims carry no artifact identity`);
  }
  return { id: text(artifact?.id, 'artifact.id'), headSha: headSha(artifact?.headSha) };
}

/**
 * The idempotency key is derived, never supplied.  Binding the runtime is what
 * makes it provenance-bearing: a body re-sealed under another runtime's name
 * lands on a different key and can never occupy the original's slot, and a
 * consumer re-derives the whole binding offline from the receipt alone.
 */
export function deriveIdempotencyKey({ claimClass, runtimeId, claimKey, observedAt, source, artifact }) {
  const bound = ARTIFACT_BOUND_CLASSES.includes(claimClass);
  return sha256([
    RECEIPT_SCHEMA, CONTRACT_VERSION,
    text(claimClass, 'claimClass'), text(runtimeId, 'runtimeId'), text(claimKey, 'claimKey'),
    instant(observedAt, 'observedAt'), digestHandle(source?.resultDigest, 'source.resultDigest'),
    bound ? `${text(artifact?.id, 'artifact.id')}@${headSha(artifact?.headSha)}` : '',
  ].join('\n'));
}

/** Build a typed status-claim receipt.  Emission is not admission. */
export function buildStatusClaimReceipt(input) {
  const claimClass = CLAIM_CLASSES.includes(input?.claimClass) ? input.claimClass : fail(`invalid claimClass ${input?.claimClass}`);
  const result = CLAIM_RESULTS[claimClass][input?.result] ? input.result : fail(`invalid result ${input?.result} for ${claimClass}`);
  const body = {
    schema: RECEIPT_SCHEMA,
    contractVersion: CONTRACT_VERSION,
    claimClass,
    result,
    runtimeId: text(input.runtimeId, 'runtimeId'),
    claimKey: text(input.claimKey, 'claimKey'),
    observedAt: instant(input.observedAt, 'observedAt'),
    maxObservationAgeSeconds: positive(input.maxObservationAgeSeconds, 'maxObservationAgeSeconds'),
    source: normalizeSource(input.source),
    artifact: normalizeArtifact(claimClass, input.artifact),
    metadata: normalizeMetadata(input.metadata ?? {}),
    idempotencyKey: deriveIdempotencyKey({ ...input, claimClass }),
    producedAt: instant(input.producedAt, 'producedAt'),
  };
  // Invariant 3: prohibited content is refused, not redacted -- a redacted
  // receipt would still have carried the secret through the producer's memory
  // into a stored handle, and the producer is the party we are constraining.
  const findings = prohibitedFindings(body);
  if (findings.length) fail(`receipt carries prohibited content: ${findings.join('; ')}`);
  return { ...body, digest: receiptDigest(body) };
}

const REQUIRED_FIELDS = ['schema', 'contractVersion', 'claimClass', 'result', 'runtimeId', 'claimKey', 'observedAt',
  'maxObservationAgeSeconds', 'source', 'artifact', 'metadata', 'idempotencyKey', 'producedAt', 'digest'];

/** The disposition a receipt *would* render as if admitted. */
export function claimDisposition(receipt) {
  return CLAIM_RESULTS[receipt?.claimClass]?.[receipt?.result] ?? UNVERIFIED;
}

/**
 * Decide whether a receipt may support a factual operational claim.  Reasons
 * are stable and sorted; an empty list is the only admission.  `expected`
 * comes from the reporting context, not the receipt: a missing expectation
 * holds rather than matching itself.
 */
export function evaluateStatusClaim(receipt, { expected, at, maxObservationAgeSeconds } = {}) {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object' || REQUIRED_FIELDS.some((key) => receipt[key] === undefined)) {
    return { accepted: false, reasons: ['malformed-receipt'] };
  }
  if (receipt.schema !== RECEIPT_SCHEMA) reasons.push('schema-mismatch');
  if (receipt.contractVersion !== CONTRACT_VERSION) reasons.push('contract-version-mismatch');
  if (receipt.digest !== receiptDigest(receipt)) reasons.push('digest-mismatch');
  if (!CLAIM_CLASSES.includes(receipt.claimClass)) reasons.push('unknown-claim-class');
  else if (!CLAIM_RESULTS[receipt.claimClass][receipt.result]) reasons.push('invalid-result');

  let derived = null;
  try { derived = deriveIdempotencyKey(receipt); } catch { reasons.push('malformed-receipt'); }
  if (derived && derived !== receipt.idempotencyKey) reasons.push('idempotency-key-unbound');

  const binding = ['claimClass', 'runtimeId', 'claimKey', 'idempotencyKey'];
  if (!expected || binding.some((key) => !expected[key])) reasons.push('expected-binding-missing');
  if (expected?.claimClass && receipt.claimClass !== expected.claimClass) reasons.push('claim-class-mismatch');
  // Invariant 2: evidence gathered on another runtime never supports this one's
  // statement, however well formed the receipt is.
  if (expected?.runtimeId && receipt.runtimeId !== expected.runtimeId) reasons.push('cross-runtime-evidence');
  if (expected?.claimKey && receipt.claimKey !== expected.claimKey) reasons.push('claim-key-mismatch');
  if (expected?.idempotencyKey && receipt.idempotencyKey !== expected.idempotencyKey) reasons.push('idempotency-key-mismatch');

  // `source`, `artifact` and `metadata` are re-normalized and compared rather
  // than spot-checked: a mistyped, missing or extra field is malformed even
  // when the digest agrees with it.
  const wellFormed = (name, normalize, value) => {
    try { return JSON.stringify(stable(normalize(value))) === JSON.stringify(stable(value)); } catch { return false; }
  };
  if (!wellFormed('source', normalizeSource, receipt.source)) reasons.push('malformed-source');
  if (!wellFormed('artifact', (value) => normalizeArtifact(receipt.claimClass, value), receipt.artifact)) reasons.push('malformed-artifact');
  if (!wellFormed('metadata', normalizeMetadata, receipt.metadata)) reasons.push('malformed-metadata');
  if (!Number.isInteger(receipt.maxObservationAgeSeconds) || receipt.maxObservationAgeSeconds <= 0) reasons.push('malformed-observation-window');

  if (expected?.artifact !== undefined) {
    const want = expected.artifact === null ? null : `${expected.artifact?.id}@${expected.artifact?.headSha}`;
    const have = receipt.artifact === null ? null : `${receipt.artifact?.id}@${receipt.artifact?.headSha}`;
    if (want !== have) reasons.push('artifact-mismatch');
  } else if (ARTIFACT_BOUND_CLASSES.includes(receipt.claimClass)) {
    reasons.push('expected-binding-missing');
  }

  // Invariant 2: a declared result that disagrees with its own command evidence
  // is contradictory, not merely surprising.  Success is exit 0; a failure or a
  // blocker is not.
  const disposition = claimDisposition(receipt);
  if (FACTUAL_DISPOSITIONS.includes(disposition) && Number.isInteger(receipt.source?.exitCode)
    && (disposition === 'success') !== (receipt.source.exitCode === 0)) reasons.push('contradictory-evidence');

  const now = at === undefined ? null : Date.parse(at);
  if (!Number.isFinite(now)) reasons.push('evaluation-time-missing');
  else {
    const observed = Date.parse(receipt.observedAt ?? '');
    if (!Number.isFinite(observed)) reasons.push('malformed-receipt');
    else {
      // The freshness window is producer-attested, so a consumer may cap it; an
      // uncapped claim cannot be stretched past the reporting policy.
      const window = Number.isInteger(maxObservationAgeSeconds)
        ? Math.min(receipt.maxObservationAgeSeconds, maxObservationAgeSeconds)
        : receipt.maxObservationAgeSeconds;
      if (Number.isInteger(maxObservationAgeSeconds) && receipt.maxObservationAgeSeconds > maxObservationAgeSeconds) reasons.push('observation-window-too-wide');
      if (Number.isInteger(window) && (now - observed > window * 1000 || observed > now)) reasons.push('stale-observation');
    }
  }

  if (prohibitedFindings(receipt).length) reasons.push('prohibited-content');
  const unique = [...new Set(reasons)].sort();
  return { accepted: unique.length === 0, reasons: unique };
}

// ------------------------------------------------------------------ rendering

/**
 * Invariant 4.  An unverified rendering is built from stable reason slugs
 * alone: none of the receipt's own text reaches a report that was not admitted.
 */
export function unverifiedRendering(reasons) {
  return {
    disposition: UNVERIFIED,
    factual: false,
    reasons,
    statement: `unverified status claim: evidence not admitted (${reasons.join('; ')}). No operational success, failure or blocker may be reported from it.`,
  };
}

/** Render a claim.  Only an admitted receipt yields a factual statement. */
export function renderStatusClaim(receipt, context = {}) {
  const { accepted, reasons } = evaluateStatusClaim(receipt, context);
  if (!accepted) return unverifiedRendering(reasons);
  const artifact = receipt.artifact ? `, artifact ${receipt.artifact.id}@${receipt.artifact.headSha}` : '';
  return {
    disposition: claimDisposition(receipt),
    factual: true,
    reasons: [],
    statement: `${receipt.claimClass} ${receipt.result} on runtime ${receipt.runtimeId}, observed ${receipt.observedAt}, evidence ${receipt.source.resultDigest}${artifact}`,
  };
}

// --------------------------------------------------------------------- ledger

export function emptyLedger() { return { schema: LEDGER_SCHEMA, contractVersion: CONTRACT_VERSION, records: {}, claims: {}, deliveries: {}, holds: [] }; }

export function validateLedger(ledger) {
  if (!ledger || ledger.schema !== LEDGER_SCHEMA || !ledger.records || !ledger.claims || !ledger.deliveries || !Array.isArray(ledger.holds)) fail('invalid status-claim ledger');
  return ledger;
}

/**
 * Invariant 5.  Deliver a claim into the ledger.  The same receipt replayed for
 * the same delivery dedupes; a second delivery key over the same receipt, a
 * second receipt over the same logical claim, and a delivery key already spent
 * by another receipt are all held and render unverified.
 */
export function deliverStatusClaim(ledger, receipt, context = {}) {
  validateLedger(ledger);
  const { accepted, reasons } = evaluateStatusClaim(receipt, context);
  const holdReasons = [...reasons];
  const at = [context.at, receipt?.producedAt].find((value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))) ?? null;
  const key = receipt?.idempotencyKey ?? null;
  const claimKey = receipt?.claimKey ?? null;
  const deliveryKey = typeof context.deliveryKey === 'string' && context.deliveryKey.trim() ? context.deliveryKey.trim() : null;
  if (!deliveryKey) holdReasons.push('delivery-key-missing');

  const existing = key ? ledger.records[key] ?? null : null;
  if (existing && accepted && deliveryKey && existing.digest === receipt.digest && existing.deliveryKey === deliveryKey) {
    return { ledger, decision: 'deduplicated', delivered: true, ...renderStatusClaim(receipt, context), entry: existing };
  }
  if (existing) holdReasons.push(existing.digest === receipt?.digest ? 'receipt-already-delivered' : 'idempotency-conflict');
  const claimHolder = claimKey ? ledger.claims[claimKey] ?? null : null;
  if (claimHolder && claimHolder !== key) holdReasons.push('claim-already-delivered');
  const deliveryHolder = deliveryKey ? ledger.deliveries[deliveryKey] ?? null : null;
  if (deliveryHolder && deliveryHolder !== key) holdReasons.push('delivery-key-reused');

  const unique = [...new Set(holdReasons)].sort();
  if (unique.length) {
    const hold = { at, idempotencyKey: key, claimKey, deliveryKey, claimClass: receipt?.claimClass ?? null, digest: receipt?.digest ?? null, reasons: unique };
    const duplicate = ledger.holds.find((entry) => entry.digest === hold.digest && entry.idempotencyKey === key
      && entry.deliveryKey === deliveryKey && String(entry.reasons) === String(unique));
    return {
      ledger: duplicate ? ledger : { ...ledger, holds: [...ledger.holds, hold] },
      decision: duplicate ? 'deduplicated_hold' : 'held',
      delivered: false, ...unverifiedRendering(unique), entry: duplicate ?? hold,
    };
  }

  const rendering = renderStatusClaim(receipt, context);
  const entry = { ...receipt, deliveryKey, deliveredAt: at, disposition: rendering.disposition, statement: rendering.statement };
  return {
    ledger: {
      ...ledger,
      records: { ...ledger.records, [key]: entry },
      claims: { ...ledger.claims, [claimKey]: key },
      deliveries: { ...ledger.deliveries, [deliveryKey]: key },
    },
    decision: 'delivered', delivered: true, ...rendering, entry,
  };
}

// ---------------------------------------------------------------- file adapter

export function deliverToLedgerFile(ledgerPath, receipt, context) {
  return withLedgerLock(ledgerPath, (ledger) => deliverStatusClaim(ledger, receipt, context), { empty: emptyLedger, validate: validateLedger });
}

export function readLedgerFile(ledgerPath) {
  return readSiblingLedgerFile(ledgerPath, { empty: emptyLedger, validate: validateLedger });
}

function cli() {
  const argument = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index < 0 ? fallback : process.argv[index + 1] ?? fail(`missing ${name}`);
  };
  const command = process.argv[2];
  const ledgerPath = text(argument('--ledger'), '--ledger');
  let out;
  if (command === 'deliver') {
    const receipt = JSON.parse(text(argument('--receipt'), '--receipt'));
    const { ledger, ...result } = deliverToLedgerFile(ledgerPath, receipt, JSON.parse(argument('--context', '{}')));
    out = result;
  } else if (command === 'read') {
    out = readLedgerFile(ledgerPath);
  } else {
    fail('usage: status-claim-receipt.mjs <deliver|read> --ledger PATH [--receipt JSON] [--context JSON]');
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { cli(); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
