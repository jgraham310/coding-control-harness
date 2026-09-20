import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildReceipt, readLedgerFile, receiptDigest, verifyIndependently } from './request-completion-receipt.mjs';

const run = promisify(execFile);
const script = new URL('./request-completion-receipt.mjs', import.meta.url).pathname;
const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'completion-receipt-')), 'ledger.json');
const HEAD = 'c'.repeat(40);
const STALE_HEAD = 'd'.repeat(40);

const receiptFor = (overrides = {}) => buildReceipt({
  henryRequestId: 'HENRY-REQ-9', workItemId: 'wi-9', repository: 'acme/fixture', headSha: HEAD,
  outcome: 'completed', executor: 'harness/executor', producedAt: '2026-09-20T00:00:00.000Z',
  tests: [{ name: 'receipt', command: 'node test/receipt.test.mjs', status: 'passed', headSha: HEAD }],
  evidence: { suite: 'npm test' }, ...overrides,
});
const expected = { henryRequestId: 'HENRY-REQ-9', workItemId: 'wi-9', repository: 'acme/fixture', headSha: HEAD };
const contextFor = (receipt, overrides = {}) => ({
  expected, transport: 'confirmed', at: '2026-09-20T00:02:00.000Z',
  verification: verifyIndependently(receipt, { verifierId: 'henry/verifier', at: '2026-09-20T00:01:00.000Z' }),
  ...overrides,
});
const args = (receipt, context) => ['publish', '--ledger', ledger, '--receipt', JSON.stringify(receipt), '--context', JSON.stringify(context)];
const publish = (receipt, context) => JSON.parse(execFileSync('node', [script, ...args(receipt, context)], { encoding: 'utf8' }));

const receipt = receiptFor();

// --- uncertain transport holds before anything is closed --------------------
const uncertain = publish(receipt, contextFor(receipt, { transport: 'uncertain' }));
assert.equal(uncertain.decision, 'held');
assert.equal(uncertain.closesHenryRequest, false);
assert.ok(uncertain.reasons.includes('transport-uncertain'));
assert.equal(Object.keys(readLedgerFile(ledger).receipts).length, 0, 'an uncertain publish closes nothing');

// --- the one valid publish --------------------------------------------------
const accepted = publish(receipt, contextFor(receipt));
assert.equal(accepted.decision, 'accepted');
assert.equal(accepted.closesHenryRequest, true);

// --- restart: a fresh process reads the persisted ledger and dedupes --------
const afterRestart = publish(receipt, contextFor(receipt, { at: '2026-09-20T01:00:00.000Z' }));
assert.equal(afterRestart.decision, 'deduplicated');
assert.equal(afterRestart.closesHenryRequest, true);
assert.equal(afterRestart.entry.digest, receipt.digest);
assert.equal(Object.keys(readLedgerFile(ledger).receipts).length, 1);

// --- concurrent publishers cannot create a second completion ----------------
const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  run('node', [script, ...args(receipt, contextFor(receipt, { at: `2026-09-20T02:0${index}:00.000Z` }))])
    .then(({ stdout }) => JSON.parse(stdout))));
assert.deepEqual([...new Set(concurrent.map((entry) => entry.decision))], ['deduplicated']);
assert.equal(Object.keys(readLedgerFile(ledger).receipts).length, 1, 'exactly one completion receipt survives concurrency');

// --- a cold race: six publishers, one empty ledger, one accepted receipt ----
const raceLedger = path.join(path.dirname(ledger), 'race.json');
const raceArgs = (entry, context) => ['publish', '--ledger', raceLedger, '--receipt', JSON.stringify(entry), '--context', JSON.stringify(context)];
const race = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  run('node', [script, ...raceArgs(receipt, contextFor(receipt, { at: `2026-09-20T02:1${index}:00.000Z` }))])
    .then(({ stdout }) => JSON.parse(stdout))));
assert.equal(race.filter((entry) => entry.decision === 'accepted').length, 1, 'exactly one publisher accepts from an empty ledger');
assert.equal(race.filter((entry) => entry.decision === 'deduplicated').length, 5);
assert.ok(race.every((entry) => entry.closesHenryRequest));
assert.equal(Object.keys(readLedgerFile(raceLedger).receipts).length, 1);

// A cold race between *different* receipts for one request accepts only one.
const rivalLedger = path.join(path.dirname(ledger), 'rival.json');
const rivals = Array.from({ length: 4 }, (_, index) => receiptFor({ producedAt: `2026-09-20T07:0${index}:00.000Z` }));
const rivalResults = await Promise.all(rivals.map((entry, index) =>
  run('node', [script, 'publish', '--ledger', rivalLedger, '--receipt', JSON.stringify(entry), '--context', JSON.stringify(contextFor(entry, { at: `2026-09-20T07:1${index}:00.000Z` }))])
    .then(({ stdout }) => JSON.parse(stdout))));
assert.equal(rivalResults.filter((entry) => entry.closesHenryRequest).length, 1, 'rival publishers cannot both close the request');
assert.ok(rivalResults.filter((entry) => !entry.closesHenryRequest).every((entry) => entry.reasons.includes('duplicate-completion-conflict')));
assert.equal(Object.keys(readLedgerFile(rivalLedger).receipts).length, 1);

