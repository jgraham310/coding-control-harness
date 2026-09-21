import assert from 'node:assert/strict';
import {
  DISPATCH_AUTHORIZING_STATE, EVENT_RESULTS, buildExecutionReceipt, dispatchDecision,
  emptyLedger, evaluateExecutionReceipt, receiptDigest, recordExecutionReceipt,
} from './execution-loop-receipt.mjs';

const HEAD = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
const OBSERVED = '2026-09-21T10:00:00.000Z';
const NOW = '2026-09-21T10:00:30.000Z';

const livenessInput = (overrides = {}) => ({
  taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, eventKind: 'lane_liveness',
  result: 'idle_at_prompt', occurrence: 'poll-1', producer: 'harness/loop',
  producedAt: OBSERVED, details: { laneId: 'lane-a', observedAt: OBSERVED, staleAfterSeconds: 60 },
  evidence: { probe: 'prompt-detector' }, ...overrides,
});
const bindingOf = (r) => ({ taskId: r.taskId, repository: r.repository, headSha: r.headSha, eventKind: r.eventKind, idempotencyKey: r.idempotencyKey });
const decide = (receipt, at = NOW) => dispatchDecision(receipt, { expected: bindingOf(receipt), at });

// --- the four states are exactly the ones the loop distinguishes ------------
assert.deepEqual([...EVENT_RESULTS.lane_liveness], ['executing', 'idle_at_prompt', 'stopped', 'unknown']);
assert.equal(DISPATCH_AUTHORIZING_STATE, 'idle_at_prompt');
assert.throws(() => buildExecutionReceipt(livenessInput({ result: 'probably_idle' })), /invalid result/);

// --- only an idle lane authorizes dispatch ----------------------------------
const decisions = Object.fromEntries(EVENT_RESULTS.lane_liveness.map((state) => {
  const receipt = buildExecutionReceipt(livenessInput({ result: state, occurrence: `poll-${state}` }));
  assert.deepEqual(evaluateExecutionReceipt(receipt, { expected: bindingOf(receipt), at: NOW }), { accepted: true, reasons: [] },
    `${state} is an admissible observation`);
  return [state, decide(receipt)];
}));
assert.deepEqual(decisions.idle_at_prompt, { authorized: true, reasons: [] });
assert.deepEqual(decisions.executing, { authorized: false, reasons: ['lane-executing'] });
assert.deepEqual(decisions.stopped, { authorized: false, reasons: ['lane-stopped'] });
assert.deepEqual(decisions.unknown, { authorized: false, reasons: ['lane-unknown'] }, 'unknown never authorizes dispatch');

const idle = buildExecutionReceipt(livenessInput());

// --- a stale observation fails closed even though it is well formed ---------
const stale = buildExecutionReceipt(livenessInput({ occurrence: 'poll-stale', details: { laneId: 'lane-a', observedAt: OBSERVED, staleAfterSeconds: 10 } }));
assert.deepEqual(evaluateExecutionReceipt(stale, { expected: bindingOf(stale), at: NOW }).reasons, ['stale-liveness-observation']);
assert.equal(decide(stale).authorized, false);
// Exactly at the window it still holds; one second past it is stale.
assert.equal(decide(idle, '2026-09-21T10:01:00.000Z').authorized, true);
assert.equal(decide(idle, '2026-09-21T10:01:01.000Z').authorized, false);
// An observation from the future is not fresh, it is unverifiable.
assert.deepEqual(decide(idle, '2026-09-21T09:59:59.000Z').reasons, ['stale-liveness-observation']);
// Without a clock a freshness claim cannot be checked, so it is not trusted.
assert.deepEqual(dispatchDecision(idle, { expected: bindingOf(idle) }).reasons, ['evaluation-time-missing']);

// A producer cannot stretch its own freshness window past the dispatcher's cap.
const wide = buildExecutionReceipt(livenessInput({ occurrence: 'poll-wide', details: { laneId: 'lane-a', observedAt: OBSERVED, staleAfterSeconds: 86400 } }));
assert.deepEqual(evaluateExecutionReceipt(wide, { expected: bindingOf(wide), at: NOW }), { accepted: true, reasons: [] });
assert.deepEqual(dispatchDecision(wide, { expected: bindingOf(wide), at: NOW, maxStaleSeconds: 60 }),
  { authorized: false, reasons: ['liveness-window-too-wide'] });
assert.equal(dispatchDecision(idle, { expected: bindingOf(idle), at: NOW, maxStaleSeconds: 60 }).authorized, true, 'a window inside the cap still dispatches');

