import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CONTRACT_VERSION, EVENT_KINDS, EVENT_RESULTS, PLACEMENT_RECEIPT, RECEIPT_SCHEMA,
  buildExecutionReceipt, deriveIdempotencyKey, dispatchDecision, emptyLedger,
  evaluateExecutionReceipt, readLedgerFile, receiptDigest, recordExecutionReceipt, recordToLedgerFile,
} from './execution-loop-receipt.mjs';

const run = promisify(execFile);
const script = new URL('./execution-loop-receipt.mjs', import.meta.url).pathname;
const read = (name) => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
const fixture = read('../fixtures/execution-loop-receipts.v1.json');
const schema = read('../schemas/execution-loop-receipt.schema.json');
const bindingOf = (r) => ({ taskId: r.taskId, repository: r.repository, headSha: r.headSha, eventKind: r.eventKind, producer: r.producer, idempotencyKey: r.idempotencyKey });

// --- the offline fixture is the only coordination channel -------------------
assert.equal(fixture.contract, `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`);
const serialized = JSON.stringify(fixture);
assert.doesNotMatch(serialized, /https?:\/\//, 'the fixture must not point at a live network endpoint');
assert.doesNotMatch(serialized, /\brefs\/heads\/|\borigin\//, 'the fixture must not depend on mutable branch state');

// --- a clean-clone consumer rebuilds every valid record byte for byte -------
for (const entry of fixture.valid) {
  const receipt = buildExecutionReceipt(entry.scenario);
  assert.deepEqual(receipt, entry.expectedReceipt, `${entry.name} drifted from the versioned fixture`);
  assert.equal(JSON.stringify(receipt), JSON.stringify(entry.expectedReceipt));
  assert.equal(receiptDigest(receipt), entry.expectedReceipt.digest);
  assert.equal(receipt.idempotencyKey, deriveIdempotencyKey(receipt), 'the key is derivable from the receipt alone');
  assert.deepEqual(evaluateExecutionReceipt(receipt, { expected: entry.expectedBinding, at: entry.evaluatedAt }), { accepted: true, reasons: [] });
  assert.equal(dispatchDecision(receipt, { expected: entry.expectedBinding, at: entry.evaluatedAt }).authorized, entry.expectedAuthorizesDispatch);
  assert.deepEqual(Object.keys(receipt).sort(), [...schema.required].sort(), `${entry.name} fields drifted from the published schema`);
}

// --- and rejects every invalid one, for exactly the stated reasons ----------
for (const entry of fixture.rejected) {
  const evaluation = evaluateExecutionReceipt(entry.receipt, { expected: entry.expectedBinding ?? bindingOf(entry.receipt), at: entry.at });
  assert.equal(evaluation.accepted, false, `${entry.name} must fail closed`);
  assert.deepEqual(evaluation.reasons, [...entry.reasons].sort(), `${entry.name} reasons drifted`);
  assert.equal(dispatchDecision(entry.receipt, { expected: entry.expectedBinding ?? bindingOf(entry.receipt), at: entry.at }).authorized, false);
}

// --- schema drift guard -----------------------------------------------------
assert.equal(schema.properties.schema.const, RECEIPT_SCHEMA);
assert.equal(schema.properties.contractVersion.const, CONTRACT_VERSION);
assert.deepEqual([...schema.properties.eventKind.enum].sort(), [...EVENT_KINDS].sort());
assert.deepEqual([...schema.properties.result.enum].sort(), [...new Set(Object.values(EVENT_RESULTS).flat())].sort());
assert.deepEqual(schema.properties.details.oneOf.map((entry) => entry.title).sort(), [...EVENT_KINDS].sort());

// --- typed construction refuses nonsense ------------------------------------
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const terminalInput = {
  taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, eventKind: 'pr_terminal', result: 'merged',
  occurrence: 'pr-77', producer: 'harness/loop', producedAt: '2026-09-21T00:00:00.000Z',
  details: { pullRequest: 77, mergeCommitSha: null }, evidence: { suite: 'npm test' },
};
assert.throws(() => buildExecutionReceipt({ ...terminalInput, eventKind: 'made_up' }), /invalid eventKind/);
assert.throws(() => buildExecutionReceipt({ ...terminalInput, result: 'idle_at_prompt' }), /invalid result/, 'a result from another kind is not transferable');
assert.throws(() => buildExecutionReceipt({ ...terminalInput, headSha: 'abc' }), /40-character/);
assert.throws(() => buildExecutionReceipt({ ...terminalInput, producedAt: 'yesterday' }), /ISO-8601/);
assert.throws(() => buildExecutionReceipt({ ...terminalInput, details: { pullRequest: 0 } }), /pullRequest/);
assert.throws(() => buildExecutionReceipt({ ...terminalInput, occurrence: '  ' }), /occurrence/);

// --- the key binds task, repo, head, kind, producer and occurrence exactly --
const terminal = buildExecutionReceipt(terminalInput);
const keys = new Set([
  terminal.idempotencyKey,
  deriveIdempotencyKey({ ...terminal, taskId: 'wi-12' }),
  deriveIdempotencyKey({ ...terminal, repository: 'acme/other' }),
  deriveIdempotencyKey({ ...terminal, headSha: OTHER_HEAD }),
  deriveIdempotencyKey({ ...terminal, eventKind: 'lane_liveness' }),
  deriveIdempotencyKey({ ...terminal, producer: 'impostor/execution-loop' }),
  deriveIdempotencyKey({ ...terminal, occurrence: 'pr-78' }),
]);
assert.equal(keys.size, 7, 'every binding component, producer included, changes the idempotency key');
assert.throws(() => deriveIdempotencyKey({ ...terminal, producer: '' }), /producer/, 'the key cannot be derived without a producer');
assert.match(terminal.idempotencyKey, /^sha256:[0-9a-f]{64}$/);

// --- a regression receipt is a typed failure, not a completion --------------
const regressionInput = {
  taskId: 'wi-11', repository: 'acme/fixture', headSha: HEAD, eventKind: 'regression_failed', result: 'reproduced_at_head',
  occurrence: 'attempt-1', producer: 'harness/loop', producedAt: '2026-09-21T00:01:00.000Z',
  details: { testName: 'lock', command: 'node test/lock.test.mjs', exitCode: 1 },
  evidence: { stdout: 'boom token=ghp_dddddddddddddddddddd', authorizationToken: 'ghp_eeeeeeeeeeeeeeeeeeee' },
};
const regression = buildExecutionReceipt(regressionInput);
assert.deepEqual(evaluateExecutionReceipt(regression, { expected: bindingOf(regression), at: '2026-09-21T00:02:00.000Z' }), { accepted: true, reasons: [] });
assert.equal(regression.evidence.stdout, undefined, 'raw private logs are never published');
assert.match(regression.evidence.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
assert.equal(regression.evidence.authorizationToken, undefined, 'credential fields are dropped');
assert.equal(dispatchDecision(regression, { expected: bindingOf(regression), at: '2026-09-21T00:02:00.000Z' }).authorized, false);

// --- ledger: replay dedupes, a rival under one key is held ------------------
const context = { expected: bindingOf(terminal), at: '2026-09-21T00:03:00.000Z' };
let ledger = emptyLedger();
const first = recordExecutionReceipt(ledger, terminal, context);
assert.equal(first.decision, 'recorded');
ledger = first.ledger;
const replay = recordExecutionReceipt(ledger, terminal, { ...context, at: '2026-09-21T00:04:00.000Z' });
assert.equal(replay.decision, 'deduplicated');
assert.equal(Object.keys(replay.ledger.records).length, 1);

const rival = buildExecutionReceipt({ ...terminalInput, result: 'closed_unmerged' });
assert.equal(rival.idempotencyKey, terminal.idempotencyKey, 'the same event at the same head shares one key');
const conflict = recordExecutionReceipt(ledger, rival, { ...context, at: '2026-09-21T00:05:00.000Z' });
assert.equal(conflict.decision, 'held');
assert.deepEqual(conflict.reasons, ['idempotency-conflict']);
assert.equal(conflict.ledger.records[terminal.idempotencyKey].digest, terminal.digest, 'an accepted record is immutable');

// A second PR terminal state for one task, under a *different* key, is held too.
const second = buildExecutionReceipt({ ...terminalInput, occurrence: 'pr-77-again', result: 'superseded' });
const secondResult = recordExecutionReceipt(ledger, second, { expected: bindingOf(second), at: '2026-09-21T00:06:00.000Z' });
assert.equal(secondResult.decision, 'held');
assert.deepEqual(secondResult.reasons, ['terminal-state-conflict']);

// A held record replayed verbatim dedupes rather than piling up.
const heldLedger = secondResult.ledger;
assert.equal(recordExecutionReceipt(heldLedger, second, { expected: bindingOf(second), at: '2026-09-21T00:06:00.000Z' }).decision, 'deduplicated_hold');
assert.equal(recordExecutionReceipt(heldLedger, second, { expected: bindingOf(second), at: '2026-09-21T00:06:00.000Z' }).ledger.holds.length, heldLedger.holds.length);

// --- provenance: a digest proves consistency, not authorship ---------------
// A digest only proves a body is internally consistent.  Authorship is carried
// by the producer being part of the derived key *and* of the expectation.
const IMPOSTOR = 'impostor/execution-loop';
const seal = (entry) => { const { digest, ...body } = entry; return { ...body, digest: receiptDigest(body) }; };

// An expectation that omits the producer holds; provenance is never optional.
const { producer: unusedProducer, ...producerless } = bindingOf(terminal);
assert.deepEqual(evaluateExecutionReceipt(terminal, { ...context, expected: producerless }).reasons, ['expected-binding-missing']);

// A receipt from another producer, however well formed, is not this one's.
const impostor = buildExecutionReceipt({ ...terminalInput, producer: IMPOSTOR });
assert.equal(impostor.digest, receiptDigest(impostor), 'the impostor receipt is internally consistent');
assert.notEqual(impostor.idempotencyKey, terminal.idempotencyKey, 'an impostor can never land on another producer key');
assert.deepEqual(evaluateExecutionReceipt(impostor, context).reasons, ['idempotency-key-mismatch', 'producer-mismatch']);
assert.deepEqual(evaluateExecutionReceipt(impostor, { ...context, expected: bindingOf(impostor) }), { accepted: true, reasons: [] },
  'the impostor receipt is admissible only under its own provenance, on its own key');

// Re-sealing another producer's body under a new name breaks the derivation ...
const renamed = seal({ ...terminal, producer: IMPOSTOR });
assert.equal(renamed.digest, receiptDigest(renamed), 'the forgery is internally consistent');
assert.deepEqual(evaluateExecutionReceipt(renamed, context).reasons, ['idempotency-key-unbound', 'producer-mismatch']);
// ... and stealing the expected name onto a foreign key is caught the same way.
const stolen = seal({ ...impostor, producer: terminal.producer });
assert.deepEqual(evaluateExecutionReceipt(stolen, context).reasons, ['idempotency-key-mismatch', 'idempotency-key-unbound']);
assert.equal(recordExecutionReceipt(ledger, renamed, context).recorded, false);
assert.equal(recordExecutionReceipt(ledger, stolen, context).recorded, false);

// A rival producer cannot file a second terminal state for the task either.
const collision = recordExecutionReceipt(ledger, impostor, { ...context, expected: bindingOf(impostor) });
assert.equal(collision.decision, 'held');
assert.deepEqual(collision.reasons, ['terminal-state-conflict']);
assert.equal(collision.ledger.records[terminal.idempotencyKey].producer, terminal.producer, 'the first producer record is untouched');

// Where repeats are legitimate, two producers are two records, never a collision.
const mine = buildExecutionReceipt({ ...regressionInput });
const theirs = buildExecutionReceipt({ ...regressionInput, producer: IMPOSTOR });
assert.notEqual(mine.idempotencyKey, theirs.idempotencyKey);
const both = recordExecutionReceipt(recordExecutionReceipt(emptyLedger(), mine, { expected: bindingOf(mine), at: '2026-09-21T00:03:00.000Z' }).ledger,
  theirs, { expected: bindingOf(theirs), at: '2026-09-21T00:03:00.000Z' });
assert.equal(both.decision, 'recorded');
assert.equal(Object.keys(both.ledger.records).length, 2, 'two producers, two records, one per provenance');

// --- details are discriminated by event kind, not merely present -----------
for (const [label, entry] of [
  ['another kind payload', seal({ ...terminal, details: { laneId: 'lane-a', observedAt: '2026-09-21T00:00:00.000Z', staleAfterSeconds: 60 } })],
  ['a mistyped field', seal({ ...terminal, details: { ...terminal.details, pullRequest: '77' } })],
  ['an extra property', seal({ ...terminal, details: { ...terminal.details, note: 'smuggled' } })],
  ['a missing field', seal({ ...terminal, details: { pullRequest: 77 } })],
  ['a non-object', seal({ ...terminal, details: 'merged' })],
  ['a null', seal({ ...terminal, details: null })],
]) {
  assert.deepEqual(evaluateExecutionReceipt(entry, { ...context, expected: bindingOf(entry) }).reasons, ['malformed-details'],
    `${label} is malformed even with a consistent digest`);
  assert.equal(recordExecutionReceipt(emptyLedger(), entry, { ...context, expected: bindingOf(entry) }).recorded, false);
}
// A regression receipt is held to its own payload shape too.
assert.deepEqual(evaluateExecutionReceipt(seal({ ...regression, details: { ...regression.details, exitCode: '1' } }),
  { expected: bindingOf(regression), at: '2026-09-21T00:03:00.000Z' }).reasons, ['malformed-details']);

// --- concurrent replay across processes writes exactly one record -----------
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-loop-receipt-'));
const ledgerPath = path.join(directory, 'ledger.json');
const args = (receipt, ctx) => ['record', '--ledger', ledgerPath, '--receipt', JSON.stringify(receipt), '--context', JSON.stringify(ctx)];
const concurrent = await Promise.all(Array.from({ length: 6 }, (_, index) =>
  run('node', [script, ...args(terminal, { ...context, at: `2026-09-21T01:0${index}:00.000Z` })]).then(({ stdout }) => JSON.parse(stdout))));
assert.equal(concurrent.filter((entry) => entry.decision === 'recorded').length, 1, 'exactly one publisher records from an empty ledger');
assert.equal(concurrent.filter((entry) => entry.decision === 'deduplicated').length, 5);
assert.equal(Object.keys(readLedgerFile(ledgerPath).records).length, 1);

// A cold race between rival receipts for one key still leaves one record.
const racePath = path.join(directory, 'race.json');
const rivals = [terminal, rival, buildExecutionReceipt({ ...terminalInput, result: 'superseded' })];
const race = await Promise.all(rivals.map((entry, index) =>
  run('node', [script, 'record', '--ledger', racePath, '--receipt', JSON.stringify(entry), '--context', JSON.stringify({ ...context, at: `2026-09-21T02:0${index}:00.000Z` })])
    .then(({ stdout }) => JSON.parse(stdout))));
assert.equal(race.filter((entry) => entry.recorded).length, 1, 'rival receipts cannot both record');
assert.equal(Object.keys(readLedgerFile(racePath).records).length, 1);

// --- a stale head is never recorded, in or out of process -------------------
const stale = buildExecutionReceipt({ ...terminalInput, headSha: OTHER_HEAD });
const staleResult = JSON.parse(execFileSync('node', [script, ...args(stale, { ...context, at: '2026-09-21T03:00:00.000Z' })], { encoding: 'utf8' }));
assert.equal(staleResult.recorded, false);
assert.ok(staleResult.reasons.includes('stale-head'));
assert.equal(Object.keys(readLedgerFile(ledgerPath).records).length, 1, 'a stale receipt changes nothing');

// --- a completion ledger is not an execution-loop ledger --------------------
const foreign = path.join(directory, 'completion-ledger.json');
fs.writeFileSync(foreign, `${JSON.stringify({ schema: 'engineering_completion_ledger/v1', contractVersion: '1.0.0', receipts: {}, holds: [] })}\n`);
assert.throws(() => readLedgerFile(foreign), /invalid execution-loop ledger/, 'a foreign contract is never read as this one');
assert.throws(() => recordToLedgerFile(foreign, terminal, context), /invalid execution-loop ledger/);
assert.equal(JSON.parse(fs.readFileSync(foreign, 'utf8')).schema, 'engineering_completion_ledger/v1', 'the foreign ledger is left untouched');
assert.equal(fs.existsSync(`${foreign}.lock`), false, 'the lock is released even when the ledger is rejected');

// --- placement receipt ------------------------------------------------------
assert.deepEqual(PLACEMENT_RECEIPT, {
  owner: 'coding-control-harness',
  enforcement: 'typed execution-loop receipt producer with exact task/repo/head/event/idempotency binding',
  governanceConsumer: 'Henry Operating System',
  contract: `${RECEIPT_SCHEMA}@${CONTRACT_VERSION}`,
  audit: 'immutable receipt digests, fail-closed hold reasons, and permanently bounded experiments',
});
assert.ok(Object.isFrozen(PLACEMENT_RECEIPT));

console.log('execution loop receipt tests: passed');