// --- a superseded attempt at the same request is held, not stored -----------
const superseded = receiptFor({ producedAt: '2026-09-20T03:00:00.000Z' });
assert.notEqual(superseded.digest, receipt.digest);
const conflict = publish(superseded, contextFor(superseded, { at: '2026-09-20T03:01:00.000Z' }));
assert.equal(conflict.decision, 'held');
assert.deepEqual(conflict.reasons, ['duplicate-completion-conflict']);
assert.equal(readLedgerFile(ledger).receipts['HENRY-REQ-9'].digest, receipt.digest, 'the accepted receipt is immutable');

// --- stale head and mismatched request are never accepted -------------------
const stale = receiptFor({ headSha: STALE_HEAD, tests: [{ name: 'receipt', command: 'node test/receipt.test.mjs', status: 'passed', headSha: STALE_HEAD }] });
const staleResult = publish(stale, contextFor(stale, { at: '2026-09-20T04:00:00.000Z' }));
assert.equal(staleResult.closesHenryRequest, false);
assert.ok(staleResult.reasons.includes('stale-head'));

const mismatched = receiptFor({ henryRequestId: 'HENRY-REQ-10' });
const mismatchResult = publish(mismatched, contextFor(mismatched, { at: '2026-09-20T05:00:00.000Z' }));
assert.equal(mismatchResult.closesHenryRequest, false);
assert.ok(mismatchResult.reasons.includes('request-id-mismatch'));
assert.equal(readLedgerFile(ledger).receipts['HENRY-REQ-10'], undefined);

// --- a replayed hold dedupes instead of piling up ---------------------------
const holdsBefore = readLedgerFile(ledger).holds.length;
assert.equal(publish(stale, contextFor(stale, { at: '2026-09-20T04:00:00.000Z' })).decision, 'deduplicated_hold');
assert.equal(readLedgerFile(ledger).holds.length, holdsBefore);

// --- a forged receipt is rejected at the CLI boundary (finding 1) ----------
const forgedLedger = path.join(path.dirname(ledger), 'forged.json');
const forgedBody = { ...receipt, tests: [{ status: 'passed', headSha: HEAD }] };
delete forgedBody.digest;
const forged = { ...forgedBody, digest: receiptDigest(forgedBody) };
const forgedResult = JSON.parse(execFileSync('node', [script, 'publish', '--ledger', forgedLedger,
  '--receipt', JSON.stringify(forged), '--context', JSON.stringify(contextFor(forged))], { encoding: 'utf8' }));
assert.equal(forgedResult.closesHenryRequest, false, 'hand-authored JSON cannot close a request');
assert.ok(forgedResult.reasons.includes('malformed-receipt'));
assert.equal(Object.keys(readLedgerFile(forgedLedger).receipts).length, 0);

// --- a lock orphaned by a killed publisher is reclaimed (finding 4) --------
const orphanLedger = path.join(path.dirname(ledger), 'orphan.json');
const orphanLock = `${orphanLedger}.lock`;
fs.writeFileSync(orphanLock, JSON.stringify({ pid: 999999, at: '2026-09-20T00:00:00.000Z' }));
const orphanAge = new Date(Date.now() - 5 * 60 * 1000);
fs.utimesSync(orphanLock, orphanAge, orphanAge);
const orphanReceipt = receiptFor({ henryRequestId: 'HENRY-REQ-12', workItemId: 'wi-12' });
const reclaimed = JSON.parse(execFileSync('node', [script, 'publish', '--ledger', orphanLedger,
  '--receipt', JSON.stringify(orphanReceipt),
  '--context', JSON.stringify(contextFor(orphanReceipt, { expected: { ...expected, henryRequestId: 'HENRY-REQ-12', workItemId: 'wi-12' } }))], { encoding: 'utf8' }));
assert.equal(reclaimed.decision, 'accepted', 'a stale lock must not wedge publication');
assert.equal(fs.existsSync(orphanLock), false, 'the reclaimed lock is released');

// --- a failed execution is a typed non-completion ---------------------------
const failedLedger = path.join(path.dirname(ledger), 'failed.json');
const failed = buildReceipt({
  henryRequestId: 'HENRY-REQ-11', workItemId: 'wi-11', repository: 'acme/fixture', headSha: HEAD,
  outcome: 'failed', executor: 'harness/executor', producedAt: '2026-09-20T06:00:00.000Z',
  tests: [{ name: 'receipt', command: 'node test/receipt.test.mjs', status: 'failed', headSha: HEAD }],
  evidence: { suite: 'npm test' },
  recovery: { reason: 'deterministic target failed at the reviewed head', nextAction: 'repair and re-run at a new head', escalation: 'Jason authority required after one repair pass' },
});
const failedResult = JSON.parse(execFileSync('node', [script, 'publish', '--ledger', failedLedger, '--receipt', JSON.stringify(failed), '--context', JSON.stringify({
  expected: { ...expected, henryRequestId: 'HENRY-REQ-11', workItemId: 'wi-11' },
  verification: verifyIndependently(failed, { verifierId: 'henry/verifier', at: '2026-09-20T06:01:00.000Z' }),
  at: '2026-09-20T06:02:00.000Z',
})], { encoding: 'utf8' }));
assert.equal(failedResult.decision, 'held');
assert.equal(failedResult.closesHenryRequest, false);
assert.ok(failedResult.reasons.includes('non-completion-outcome'));
assert.equal(failedResult.entry.recovery.escalation, 'Jason authority required after one repair pass');
assert.equal(Object.keys(readLedgerFile(failedLedger).receipts).length, 0, 'a failure never closes the Henry request');

console.log('request completion receipt fault tests: passed');
