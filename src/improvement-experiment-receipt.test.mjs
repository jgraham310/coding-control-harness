import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EVENT_RESULTS, buildExecutionReceipt, dispatchDecision, emptyLedger, evaluateExecutionReceipt,
  readLedgerFile, receiptDigest, recordExecutionReceipt, recordToLedgerFile,
} from './execution-loop-receipt.mjs';

const HEAD = 'e'.repeat(40);
const AT = '2026-09-21T09:00:00.000Z';
const NOW = '2026-09-21T09:01:00.000Z';
const EXPIRES = '2026-09-28T00:00:00.000Z';

const experimentInput = (overrides = {}) => ({
  taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, eventKind: 'improvement_experiment',
  result: 'improved', occurrence: 'exp-1-iteration-1', producer: 'harness/loop', producedAt: AT,
  details: {
    experimentId: 'exp-dispatch-backoff',
    hypothesis: 'a longer idle confirmation window lowers duplicate dispatch',
    bounds: { maxIterations: 3, expiresAt: EXPIRES },
  },
  evidence: { sampleSize: 12 }, ...overrides,
});
const bindingOf = (r) => ({ taskId: r.taskId, repository: r.repository, headSha: r.headSha, eventKind: r.eventKind, idempotencyKey: r.idempotencyKey });
const reseal = (receipt) => { const { digest, ...body } = receipt; return { ...body, digest: receiptDigest(body) }; };
const evaluate = (receipt, at = NOW) => evaluateExecutionReceipt(receipt, { expected: bindingOf(receipt), at });

// --- an experiment receipt records an outcome, never a promotion -----------
assert.deepEqual([...EVENT_RESULTS.improvement_experiment], ['improved', 'regressed', 'inconclusive']);
const experiment = buildExecutionReceipt(experimentInput());
assert.deepEqual(evaluate(experiment), { accepted: true, reasons: [] });
assert.equal(experiment.details.permanent, false);

// Permanence is not producer-settable: the builder ignores the claim ...
const claimed = buildExecutionReceipt(experimentInput({ details: { ...experimentInput().details, permanent: true } }));
assert.equal(claimed.details.permanent, false, 'a producer cannot build a permanent experiment');
assert.equal(claimed.digest, experiment.digest, 'the permanence claim leaves no trace in the receipt');

// ... and a hand-forged, correctly re-sealed receipt still fails closed.
const forged = reseal({ ...experiment, details: { ...experiment.details, permanent: true } });
assert.equal(forged.digest, receiptDigest(forged), 'the forgery is internally consistent');
assert.deepEqual(evaluate(forged).reasons, ['experiment-marked-permanent']);
assert.equal(recordExecutionReceipt(emptyLedger(), forged, { expected: bindingOf(forged), at: NOW }).recorded, false);
for (const missing of [undefined, null, 'no', 0]) {
  assert.ok(evaluate(reseal({ ...experiment, details: { ...experiment.details, permanent: missing } })).reasons.includes('experiment-marked-permanent'),
    `permanent=${String(missing)} is not an acceptable substitute for false`);
}

// --- bounds are mandatory and must be real bounds ---------------------------
assert.throws(() => buildExecutionReceipt(experimentInput({ details: { experimentId: 'e', hypothesis: 'h' } })), /maxIterations/);
assert.throws(() => buildExecutionReceipt(experimentInput({ details: { experimentId: 'e', hypothesis: 'h', bounds: { maxIterations: 0, expiresAt: EXPIRES } } })), /maxIterations/);
assert.throws(() => buildExecutionReceipt(experimentInput({ details: { experimentId: 'e', hypothesis: 'h', bounds: { maxIterations: 3, expiresAt: 'never' } } })), /ISO-8601/);
assert.throws(() => buildExecutionReceipt(experimentInput({ details: { ...experimentInput().details, hypothesis: '' } })), /hypothesis/);
for (const bounds of [undefined, null, { maxIterations: 3 }, { maxIterations: Infinity, expiresAt: EXPIRES }]) {
  assert.ok(evaluate(reseal({ ...experiment, details: { ...experiment.details, bounds } })).reasons.includes('experiment-bounds-missing'),
    'an unbounded experiment receipt is inadmissible');
}

