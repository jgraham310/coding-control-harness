import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  UNVERIFIED, buildStatusClaimReceipt, deliverStatusClaim, deliverToLedgerFile, emptyLedger,
  readLedgerFile, receiptDigest,
} from './status-claim-receipt.mjs';

const run = promisify(execFile);
const script = new URL('./status-claim-receipt.mjs', import.meta.url).pathname;
const digestOf = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const bindingOf = (r) => ({ claimClass: r.claimClass, runtimeId: r.runtimeId, claimKey: r.claimKey, idempotencyKey: r.idempotencyKey, artifact: r.artifact });
const seal = (r) => { const { digest, ...body } = r; return { ...body, digest: receiptDigest(body) }; };

const RUNTIME = 'harness-runtime/lane-a';
const OTHER_RUNTIME = 'harness-runtime/lane-b';
const OBSERVED = '2026-09-22T12:00:00.000Z';
const NOW = '2026-09-22T12:01:00.000Z';
const DELIVERY = 'report-2026-09-22/delivery-1';

const receiptFor = (overrides = {}) => buildStatusClaimReceipt({
  claimClass: 'service_reachability', result: 'reachable', runtimeId: RUNTIME,
  claimKey: 'report-2026-09-22/github-reachable', observedAt: OBSERVED, maxObservationAgeSeconds: 300,
  source: { command: 'gh api rate_limit', exitCode: 0, resultDigest: digestOf('gh-api-rate-limit-ok') },
  metadata: { statusCode: 200, latencyMs: 142 }, producedAt: OBSERVED, ...overrides,
});
const contextFor = (receipt, overrides = {}) => ({ expected: bindingOf(receipt), at: NOW, deliveryKey: DELIVERY, ...overrides });

const receipt = receiptFor();

// --- one delivery, then a verbatim replay dedupes ---------------------------
let ledger = emptyLedger();
const first = deliverStatusClaim(ledger, receipt, contextFor(receipt));
assert.equal(first.decision, 'delivered');
assert.equal(first.delivered, true);
assert.equal(first.disposition, 'success');
assert.equal(first.factual, true);
ledger = first.ledger;

const replay = deliverStatusClaim(ledger, receipt, contextFor(receipt, { at: '2026-09-22T12:02:00.000Z' }));
assert.equal(replay.decision, 'deduplicated');
assert.equal(replay.delivered, true);
assert.equal(Object.keys(replay.ledger.records).length, 1, 'a replay never creates a second delivery');

// --- invariant 5: one receipt supports one claim and one delivery -----------
const secondDelivery = deliverStatusClaim(ledger, receipt, contextFor(receipt, { deliveryKey: 'report-2026-09-22/delivery-2' }));
assert.equal(secondDelivery.decision, 'held');
assert.equal(secondDelivery.delivered, false);
assert.deepEqual(secondDelivery.reasons, ['receipt-already-delivered']);
assert.equal(secondDelivery.disposition, UNVERIFIED);
assert.equal(secondDelivery.factual, false);

// A fresh observation of the same logical claim is a different receipt -- and
// still cannot restate a claim that has already been delivered.
const reobserved = receiptFor({ observedAt: '2026-09-22T12:00:30.000Z', producedAt: '2026-09-22T12:00:30.000Z' });
assert.notEqual(reobserved.idempotencyKey, receipt.idempotencyKey);
const restated = deliverStatusClaim(ledger, reobserved, contextFor(reobserved, { deliveryKey: 'report-2026-09-22/delivery-3' }));
assert.equal(restated.decision, 'held');
assert.deepEqual(restated.reasons, ['claim-already-delivered']);
assert.equal(restated.factual, false);

// A spent delivery key cannot be reused by an unrelated claim either.
const otherClaim = receiptFor({ claimKey: 'report-2026-09-22/tls-trusted' });
const reusedDelivery = deliverStatusClaim(ledger, otherClaim, contextFor(otherClaim));
assert.equal(reusedDelivery.decision, 'held');
assert.deepEqual(reusedDelivery.reasons, ['delivery-key-reused']);

// A delivery with no key at all is held rather than delivered anonymously.
const keyless = deliverStatusClaim(emptyLedger(), receipt, { expected: bindingOf(receipt), at: NOW });
assert.equal(keyless.decision, 'held');
assert.deepEqual(keyless.reasons, ['delivery-key-missing']);
assert.equal(keyless.factual, false);

