import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTRACT_VERSION, PLACEMENT_RECEIPT, RECEIPT_SCHEMA, buildReceipt, emptyLedger,
  publishReceipt, receiptDigest, redactEvidence, redactionFindings, verifyIndependently,
} from './request-completion-receipt.mjs';

const read = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const fixture = read('../fixtures/henry-completion-receipt.v1.json');
const schema = read('../schemas/request-completion-receipt.schema.json');

// --- the offline fixture is the only coordination channel -------------------
assert.equal(fixture.contract, `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`);
const serialized = JSON.stringify(fixture);
assert.doesNotMatch(serialized, /https?:\/\//, 'the fixture must not point at a live network endpoint');
assert.doesNotMatch(serialized, /\brefs\/heads\/|\borigin\//, 'the fixture must not depend on mutable branch state');

// --- Henry consumer compatibility: rebuilding the fixture is byte-stable ----
const receipt = buildReceipt(fixture.scenario);
assert.deepEqual(receipt, fixture.expectedReceipt, 'receipt drifted from the versioned Henry fixture');
assert.equal(JSON.stringify(receipt), JSON.stringify(fixture.expectedReceipt));
assert.equal(receiptDigest(receipt), fixture.expectedReceipt.digest);

const verification = verifyIndependently(receipt, { verifierId: fixture.verifier.verifierId, at: fixture.verifier.at });
assert.deepEqual(verification, fixture.expectedVerification);
assert.equal(verification.result, 'verified');
assert.notEqual(verification.verifierId, receipt.executor, 'the fixture verifier is independent of the executor');

const published = publishReceipt(emptyLedger(), receipt, {
  expected: { henryRequestId: receipt.henryRequestId, workItemId: receipt.workItemId, repository: receipt.repository, headSha: receipt.headSha },
  verification, transport: 'confirmed', at: fixture.publishedAt,
});
assert.equal(published.decision, fixture.expectedDecision);
assert.equal(published.closesHenryRequest, fixture.expectedClosesHenryRequest);

// --- schema drift guard -----------------------------------------------------
assert.deepEqual(Object.keys(receipt).sort(), [...schema.required].sort(), 'receipt fields drifted from the published schema');
assert.equal(schema.properties.schema.const, RECEIPT_SCHEMA);
assert.equal(schema.properties.contractVersion.const, CONTRACT_VERSION);
assert.deepEqual([...schema.properties.outcome.enum].sort(), ['blocked', 'completed', 'failed', 'uncertain']);
assert.deepEqual(Object.keys(receipt.tests[0]).sort(), [...schema.properties.tests.items.required].sort());

// --- redaction --------------------------------------------------------------
assert.deepEqual(redactionFindings(receipt), [], 'the published receipt carries no sensitive content');
const receiptText = JSON.stringify(receipt);
for (const leak of ['ghp_', 'AKIA', 'Bearer ', 'PRIVATE KEY']) assert.ok(!receiptText.includes(leak), `receipt leaked ${leak}`);
assert.ok(JSON.stringify(fixture.scenario.evidence).includes('ghp_'), 'the fixture input must actually contain something to redact');
assert.equal(receipt.evidence.stdout, undefined, 'raw private logs are never published');
assert.match(receipt.evidence.stdoutDigest, /^sha256:[0-9a-f]{64}$/, 'raw logs survive only as a digest handle');
assert.equal(receipt.evidence.authorizationToken, undefined, 'credential fields are dropped');

const dirty = redactEvidence({
  apiKey: 'k', nested: { password: 'p', sessionCookie: 'c', note: 'fine' },
  logs: ['line one'], values: ['AKIAIOSFODNN7EXAMPLE', 'safe'],
});
assert.deepEqual(dirty, { logsDigest: dirty.logsDigest, nested: { note: 'fine' }, values: [dirty.values[0], 'safe'] });
assert.match(dirty.values[0], /^redacted:sha256:[0-9a-f]{64}$/, 'a credential nested in an array is reduced to a handle');
assert.deepEqual(redactionFindings({ evidence: { authToken: 'x' } }), ['receipt.evidence.authToken exposes a credential field']);
assert.deepEqual(redactionFindings({ evidence: { stderr: 'trace' } }), ['receipt.evidence.stderr exposes a raw private log']);
assert.deepEqual(redactionFindings({ evidence: { note: 'ghp_abcdefghijklmnopqrst' } }), ['receipt.evidence.note contains a credential-shaped value']);

// --- the rejection path must not archive what it rejected (finding 3) ------
const TOKEN = 'Bearer abcdefghijklmnopqrstuvwxyz0123456789';
const leaky = buildReceipt({
  henryRequestId: 'HENRY-REQ-LEAK', workItemId: 'wi-leak', repository: 'acme/fixture',
  headSha: 'e'.repeat(40), outcome: 'failed', executor: 'harness/executor',
  producedAt: '2026-09-20T00:00:00.000Z',
  tests: [{ name: 'receipt', command: 'node src/request-completion-receipt.test.mjs', status: 'failed', headSha: 'e'.repeat(40) }],
  evidence: { suite: 'npm test' },
  recovery: { reason: `auth failed with ${TOKEN}`, nextAction: 'rotate and retry', escalation: 'Jason authority' },
});
assert.ok(!JSON.stringify(leaky).includes(TOKEN), 'recovery metadata is redacted at build time');
assert.match(leaky.recovery.reason, /redacted:sha256:[0-9a-f]{64}/);
assert.equal(leaky.recovery.nextAction, 'rotate and retry', 'benign recovery text survives intact');

// Defence in depth: a hand-authored receipt that never passed through
// buildReceipt still must not land in the durable hold unredacted.
const rawRecovery = { ...leaky, recovery: { reason: `auth failed with ${TOKEN}`, nextAction: 'rotate and retry', escalation: 'Jason authority' } };
const held = publishReceipt(emptyLedger(), rawRecovery, {
  expected: { henryRequestId: 'HENRY-REQ-LEAK', workItemId: 'wi-leak', repository: 'acme/fixture', headSha: 'e'.repeat(40) },
  verification: verifyIndependently(rawRecovery, { verifierId: 'henry/verifier', at: '2026-09-20T00:01:00.000Z' }),
  at: '2026-09-20T00:02:00.000Z',
});
assert.equal(held.closesHenryRequest, false);
assert.ok(held.reasons.includes('sensitive-content'));
assert.ok(!JSON.stringify(held.ledger).includes(TOKEN), 'the durable ledger never archives the rejected credential');
assert.equal(Object.keys(held.ledger.receipts).length, 0);

// --- placement receipt ------------------------------------------------------
assert.deepEqual(PLACEMENT_RECEIPT, {
  owner: 'coding-control-harness',
  enforcement: 'typed receipt producer and independent-verification contract',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, held reasons, and explicit non-completion outcomes',
});
assert.ok(Object.isFrozen(PLACEMENT_RECEIPT));

console.log('request completion receipt contract tests: passed');