// --- an expired experiment fails closed, and a clockless one is not trusted -
assert.deepEqual(evaluate(experiment, '2026-10-01T00:00:00.000Z').reasons, ['experiment-expired']);
assert.deepEqual(evaluate(experiment, EXPIRES), { accepted: true, reasons: [] }, 'the bound is inclusive at its edge');
assert.deepEqual(evaluateExecutionReceipt(experiment, { expected: bindingOf(experiment) }).reasons, ['evaluation-time-missing']);

// --- an experiment receipt never authorizes dispatch ------------------------
assert.deepEqual(dispatchDecision(experiment, { expected: bindingOf(experiment), at: NOW }), { authorized: false, reasons: ['not-a-liveness-receipt'] });

// --- recorded experiment results are immutable ------------------------------
const context = (receipt, at = NOW) => ({ expected: bindingOf(receipt), at });
let ledger = recordExecutionReceipt(emptyLedger(), experiment, context(experiment)).ledger;
const rewrite = reseal({ ...experiment, result: 'regressed' });
const rewritten = recordExecutionReceipt(ledger, rewrite, context(experiment));
assert.equal(rewritten.decision, 'held');
assert.deepEqual(rewritten.reasons, ['idempotency-conflict']);
assert.equal(rewritten.ledger.records[experiment.idempotencyKey].result, 'improved', 'a recorded iteration is never rewritten');

// A further iteration is its own record, bounded by the same expiry.
const iteration2 = buildExecutionReceipt(experimentInput({ occurrence: 'exp-1-iteration-2', result: 'regressed', producedAt: '2026-09-21T09:30:00.000Z' }));
const second = recordExecutionReceipt(rewritten.ledger, iteration2, context(iteration2, '2026-09-21T09:31:00.000Z'));
assert.equal(second.decision, 'recorded');
assert.equal(Object.keys(second.ledger.records).length, 2);
assert.equal(second.ledger.records[experiment.idempotencyKey].details.permanent, false);
assert.ok(Object.values(second.ledger.records).every((entry) => entry.details.permanent === false && entry.authorizes === false),
  'no path through the ledger makes an experiment permanent or dispatch-authorizing');

// A replay of iteration one dedupes rather than counting twice.
assert.equal(recordExecutionReceipt(second.ledger, experiment, context(experiment, '2026-09-21T09:40:00.000Z')).decision, 'deduplicated');

// --- the same holds across processes, through the file adapter --------------
const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'improvement-experiment-')), 'ledger.json');
const script = new URL('./execution-loop-receipt.mjs', import.meta.url).pathname;
const record = (receipt, at) => JSON.parse(execFileSync('node', [script, 'record', '--ledger', ledgerPath,
  '--receipt', JSON.stringify(receipt), '--context', JSON.stringify(context(receipt, at))], { encoding: 'utf8' }));
assert.equal(record(experiment, NOW).decision, 'recorded');
assert.equal(record(experiment, '2026-09-21T09:05:00.000Z').decision, 'deduplicated');
assert.equal(record(forged, '2026-09-21T09:06:00.000Z').recorded, false);
const expired = recordToLedgerFile(ledgerPath, iteration2, context(iteration2, '2026-10-02T00:00:00.000Z'));
assert.deepEqual(expired.reasons, ['experiment-expired']);
const persisted = readLedgerFile(ledgerPath);
assert.equal(Object.keys(persisted.records).length, 1, 'only the one admissible iteration survives');
assert.ok(Object.values(persisted.records).every((entry) => entry.details.permanent === false));
assert.ok(persisted.holds.some((entry) => entry.reasons.includes('experiment-marked-permanent')));

console.log('improvement experiment receipt tests: passed');