// --- a rival receipt on the same key never overwrites the delivered one -----
const rival = seal({ ...receipt, metadata: { statusCode: 500, latencyMs: 142 } });
assert.equal(rival.idempotencyKey, receipt.idempotencyKey, 'the same observation shares one key');
assert.notEqual(rival.digest, receipt.digest);
const conflict = deliverStatusClaim(ledger, rival, contextFor(rival));
assert.equal(conflict.decision, 'held');
assert.deepEqual(conflict.reasons, ['idempotency-conflict']);
assert.equal(conflict.ledger.records[receipt.idempotencyKey].digest, receipt.digest, 'a delivered record is immutable');

// A held delivery replayed verbatim dedupes rather than piling up.
const heldLedger = conflict.ledger;
assert.equal(deliverStatusClaim(heldLedger, rival, contextFor(rival)).decision, 'deduplicated_hold');
assert.equal(deliverStatusClaim(heldLedger, rival, contextFor(rival)).ledger.holds.length, heldLedger.holds.length);

// --- inadmissible evidence is held and stores no prohibited text ------------
const ledgerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'status-claim-receipt-'));
const cases = [
  ['cross-runtime evidence', receiptFor({ runtimeId: OTHER_RUNTIME }), (r) => contextFor(receipt, { deliveryKey: 'd-cross' }), ['cross-runtime-evidence', 'idempotency-key-mismatch']],
  ['a stale observation', receiptFor({ observedAt: '2026-09-22T11:00:00.000Z', claimKey: 'c-stale' }), (r) => contextFor(r, { deliveryKey: 'd-stale' }), ['stale-observation']],
  ['contradictory evidence', receiptFor({ claimKey: 'c-contradictory', source: { command: 'gh api rate_limit', exitCode: 28, resultDigest: digestOf('timeout') } }), (r) => contextFor(r, { deliveryKey: 'd-contradictory' }), ['contradictory-evidence']],
  ['a resealed runtime', seal({ ...receiptFor({ claimKey: 'c-resealed' }), runtimeId: OTHER_RUNTIME }), (r) => contextFor({ ...r, runtimeId: OTHER_RUNTIME }, { deliveryKey: 'd-resealed' }), ['idempotency-key-unbound']],
  ['smuggled raw output', seal({ ...receiptFor({ claimKey: 'c-smuggled' }), metadata: { stdout: 'HTTP/2 200 ok' } }), (r) => contextFor(r, { deliveryKey: 'd-smuggled' }), ['prohibited-content']],
  ['a malformed body', { schema: 'status_claim_receipt/v1' }, () => contextFor(receipt, { deliveryKey: 'd-malformed' }), ['malformed-receipt']],
];
let faultLedger = emptyLedger();
for (const [label, entry, makeContext, reasons] of cases) {
  const result = deliverStatusClaim(faultLedger, entry, makeContext(entry));
  assert.equal(result.decision, 'held', label);
  assert.equal(result.delivered, false, label);
  assert.equal(result.disposition, UNVERIFIED, label);
  assert.equal(result.factual, false, label);
  assert.deepEqual(result.reasons, reasons, label);
  assert.ok(result.statement.startsWith('unverified status claim:'), label);
  faultLedger = result.ledger;
}
assert.equal(Object.keys(faultLedger.records).length, 0, 'no inadmissible claim was ever delivered');
assert.equal(faultLedger.holds.length, cases.length);
// Invariant 3: a hold stores the binding and the reasons, never the refused text.
const stored = JSON.stringify(faultLedger);
assert.doesNotMatch(stored, /HTTP\/2 200 ok/, 'a held receipt never stores raw command output');
assert.doesNotMatch(stored, /"(stdout|logs|transcript|metadata)"/, 'a held receipt stores no result payload at all');
assert.ok(faultLedger.holds.every((hold) => hold.reasons.length && hold.digest !== undefined && hold.deliveryKey !== undefined));

// --- the same checks hold across processes ----------------------------------
const ledgerPath = path.join(ledgerDirectory, 'ledger.json');
const args = (entry, ctx) => ['deliver', '--ledger', ledgerPath, '--receipt', JSON.stringify(entry), '--context', JSON.stringify(ctx)];
const deliver = (entry, ctx) => JSON.parse(execFileSync('node', [script, ...args(entry, ctx)], { encoding: 'utf8' }));