// --- cross-task, stale-head, and forged receipts authorize nothing ----------
const other = buildExecutionReceipt(livenessInput({ taskId: 'wi-12' }));
assert.deepEqual(dispatchDecision(other, { expected: bindingOf(idle), at: NOW }).reasons, ['cross-task-receipt', 'idempotency-key-mismatch']);
const offHead = buildExecutionReceipt(livenessInput({ headSha: OTHER_HEAD }));
assert.ok(dispatchDecision(offHead, { expected: bindingOf(idle), at: NOW }).reasons.includes('stale-head'));
const tampered = { ...idle, result: 'idle_at_prompt', details: { ...idle.details, laneId: 'lane-z' } };
assert.deepEqual(dispatchDecision(tampered, { expected: bindingOf(idle), at: NOW }).reasons, ['digest-mismatch']);
// Re-sealing the tamper does not help: the key no longer derives from the body.
const resealed = (() => { const { digest, ...body } = { ...idle, taskId: 'wi-12' }; return { ...body, digest: receiptDigest(body) }; })();
assert.ok(dispatchDecision(resealed, { expected: bindingOf(idle), at: NOW }).reasons.includes('idempotency-key-unbound'));
// A truncated record is malformed, never a silent default.
assert.deepEqual(dispatchDecision({ schema: 'execution_loop_receipt/v1' }, { expected: bindingOf(idle), at: NOW }).reasons, ['malformed-receipt']);
assert.deepEqual(dispatchDecision(null, { expected: bindingOf(idle), at: NOW }).reasons, ['malformed-receipt']);
// A malformed record holds rather than crashing the publisher.
const malformed = recordExecutionReceipt(emptyLedger(), { schema: 'execution_loop_receipt/v1' }, { expected: bindingOf(idle), at: NOW });
assert.equal(malformed.decision, 'held');
assert.deepEqual(malformed.reasons, ['malformed-receipt']);
assert.equal(malformed.ledger.holds.at(-1).at, NOW);
const timeless = recordExecutionReceipt(emptyLedger(), { eventKind: 'lane_liveness' }, { expected: bindingOf(idle) });
assert.equal(timeless.decision, 'held');
assert.equal(timeless.ledger.holds.at(-1).at, null);
// A completion-style expectation that omits the event kind holds rather than matching.
assert.deepEqual(dispatchDecision(idle, { expected: { taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, idempotencyKey: idle.idempotencyKey }, at: NOW }).reasons, ['expected-binding-missing']);
// A terminal receipt is not a liveness signal, however valid it is.
const terminal = buildExecutionReceipt({
  taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, eventKind: 'pr_terminal', result: 'merged',
  occurrence: 'pr-1', producer: 'harness/loop', producedAt: OBSERVED, details: { pullRequest: 1, mergeCommitSha: null }, evidence: {},
});
assert.deepEqual(decide(terminal), { authorized: false, reasons: ['not-a-liveness-receipt'] });

// --- two lanes observed at one head are distinct records, not a conflict ----
const context = (receipt, at = NOW) => ({ expected: bindingOf(receipt), at });
const laneB = buildExecutionReceipt(livenessInput({ occurrence: 'poll-2', details: { laneId: 'lane-b', observedAt: OBSERVED, staleAfterSeconds: 60 }, result: 'executing' }));
let ledger = recordExecutionReceipt(emptyLedger(), idle, context(idle)).ledger;
const second = recordExecutionReceipt(ledger, laneB, context(laneB));
assert.equal(second.decision, 'recorded');
assert.equal(Object.keys(second.ledger.records).length, 2);
assert.equal(second.ledger.records[idle.idempotencyKey].authorizes, true);
assert.equal(second.ledger.records[laneB.idempotencyKey].authorizes, false);

// A replayed poll dedupes and cannot re-authorize a second dispatch.
const replay = recordExecutionReceipt(second.ledger, idle, context(idle, '2026-09-21T10:00:40.000Z'));
assert.equal(replay.decision, 'deduplicated');
assert.equal(Object.keys(replay.ledger.records).length, 2);

// A later poll of the same lane is a new occurrence, recorded on its own key.
const later = buildExecutionReceipt(livenessInput({ occurrence: 'poll-3', result: 'stopped', producedAt: '2026-09-21T10:02:00.000Z', details: { laneId: 'lane-a', observedAt: '2026-09-21T10:02:00.000Z', staleAfterSeconds: 60 } }));
const third = recordExecutionReceipt(replay.ledger, later, context(later, '2026-09-21T10:02:10.000Z'));
assert.equal(third.decision, 'recorded');
assert.equal(third.authorizes, false);
assert.equal(third.ledger.records[idle.idempotencyKey].authorizes, true, 'an earlier record is never rewritten');

// A stale observation is held with its reason, and never recorded.
const held = recordExecutionReceipt(third.ledger, stale, context(stale));
assert.equal(held.decision, 'held');
assert.deepEqual(held.reasons, ['stale-liveness-observation']);
assert.equal(held.ledger.records[stale.idempotencyKey], undefined);
assert.equal(held.ledger.holds.at(-1).eventKind, 'lane_liveness');

console.log('liveness receipt tests: passed');
