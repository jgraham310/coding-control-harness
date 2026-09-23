import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  ARTIFACT_BOUND_CLASSES, CLAIM_CLASSES, CLAIM_RESULTS, CONTRACT_VERSION, FACTUAL_DISPOSITIONS,
  PLACEMENT_RECEIPT, RECEIPT_SCHEMA, UNVERIFIED, buildStatusClaimReceipt, claimDisposition,
  deriveIdempotencyKey, evaluateStatusClaim, prohibitedFindings, receiptDigest, renderStatusClaim,
} from './status-claim-receipt.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('../fixtures/status-claim-receipts.v1.json', import.meta.url), 'utf8'));
const digestOf = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const bindingOf = (r) => ({ claimClass: r.claimClass, runtimeId: r.runtimeId, claimKey: r.claimKey, idempotencyKey: r.idempotencyKey, artifact: r.artifact });
const seal = (r) => { const { digest, ...body } = r; return { ...body, digest: receiptDigest(body) }; };

// --- the offline fixture is the only coordination channel -------------------
assert.equal(fixture.contract, `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`);
const serialized = JSON.stringify(fixture);
assert.doesNotMatch(serialized, /https?:\/\/(?!api\.example\.test)/, 'the fixture must not point at a live network endpoint');
assert.doesNotMatch(serialized, /\brefs\/heads\/|\borigin\//, 'the fixture must not depend on mutable branch state');

// --- a clean-clone consumer rebuilds every valid record byte for byte -------
for (const entry of fixture.valid) {
  const receipt = buildStatusClaimReceipt(entry.scenario);
  assert.deepEqual(receipt, entry.expectedReceipt, `${entry.name} drifted from the versioned fixture`);
  assert.equal(JSON.stringify(receipt), JSON.stringify(entry.expectedReceipt));
  assert.equal(receiptDigest(receipt), entry.expectedReceipt.digest);
  assert.equal(receipt.idempotencyKey, deriveIdempotencyKey(receipt), 'the key is derivable from the receipt alone');
  const context = { expected: entry.expectedBinding, at: entry.evaluatedAt };
  assert.deepEqual(evaluateStatusClaim(receipt, context), { accepted: true, reasons: [] });
  assert.deepEqual(renderStatusClaim(receipt, context), entry.expectedRendering, `${entry.name} rendering drifted`);
  assert.equal(entry.expectedRendering.factual, true);
  assert.ok(FACTUAL_DISPOSITIONS.includes(entry.expectedRendering.disposition));
}
assert.deepEqual([...new Set(fixture.valid.map((entry) => entry.scenario.claimClass))].sort(), [...CLAIM_CLASSES].sort(),
  'every claim class carries a worked offline example');

// --- and rejects every invalid one, for exactly the stated reasons ----------
for (const entry of fixture.rejected) {
  const context = { expected: entry.expectedBinding, at: entry.at };
  const evaluation = evaluateStatusClaim(entry.receipt, context);
  assert.equal(evaluation.accepted, false, `${entry.name} must fail closed`);
  assert.deepEqual(evaluation.reasons, [...entry.reasons].sort(), `${entry.name} reasons drifted`);
  // Invariant 4: a rejection is only ever an unverified, non-factual rendering.
  const rendering = renderStatusClaim(entry.receipt, context);
  assert.equal(rendering.disposition, UNVERIFIED);
  assert.equal(rendering.factual, false);
  assert.doesNotMatch(rendering.statement, /\bsucceeded|\breachable\b|\btrusted\b|\bvalid\b|\bpublished\b/,
    `${entry.name} must not read as an operational claim`);
}

// --- typed construction refuses nonsense ------------------------------------
const RUNTIME = 'harness-runtime/lane-a';
const OTHER_RUNTIME = 'harness-runtime/lane-b';
const HEAD = 'a'.repeat(40);
const input = {
  claimClass: 'service_reachability', result: 'reachable', runtimeId: RUNTIME,
  claimKey: 'report-1/github-reachable', observedAt: '2026-09-22T12:00:00.000Z', maxObservationAgeSeconds: 300,
  source: { command: 'gh api rate_limit', exitCode: 0, resultDigest: digestOf('ok') },
  metadata: { statusCode: 200 }, producedAt: '2026-09-22T12:00:01.000Z',
};
const NOW = '2026-09-22T12:01:00.000Z';
const context = (receipt, overrides = {}) => ({ expected: bindingOf(receipt), at: NOW, ...overrides });

assert.throws(() => buildStatusClaimReceipt({ ...input, claimClass: 'weather' }), /invalid claimClass/);
assert.throws(() => buildStatusClaimReceipt({ ...input, result: 'trusted' }), /invalid result/, 'a result from another class is not transferable');
assert.throws(() => buildStatusClaimReceipt({ ...input, observedAt: 'recently' }), /ISO-8601/);
assert.throws(() => buildStatusClaimReceipt({ ...input, maxObservationAgeSeconds: 0 }), /maxObservationAgeSeconds/);
assert.throws(() => buildStatusClaimReceipt({ ...input, runtimeId: '  ' }), /runtimeId/);
assert.throws(() => buildStatusClaimReceipt({ ...input, claimKey: '' }), /claimKey/);
assert.throws(() => buildStatusClaimReceipt({ ...input, source: { ...input.source, resultDigest: 'deadbeef' } }), /sha256 digest handle/);
assert.throws(() => buildStatusClaimReceipt({ ...input, source: { ...input.source, exitCode: '0' } }), /source.exitCode/);

// --- artifact identity is required exactly where the class has one ----------
assert.deepEqual([...ARTIFACT_BOUND_CLASSES], ['artifact_publication']);
assert.throws(() => buildStatusClaimReceipt({ ...input, artifact: { id: 'acme/fixture', headSha: HEAD } }),
  /carry no artifact identity/, 'an unrelated class cannot smuggle in an artifact binding');
const publicationInput = {
  claimClass: 'artifact_publication', result: 'published', runtimeId: RUNTIME, claimKey: 'report-1/pushed',
  observedAt: '2026-09-22T12:00:00.000Z', maxObservationAgeSeconds: 300,
  source: { command: 'git ls-remote --exit-code', exitCode: 0, resultDigest: digestOf('present') },
  artifact: { id: 'acme/fixture#branch', headSha: HEAD }, metadata: { refClass: 'branch-head' },
  producedAt: '2026-09-22T12:00:01.000Z',
};
assert.throws(() => buildStatusClaimReceipt({ ...publicationInput, artifact: null }), /artifact.id/);
assert.throws(() => buildStatusClaimReceipt({ ...publicationInput, artifact: { id: 'x', headSha: 'abc' } }), /40-character/);
const publication = buildStatusClaimReceipt(publicationInput);
assert.match(renderStatusClaim(publication, context(publication)).statement, /artifact acme\/fixture#branch@a{40}/);
// The head is part of the binding: the same artifact at another head is a different claim.
const otherHead = buildStatusClaimReceipt({ ...publicationInput, artifact: { id: 'acme/fixture#branch', headSha: 'b'.repeat(40) } });
assert.notEqual(otherHead.idempotencyKey, publication.idempotencyKey);
assert.deepEqual(evaluateStatusClaim(otherHead, context(publication)).reasons, ['artifact-mismatch', 'idempotency-key-mismatch']);

// --- the key binds class, runtime, claim, evidence, observation and artifact -
const receipt = buildStatusClaimReceipt(input);
const keys = new Set([
  receipt.idempotencyKey,
  deriveIdempotencyKey({ ...receipt, claimClass: 'credential_validity' }),
  deriveIdempotencyKey({ ...receipt, runtimeId: OTHER_RUNTIME }),
  deriveIdempotencyKey({ ...receipt, claimKey: 'report-2/github-reachable' }),
  deriveIdempotencyKey({ ...receipt, observedAt: '2026-09-22T12:00:05.000Z' }),
  deriveIdempotencyKey({ ...receipt, source: { ...receipt.source, resultDigest: digestOf('other') } }),
  publication.idempotencyKey,
  otherHead.idempotencyKey,
]);
assert.equal(keys.size, 8, 'every binding component changes the idempotency key');
assert.throws(() => deriveIdempotencyKey({ ...receipt, runtimeId: '' }), /runtimeId/, 'the key cannot be derived without a runtime');
assert.match(receipt.idempotencyKey, /^sha256:[0-9a-f]{64}$/);

// --- every class result maps to exactly one disposition ---------------------
for (const claimClass of CLAIM_CLASSES) {
  for (const [result, disposition] of Object.entries(CLAIM_RESULTS[claimClass])) {
    assert.ok(FACTUAL_DISPOSITIONS.includes(disposition), `${claimClass}/${result} must map to a factual disposition`);
    assert.equal(claimDisposition({ claimClass, result }), disposition);
  }
}
assert.equal(claimDisposition({ claimClass: 'service_reachability', result: 'probably_fine' }), UNVERIFIED);
assert.equal(claimDisposition(null), UNVERIFIED);
assert.ok(Object.isFrozen(CLAIM_RESULTS) && Object.values(CLAIM_RESULTS).every(Object.isFrozen));

// --- a declared result must agree with its own command evidence -------------
const contradictions = [
  ['a success on a non-zero exit', { ...input, source: { ...input.source, exitCode: 1 } }],
  ['a failure on exit zero', { ...input, result: 'unreachable' }],
  ['a blocker on exit zero', { ...input, result: 'blocked_by_policy' }],
];
for (const [label, scenario] of contradictions) {
  const contradictory = buildStatusClaimReceipt(scenario);
  assert.deepEqual(evaluateStatusClaim(contradictory, context(contradictory)).reasons, ['contradictory-evidence'], label);
  assert.equal(renderStatusClaim(contradictory, context(contradictory)).factual, false);
}
// The agreeing forms of the same three are admissible.
for (const scenario of [input, { ...input, result: 'unreachable', source: { ...input.source, exitCode: 7 } },
  { ...input, result: 'blocked_by_policy', source: { ...input.source, exitCode: 13 } }]) {
  const agreeing = buildStatusClaimReceipt(scenario);
  assert.deepEqual(evaluateStatusClaim(agreeing, context(agreeing)), { accepted: true, reasons: [] });
}

// --- evidence must be current, and from the declared runtime ----------------
assert.deepEqual(evaluateStatusClaim(receipt, context(receipt, { at: '2026-09-22T12:06:00.000Z' })).reasons, ['stale-observation']);
assert.deepEqual(evaluateStatusClaim(receipt, context(receipt, { at: '2026-09-22T11:59:00.000Z' })).reasons, ['stale-observation'],
  'an observation from the future is not current evidence');
assert.deepEqual(evaluateStatusClaim(receipt, context(receipt, { at: undefined })).reasons, ['evaluation-time-missing'],
  'freshness is never assumed when the consumer supplies no clock');
// A consumer may narrow the producer-attested window but never widen it.
assert.deepEqual(evaluateStatusClaim(receipt, context(receipt, { maxObservationAgeSeconds: 30 })).reasons,
  ['observation-window-too-wide', 'stale-observation']);
assert.deepEqual(evaluateStatusClaim(receipt, context(receipt, { maxObservationAgeSeconds: 3600 })), { accepted: true, reasons: [] });

const foreign = buildStatusClaimReceipt({ ...input, runtimeId: OTHER_RUNTIME });
assert.deepEqual(evaluateStatusClaim(foreign, context(receipt)).reasons, ['cross-runtime-evidence', 'idempotency-key-mismatch']);
assert.deepEqual(evaluateStatusClaim(foreign, context(foreign)), { accepted: true, reasons: [] },
  'the same observation is admissible only under its own runtime, on its own key');
// Re-sealing one runtime's body under another name breaks the derivation.
const renamed = seal({ ...receipt, runtimeId: OTHER_RUNTIME });
assert.equal(renamed.digest, receiptDigest(renamed), 'the forgery is internally consistent');
assert.deepEqual(evaluateStatusClaim(renamed, context(receipt)).reasons, ['cross-runtime-evidence', 'idempotency-key-unbound']);

// --- the expectation is supplied by the report, never by the receipt --------
for (const key of ['claimClass', 'runtimeId', 'claimKey', 'idempotencyKey']) {
  const { [key]: dropped, ...partial } = bindingOf(receipt);
  assert.deepEqual(evaluateStatusClaim(receipt, { expected: partial, at: NOW }).reasons, ['expected-binding-missing'],
    `a binding missing ${key} holds rather than matching itself`);
}
assert.deepEqual(evaluateStatusClaim(receipt, { at: NOW }).reasons, ['expected-binding-missing']);
const { artifact: droppedArtifact, ...withoutArtifact } = bindingOf(publication);
assert.deepEqual(evaluateStatusClaim(publication, { expected: withoutArtifact, at: NOW }).reasons, ['expected-binding-missing'],
  'an artifact-bound class is never admitted without an expected artifact');

// --- receipts carry structured metadata only --------------------------------
for (const [label, metadata] of [
  ['a raw stdout field', { stdout: 'HTTP/2 200' }],
  ['a raw log field', { logs: ['line'] }],
  ['a credential field', { apiKey: 'value' }],
  ['a nested credential field', { auth: { sessionToken: 'value' } }],
  ['a credential-shaped value', { note: 'Bearer abcdefghijklmnop' }],
  ['a secret-bearing URL', { endpoint: 'https://api.example.test/x?access_token=abc123456789' }],
  ['a URL with inline credentials', { endpoint: 'https://user:pw@api.example.test/x' }],
]) {
  assert.throws(() => buildStatusClaimReceipt({ ...input, metadata }), /prohibited content/, `${label} is refused, not redacted`);
}
for (const [label, metadata] of [
  ['raw output smuggled into a long string', { detail: 'x'.repeat(201) }],
  ['raw output smuggled into a multi-line string', { detail: 'line one\nline two' }],
  ['a function-shaped value', { detail: undefined }],
]) {
  assert.throws(() => buildStatusClaimReceipt({ ...input, metadata }), /structured metadata/, label);
}
// A receipt resealed around prohibited content is caught on evaluation too.
const smuggled = seal({ ...receipt, metadata: { transcript: 'x' } });
assert.deepEqual(evaluateStatusClaim(smuggled, context(smuggled)).reasons, ['prohibited-content']);
assert.deepEqual(prohibitedFindings({ metadata: { stdout: 'x' } }, 'r'), ['r.metadata.stdout exposes a raw private log']);
assert.deepEqual(prohibitedFindings('https://api.example.test/?token=abcdefgh', 'r'), ['r contains a secret-bearing URL']);
assert.deepEqual(prohibitedFindings({ statusCode: 200, latencyMs: 12 }), []);

// --- structural drift is malformed even with a consistent digest ------------
for (const [label, entry, reasons] of [
  ['a mistyped exit code', seal({ ...receipt, source: { ...receipt.source, exitCode: '0' } }), ['malformed-source']],
  ['an extra source field', seal({ ...receipt, source: { ...receipt.source, stderrLines: 3 } }), ['malformed-source']],
  ['a missing source field', seal({ ...receipt, source: { command: 'gh api rate_limit', exitCode: 0 } }), ['malformed-receipt', 'malformed-source']],
  ['a non-object source', seal({ ...receipt, source: 'gh api rate_limit' }), ['malformed-receipt', 'malformed-source']],
  ['a zero observation window', seal({ ...receipt, maxObservationAgeSeconds: 0 }), ['malformed-observation-window', 'stale-observation']],
  ['a tampered digest', { ...receipt, digest: digestOf('forged') }, ['digest-mismatch']],
  ['a foreign schema', seal({ ...receipt, schema: 'other_receipt/v1' }), ['schema-mismatch']],
  ['a foreign contract version', seal({ ...receipt, contractVersion: '2.0.0' }), ['contract-version-mismatch']],
]) {
  assert.deepEqual(evaluateStatusClaim(entry, context(receipt)).reasons, reasons, label);
  assert.equal(renderStatusClaim(entry, context(receipt)).factual, false);
}
for (const field of ['schema', 'claimClass', 'source', 'artifact', 'metadata', 'digest']) {
  const { [field]: dropped, ...partial } = receipt;
  assert.deepEqual(evaluateStatusClaim(partial, context(receipt)), { accepted: false, reasons: ['malformed-receipt'] }, `a receipt without ${field}`);
}
for (const entry of [null, undefined, 'receipt', 42, []]) {
  assert.deepEqual(evaluateStatusClaim(entry, context(receipt)), { accepted: false, reasons: ['malformed-receipt'] });
}

// --- an unverified rendering leaks nothing from the receipt it refused ------
const rejectedRendering = renderStatusClaim(smuggled, context(smuggled));
assert.equal(rejectedRendering.disposition, UNVERIFIED);
assert.equal(rejectedRendering.factual, false);
for (const secret of [smuggled.runtimeId, smuggled.claimKey, smuggled.source.command, smuggled.source.resultDigest, smuggled.observedAt, 'transcript']) {
  assert.ok(!rejectedRendering.statement.includes(secret), `the unverified rendering must not echo ${secret}`);
}
assert.ok(rejectedRendering.statement.startsWith('unverified status claim:'));

// --- placement receipt ------------------------------------------------------
assert.deepEqual(PLACEMENT_RECEIPT, {
  owner: 'coding-control-harness',
  enforcement: 'typed status-claim receipt producer with exact class/runtime/evidence/observation/idempotency binding',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, unverified-safe renderings, and one claim and delivery per receipt',
});
assert.ok(Object.isFrozen(PLACEMENT_RECEIPT));

console.log('status claim receipt tests: passed');