assert.equal(deliver(receipt, contextFor(receipt)).decision, 'delivered');
// Restart: a fresh process reads the persisted ledger and dedupes.
const afterRestart = deliver(receipt, contextFor(receipt, { at: '2026-09-22T12:03:00.000Z' }));
assert.equal(afterRestart.decision, 'deduplicated');
assert.equal(afterRestart.delivered, true);
assert.equal(Object.keys(readLedgerFile(ledgerPath).records).length, 1);

const staleOut = deliver(receiptFor({ observedAt: '2026-09-22T11:00:00.000Z', claimKey: 'c-stale-cli' }), contextFor(receipt, { deliveryKey: 'd-stale-cli', expected: undefined }));
assert.equal(staleOut.delivered, false);
assert.equal(staleOut.disposition, UNVERIFIED);
assert.equal(Object.keys(readLedgerFile(ledgerPath).records).length, 1, 'a stale observation changes nothing');

// --- concurrent publishers deliver exactly once -----------------------------
const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  run('node', [script, ...args(receipt, contextFor(receipt, { at: `2026-09-22T12:0${index}:00.000Z` }))]).then(({ stdout }) => JSON.parse(stdout))));
assert.deepEqual([...new Set(concurrent.map((entry) => entry.decision))], ['deduplicated']);
assert.equal(Object.keys(readLedgerFile(ledgerPath).records).length, 1);

// A cold race: six publishers, one empty ledger, exactly one delivery.
const racePath = path.join(ledgerDirectory, 'race.json');
const race = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  run('node', [script, 'deliver', '--ledger', racePath, '--receipt', JSON.stringify(receipt),
    '--context', JSON.stringify(contextFor(receipt, { at: `2026-09-22T12:0${index}:00.000Z` }))]).then(({ stdout }) => JSON.parse(stdout))));
assert.equal(race.filter((entry) => entry.decision === 'delivered').length, 1, 'exactly one publisher delivers from an empty ledger');
assert.equal(race.filter((entry) => entry.decision === 'deduplicated').length, 5);
assert.ok(race.every((entry) => entry.delivered && entry.disposition === 'success'));
assert.equal(Object.keys(readLedgerFile(racePath).records).length, 1);

// A cold race between *rival* receipts for one logical claim delivers one.
const rivalPath = path.join(ledgerDirectory, 'rival.json');
const rivals = Array.from({ length: 4 }, (_, index) => receiptFor({ observedAt: `2026-09-22T12:00:0${index}.000Z`, producedAt: `2026-09-22T12:00:0${index}.000Z` }));
const rivalResults = await Promise.all(rivals.map((entry, index) =>
  run('node', [script, 'deliver', '--ledger', rivalPath, '--receipt', JSON.stringify(entry),
    '--context', JSON.stringify(contextFor(entry, { deliveryKey: `d-rival-${index}` }))]).then(({ stdout }) => JSON.parse(stdout))));
assert.equal(rivalResults.filter((entry) => entry.delivered).length, 1, 'rival receipts cannot both state the claim');
assert.ok(rivalResults.filter((entry) => !entry.delivered).every((entry) => entry.reasons.includes('claim-already-delivered')));
assert.equal(Object.keys(readLedgerFile(rivalPath).claims).length, 1);

// --- a sibling ledger is never read as this one -----------------------------
const foreign = path.join(ledgerDirectory, 'execution-loop-ledger.json');
fs.writeFileSync(foreign, `${JSON.stringify({ schema: 'execution_loop_ledger/v1', contractVersion: '1.0.0', records: {}, holds: [] })}\n`);
assert.throws(() => readLedgerFile(foreign), /invalid status-claim ledger/);
assert.throws(() => deliverToLedgerFile(foreign, receipt, contextFor(receipt)), /invalid status-claim ledger/);
assert.equal(JSON.parse(fs.readFileSync(foreign, 'utf8')).schema, 'execution_loop_ledger/v1', 'the foreign ledger is left untouched');
assert.equal(fs.existsSync(`${foreign}.lock`), false, 'the lock is released even when the ledger is rejected');

console.log('status claim receipt fault tests: passed');
