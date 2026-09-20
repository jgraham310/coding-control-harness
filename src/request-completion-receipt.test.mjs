import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION, RECEIPT_SCHEMA, buildReceipt, emptyLedger, evaluateReceipt,
  publishReceipt, receiptDigest, verifyIndependently,
} from './request-completion-receipt.mjs';

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const base = {
  henryRequestId: 'HENRY-REQ-1', workItemId: 'wi-1', repository: 'acme/fixture', headSha: HEAD,
  outcome: 'completed', executor: 'harness/executor', producedAt: '2026-09-20T00:00:00.000Z',
  tests: [{ name: 'receipt', command: 'node test/receipt.test.mjs', status: 'passed', headSha: HEAD }],
  evidence: { suite: 'npm test' },
};
const expected = { henryRequestId: 'HENRY-REQ-1', workItemId: 'wi-1', repository: 'acme/fixture', headSha: HEAD };
const verifierOf = (receipt, verifierId = 'henry/verifier') => verifyIndependently(receipt, { verifierId, at: '2026-09-20T00:01:00.000Z' });
const reasonsFor = (input, context = {}) => evaluateReceipt(buildReceipt(input), { expected, verification: verifierOf(buildReceipt(input)), ...context }).reasons;

// --- schema -----------------------------------------------------------------
const receipt = buildReceipt(base);
assert.equal(receipt.schema, RECEIPT_SCHEMA);
assert.equal(receipt.contractVersion, CONTRACT_VERSION);
assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(receipt.recovery, null, 'a completion carries no recovery metadata');
assert.throws(() => buildReceipt({ ...base, headSha: 'abc' }), /full 40-character commit sha/);
assert.throws(() => buildReceipt({ ...base, outcome: 'done' }), /invalid outcome/);
assert.throws(() => buildReceipt({ ...base, outcome: 'failed' }), /recovery\.reason/, 'non-completion requires recovery metadata');
assert.throws(() => buildReceipt({ ...base, tests: [{ ...base.tests[0], status: 'green' }] }), /invalid test status/);

// The digest is canonical: declaration order of tests and evidence cannot change it.
const shuffled = buildReceipt({
  ...base,
  tests: [{ name: 'zz', command: 'c', status: 'passed', headSha: HEAD }, base.tests[0]],
  evidence: { b: 2, a: 1 },
});
const resorted = buildReceipt({
  ...base,
  tests: [base.tests[0], { name: 'zz', command: 'c', status: 'passed', headSha: HEAD }],
  evidence: { a: 1, b: 2 },
});
assert.equal(shuffled.digest, resorted.digest);
assert.equal(receiptDigest(receipt), receipt.digest);

// --- accepted path ----------------------------------------------------------
const good = evaluateReceipt(receipt, { expected, verification: verifierOf(receipt) });
assert.deepEqual(good, { accepted: true, reasons: [] });
const published = publishReceipt(emptyLedger(), receipt, { expected, verification: verifierOf(receipt), at: '2026-09-20T00:02:00.000Z' });
assert.equal(published.decision, 'accepted');
assert.equal(published.closesHenryRequest, true);
assert.equal(Object.keys(published.ledger.receipts).length, 1);

// --- exact-head binding -----------------------------------------------------
assert.ok(reasonsFor(base, { expected: { ...expected, headSha: OTHER_HEAD } }).includes('stale-head'));
assert.ok(reasonsFor({ ...base, tests: [{ ...base.tests[0], headSha: OTHER_HEAD }] }).includes('test-evidence-off-head'));

// --- request / work-item binding -------------------------------------------
assert.ok(reasonsFor({ ...base, henryRequestId: 'HENRY-REQ-2' }).includes('request-id-mismatch'));
assert.ok(reasonsFor({ ...base, workItemId: 'wi-2' }).includes('work-item-mismatch'));
assert.ok(reasonsFor({ ...base, repository: 'acme/other' }).includes('repository-mismatch'));

// An absent request binding holds instead of matching by default.
assert.ok(evaluateReceipt(receipt, { verification: verifierOf(receipt) }).reasons.includes('expected-binding-missing'));
assert.ok(evaluateReceipt(receipt, { expected: { ...expected, headSha: undefined }, verification: verifierOf(receipt) }).reasons.includes('expected-binding-missing'));
assert.equal(publishReceipt(emptyLedger(), receipt, { verification: verifierOf(receipt), at: '2026-09-20T00:02:00.000Z' }).closesHenryRequest, false);

// --- test evidence cannot be substituted by an assertion --------------------
assert.ok(reasonsFor({ ...base, tests: [] }).includes('missing-test-evidence'), 'a bare success claim is not evidence');
assert.ok(reasonsFor({ ...base, tests: [{ ...base.tests[0], status: 'queued' }] }).includes('test-not-passed'), 'a queued run is not evidence');
const narrated = buildReceipt({ ...base, tests: [], evidence: { summary: 'the agent reports the work is complete' } });
assert.equal(evaluateReceipt(narrated, { expected, verification: verifierOf(narrated) }).accepted, false);

// --- hand-authored receipts must satisfy the published shape (finding 1) ----
// A receipt can reach publish as raw JSON that never passed through buildReceipt.
// Forge one with a self-consistent digest so every other gate is satisfied.
const forge = (body) => ({ ...body, digest: receiptDigest(body) });
const canonical = { ...receipt };
delete canonical.digest;

const unnamed = forge({ ...canonical, tests: [{ status: 'passed', headSha: HEAD }] });
assert.equal(unnamed.digest, receiptDigest(unnamed), 'the forgery is internally consistent');
assert.equal(verifierOf(unnamed).result, 'verified', 'digest and head gates alone do not catch it');
assert.ok(evaluateReceipt(unnamed, { expected, verification: verifierOf(unnamed) }).reasons.includes('malformed-receipt'),
  'a test entry without a name or command is not a named deterministic test');

const noCommand = forge({ ...canonical, tests: [{ name: 'receipt', status: 'passed', headSha: HEAD }] });
assert.ok(evaluateReceipt(noCommand, { expected, verification: verifierOf(noCommand) }).reasons.includes('malformed-receipt'));

const padded = forge({ ...canonical, closesRequest: true });
assert.ok(evaluateReceipt(padded, { expected, verification: verifierOf(padded) }).reasons.includes('receipt-not-canonical'),
  'an unknown field cannot ride along in the receipt');

const rawEvidence = forge({ ...canonical, evidence: { stdout: 'ghp_aaaaaaaaaaaaaaaaaaaa' } });
const rawReasons = evaluateReceipt(rawEvidence, { expected, verification: verifierOf(rawEvidence) }).reasons;
assert.ok(rawReasons.includes('receipt-not-canonical') && rawReasons.includes('sensitive-content'),
  'unredacted evidence cannot bypass build-time redaction');

const missingRecovery = forge({ ...canonical, outcome: 'failed', recovery: null });
assert.ok(evaluateReceipt(missingRecovery, { expected, verification: verifierOf(missingRecovery) }).reasons.includes('malformed-receipt'));

// A receipt that is actually canonical still passes, whatever its key order.
const reordered = Object.fromEntries(Object.keys(receipt).reverse().map((key) => [key, receipt[key]]));
assert.deepEqual(evaluateReceipt(reordered, { expected, verification: verifierOf(receipt) }), { accepted: true, reasons: [] });

// --- verifier separation ----------------------------------------------------
assert.ok(evaluateReceipt(receipt, { expected }).reasons.includes('verification-missing'));
assert.ok(evaluateReceipt(receipt, { expected, verification: verifierOf(receipt, base.executor) }).reasons.includes('verifier-not-independent'));
assert.ok(evaluateReceipt(receipt, { expected, verification: { ...verifierOf(receipt), headSha: OTHER_HEAD } }).reasons.includes('verification-head-mismatch'));
assert.ok(evaluateReceipt(receipt, { expected, verification: { ...verifierOf(receipt), receiptDigest: 'sha256:0' } }).reasons.includes('verification-digest-mismatch'));

// The verifier recomputes rather than trusting the claim.
const tampered = { ...receipt, headSha: OTHER_HEAD };
assert.equal(verifierOf(tampered).result, 'rejected');
const unbound = buildReceipt({ ...base, tests: [{ ...base.tests[0], status: 'skipped' }], outcome: 'blocked', recovery: { reason: 'r', nextAction: 'n', escalation: 'e' } });
assert.equal(verifierOf(unbound).result, 'rejected');
assert.equal(evaluateReceipt(receipt, { expected, verification: { ...verifierOf(receipt), result: 'rejected' } }).accepted, false);

console.log('request completion receipt tests: passed');
