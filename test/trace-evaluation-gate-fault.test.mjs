import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  METADATA_FIELDS, calibrateEvaluator, claimProtection, emptyLedger, evaluateCalibration,
  evaluateSample, ingestSample, protectionStatus, readLedgerFile,
} from '../src/trace-evaluation-gate.mjs';

const script = new URL('../src/trace-evaluation-gate.mjs', import.meta.url).pathname;
const HEAD = 'c'.repeat(40);
const OTHER_HEAD = 'd'.repeat(40);
const digestOf = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;
const metadata = { failureSignature: 'terminal-exit-nonzero:lock-contention', component: 'harness/lock', exitClass: 'nonzero_exit' };
// One sentence of real trace content.  No admitted field may ever hold it, and
// no word of it may ever reach the ledger.
const RAW_SENTENCE = 'the operator asked the agent to delete the production database and it agreed';
const RAW_WORDS = ['operator', 'production', 'database', 'agreed', 'delete'];
const carriesRawSentence = (value) => {
  const serialized = JSON.stringify(value);
  return serialized.includes(RAW_SENTENCE) || RAW_WORDS.some((word) => serialized.includes(word));
};
const sampleFor = (overrides = {}) => ({
  sampleId: 'trace-1', source: 'lane/alpha', observedAt: '2026-09-22T00:00:00.000Z',
  outcome: 'failed', sourceDigest: digestOf('1'), metadata, ...overrides,
});
const reasonsOf = (input) => evaluateSample(input).reasons;

// --- invariant 1: raw trace content is rejected, never stored ---------------
for (const field of ['rawTrace', 'content', 'prompt', 'response', 'messages', 'trace', 'body']) {
  assert.deepEqual(reasonsOf(sampleFor({ [field]: 'whatever the pipeline captured' })), ['raw-content-field'], `${field} must be rejected`);
}
assert.deepEqual(reasonsOf(sampleFor({ secret: 'whatever the pipeline captured' })), ['raw-content-field', 'sensitive-content'], 'a secret field is both raw content and a credential');
assert.deepEqual(reasonsOf(sampleFor({ metadata: { ...metadata, prompt: 'you are a helpful agent' } })), ['raw-content-field'], 'raw content nested in metadata is still raw content');
assert.deepEqual(reasonsOf(sampleFor({ context: [{ ok: 1 }, { response: 'leaked' }] })), ['raw-content-field', 'unsafe-metadata'], 'raw content inside an array is still raw content');
assert.deepEqual(reasonsOf(sampleFor({ apiKey: 'AKIAIOSFODNN7EXAMPLE' })), ['sensitive-content', 'unsafe-metadata']);
assert.deepEqual(reasonsOf(sampleFor({ note: 'token ghp_aaaaaaaaaaaaaaaaaaaa' })), ['sensitive-content', 'unsafe-metadata'], 'a credential-shaped value is rejected wherever it hides');
assert.deepEqual(reasonsOf(sampleFor({ stdout: 'the whole private log' })), ['sensitive-content', 'unsafe-metadata']);

// --- the allowlist, not the denylist, is what holds ------------------------
// A benign-looking key is exactly how raw content would travel, so anything
// outside the triage allowlist is rejected whatever it is called.
for (const key of ['note', 'userMessage', 'customPayload', 'summary', 'detail', 'reasoning', 'excerpt']) {
  assert.ok(!(key in METADATA_FIELDS), `${key} must not be an allowlisted field`);
  assert.deepEqual(reasonsOf(sampleFor({ [key]: RAW_SENTENCE })), ['unsafe-metadata'], `envelope field ${key} must be rejected`);
  assert.deepEqual(reasonsOf(sampleFor({ metadata: { ...metadata, [key]: RAW_SENTENCE } })), ['unsafe-metadata'], `metadata field ${key} must be rejected`);
}
// And an allowlisted key cannot hold a sentence either: admitted strings are
// single tokens, so there is nowhere in an admitted sample to spell prose.
for (const key of Object.keys(METADATA_FIELDS)) {
  assert.deepEqual(reasonsOf(sampleFor({ metadata: { ...metadata, [key]: RAW_SENTENCE } })), ['unsafe-metadata'], `${key} must reject a raw sentence`);
}
assert.deepEqual(reasonsOf(sampleFor({ metadata: { ...metadata, attempts: 'three attempts, then it gave up' } })), ['unsafe-metadata']);
assert.deepEqual(reasonsOf(sampleFor({ sampleId: RAW_SENTENCE })), ['unsafe-metadata'], 'the identifier is not a hiding place either');
assert.deepEqual(reasonsOf(sampleFor({ source: RAW_SENTENCE })), ['unsafe-metadata']);

// --- and no word of a rejected sentence reaches the ledger -----------------
let probe = emptyLedger();
for (const attempt of [
  sampleFor({ note: RAW_SENTENCE }),
  sampleFor({ userMessage: RAW_SENTENCE }),
  sampleFor({ customPayload: { detail: RAW_SENTENCE } }),
  sampleFor({ metadata: { ...metadata, note: RAW_SENTENCE } }),
  sampleFor({ metadata: { ...metadata, failureSignature: RAW_SENTENCE } }),
  sampleFor({ sampleId: RAW_SENTENCE }),
  sampleFor({ rawTrace: RAW_SENTENCE }),
]) {
  const outcome = ingestSample(probe, attempt, { at: '2026-09-22T00:00:01.000Z' });
  assert.equal(outcome.decision === 'held' || outcome.decision === 'deduplicated_hold', true, 'every raw-content sample is held');
  probe = outcome.ledger;
}
assert.equal(Object.keys(probe.modes).length, 0, 'no rejected sample opened a failure mode');
assert.equal(carriesRawSentence(probe), false, 'no word of the raw sentence persists in the ledger');

// --- missing provenance and non-terminal samples are typed rejections -------
assert.deepEqual(reasonsOf(sampleFor({ sourceDigest: undefined })), ['missing-source-digest']);
assert.deepEqual(reasonsOf(sampleFor({ sourceDigest: 'not-a-digest' })), ['missing-source-digest']);
assert.deepEqual(reasonsOf(sampleFor({ outcome: 'succeeded' })), ['non-terminal-sample'], 'only terminal failures are admissible');
assert.deepEqual(reasonsOf(sampleFor({ outcome: undefined, sourceDigest: undefined })), ['missing-source-digest', 'non-terminal-sample']);
assert.deepEqual(reasonsOf(sampleFor({ metadata: { nested: { deep: 1 } } })), ['unsafe-metadata'], 'metadata must stay allowlisted and scalar');
assert.deepEqual(reasonsOf(sampleFor({ metadata: {} })), ['unsafe-metadata']);
assert.deepEqual(reasonsOf(sampleFor({ metadata: undefined })), ['unsafe-metadata']);
assert.deepEqual(reasonsOf(sampleFor({ metadata: { ...metadata, component: 'x'.repeat(81) } })), ['unsafe-metadata'], 'an oversize token is not a token');
assert.deepEqual(reasonsOf(sampleFor({ metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) })), ['unsafe-metadata']);
assert.deepEqual(reasonsOf(sampleFor({ observedAt: 'yesterday' })), ['malformed-sample']);

let ledger = emptyLedger();
const rejected = ingestSample(ledger, sampleFor({ rawTrace: 'leaked' }), { at: '2026-09-22T00:00:01.000Z' });
assert.equal(rejected.decision, 'held');
assert.deepEqual(rejected.reasons, ['raw-content-field']);
assert.equal(Object.keys(rejected.ledger.modes).length, 0, 'a rejected sample opens no failure mode');
assert.equal(JSON.stringify(rejected.ledger).includes('leaked'), false, 'rejected raw content is never stored');
assert.equal(ingestSample(rejected.ledger, sampleFor({ rawTrace: 'leaked' }), { at: '2026-09-22T00:00:02.000Z' }).decision, 'deduplicated_hold');

// --- invariant 4: a replayed sample creates nothing -------------------------
ledger = ingestSample(ledger, sampleFor(), { at: '2026-09-22T00:01:00.000Z' }).ledger;
const modeKey = Object.keys(ledger.modes)[0];
const replay = ingestSample(ledger, sampleFor({ sampleId: 'trace-1-again', source: 'lane/beta', observedAt: '2026-09-22T00:02:00.000Z' }), { at: '2026-09-22T00:02:01.000Z' });
assert.equal(replay.decision, 'deduplicated');
assert.deepEqual(replay.reasons, ['replayed-sample']);
assert.equal(Object.keys(replay.ledger.modes).length, 1);
assert.equal(replay.ledger.modes[modeKey].observations.length, 1, 'a replayed source digest adds no observation');
ledger = replay.ledger;

// --- invariant 3: an uncalibrated evaluator cannot protect anything ---------
const claimFor = (overrides = {}) => ({
  candidateHead: HEAD, testName: 'trace-evaluation-gate', command: 'node test/trace-evaluation-gate.test.mjs',
  status: 'passed', headSha: HEAD, producer: 'harness/regression', executedAt: '2026-09-22T02:00:00.000Z', ...overrides,
});
const uncalibrated = claimProtection(ledger, modeKey, claimFor(), { expected: { candidateHead: HEAD }, at: '2026-09-22T02:00:01.000Z' });
assert.equal(uncalibrated.decision, 'held');
assert.deepEqual(uncalibrated.reasons, ['evaluator-uncalibrated']);
assert.equal(protectionStatus(uncalibrated.ledger, modeKey, HEAD).isProtected, false);

// --- invariant 2: what calibration will not accept --------------------------
const baseline = {
  evaluatorId: 'evaluator/lock-contention-v1',
  threshold: 0.75,
  calibration: { samples: 40, labeler: { id: 'human/triage-lead', kind: 'human' }, confusion: { truePositives: 18, falsePositives: 2, trueNegatives: 18, falseNegatives: 2 } },
  heldOut: { samples: 20, confusion: { truePositives: 8, falsePositives: 1, trueNegatives: 10, falseNegatives: 1 } },
  reviewers: [{ id: 'human/triage-lead', verdict: 'agree' }, { id: 'human/reviewer-2', verdict: 'agree' }],
  calibratedAt: '2026-09-22T01:00:00.000Z',
};
const calibrationReasons = (overrides) => evaluateCalibration({ ...baseline, ...overrides }).reasons;
assert.deepEqual(calibrationReasons({ threshold: undefined }), ['threshold-missing']);
assert.deepEqual(calibrationReasons({ threshold: 0 }), ['threshold-missing']);
assert.deepEqual(calibrationReasons({ heldOut: undefined }), ['held-out-missing'], 'calibration alone never admits');
assert.deepEqual(calibrationReasons({ heldOut: { samples: 0, confusion: baseline.heldOut.confusion } }), ['held-out-missing']);
assert.deepEqual(calibrationReasons({ calibration: { ...baseline.calibration, samples: undefined } }), ['calibration-incomplete']);
assert.deepEqual(calibrationReasons({ calibration: { ...baseline.calibration, confusion: undefined } }), ['confusion-matrix-missing']);
assert.deepEqual(calibrationReasons({ heldOut: { samples: 20, confusion: { truePositives: 8, falsePositives: 1, trueNegatives: 1, falseNegatives: 1 } } }), ['confusion-matrix-missing'], 'confusion counts must account for every sample');
assert.deepEqual(calibrationReasons({ calibration: { ...baseline.calibration, labeler: { id: 'evaluator/lock-contention-v1', kind: 'human' } } }), ['self-score-only'], 'the evaluator cannot label its own calibration set');
assert.deepEqual(calibrationReasons({ calibration: { ...baseline.calibration, labeler: { id: 'evaluator/lock-contention-v1', kind: 'model' } } }), ['self-score-only']);
assert.deepEqual(calibrationReasons({ calibration: { ...baseline.calibration, labeler: { id: 'judge/llm-v2', kind: 'model' } } }), ['self-score-only'], 'a model-labeled set is a self-score whatever it is named');
assert.deepEqual(calibrationReasons({ reviewers: [{ id: 'human/triage-lead', verdict: 'agree' }, { id: 'human/reviewer-2', verdict: 'disagree' }] }), ['evaluator-disagreement']);
assert.deepEqual(calibrationReasons({ reviewers: [{ id: 'human/triage-lead', verdict: 'agree' }] }), ['independent-review-missing'], 'a single reviewer is not independent review');
assert.deepEqual(calibrationReasons({ reviewers: [{ id: 'human/triage-lead', verdict: 'agree' }, { id: 'evaluator/lock-contention-v1', verdict: 'agree' }] }), ['independent-review-missing'], 'the evaluator cannot review itself');
assert.deepEqual(calibrationReasons({ heldOut: { samples: 20, confusion: { truePositives: 5, falsePositives: 5, trueNegatives: 5, falseNegatives: 5 } } }), ['held-out-below-threshold']);
assert.deepEqual(calibrationReasons({ evaluatorId: '  ' }), ['malformed-calibration'], 'an unnamed evaluator is never admitted');

const uncalibratedHold = calibrateEvaluator(ledger, modeKey, { ...baseline, heldOut: undefined }, { at: '2026-09-22T01:00:01.000Z' });
assert.equal(uncalibratedHold.decision, 'held');
assert.deepEqual(uncalibratedHold.reasons, ['held-out-missing']);
assert.equal(uncalibratedHold.ledger.modes[modeKey].evaluator, null, 'an incomplete calibration admits nothing');
assert.deepEqual(calibrateEvaluator(ledger, 'sha256:0000', baseline, { at: '2026-09-22T01:00:02.000Z' }).reasons, ['unknown-failure-mode']);
assert.deepEqual(claimProtection(ledger, 'sha256:0000', claimFor(), { expected: { candidateHead: HEAD } }).reasons, ['unknown-failure-mode']);

ledger = calibrateEvaluator(ledger, modeKey, baseline, { at: '2026-09-22T01:01:00.000Z' }).ledger;
assert.ok(ledger.modes[modeKey].evaluator, 'the mode is now admitted for evaluation');

// --- invariant 3 and 5: what a protection claim will not accept -------------
const claimReasons = (claim, context) => claimProtection(ledger, modeKey, claim, context).reasons;
const expected = { expected: { candidateHead: HEAD }, at: '2026-09-22T02:00:01.000Z' };
assert.deepEqual(claimReasons(claimFor(), { at: '2026-09-22T02:00:01.000Z' }), ['expected-binding-missing'], 'an absent expectation is a hold, never an implicit match');
assert.deepEqual(claimReasons(claimFor({ candidateHead: OTHER_HEAD, headSha: OTHER_HEAD }), expected), ['stale-candidate-head']);
assert.deepEqual(claimReasons(claimFor({ headSha: OTHER_HEAD }), expected), ['cross-candidate-evidence'], 'a pass from a sibling candidate is not coverage');
assert.deepEqual(claimReasons(claimFor({ status: 'failed' }), expected), ['test-not-passed']);
assert.deepEqual(claimReasons(claimFor({ status: 'queued' }), expected), ['test-not-passed'], 'a queued run has proven nothing');
assert.deepEqual(claimReasons(claimFor({ testName: '  ' }), expected), ['missing-test-evidence'], 'protection requires a named deterministic test');
assert.deepEqual(claimReasons(claimFor({ command: undefined }), expected), ['missing-test-evidence']);
assert.deepEqual(claimReasons(claimFor({ executedAt: 'recently' }), expected), ['missing-test-evidence']);
assert.deepEqual(claimReasons(claimFor({ headSha: 'abc' }), expected), ['missing-test-evidence']);
assert.deepEqual(claimReasons(claimFor({ rawTrace: 'leaked' }), expected), ['raw-content-field']);
assert.deepEqual(claimReasons(claimFor({ apiKey: 'AKIAIOSFODNN7EXAMPLE' }), expected), ['sensitive-content']);
assert.equal(protectionStatus(ledger, modeKey, HEAD).isProtected, false, 'none of the held claims protected the mode');

// --- invariant 4: one pass cannot be replayed onto a second failure mode ----
const good = claimProtection(ledger, modeKey, claimFor(), expected);
assert.equal(good.decision, 'protected');
ledger = good.ledger;
ledger = ingestSample(ledger, sampleFor({ sampleId: 'trace-9', sourceDigest: digestOf('9'), metadata: { ...metadata, component: 'harness/scheduler' } }), { at: '2026-09-22T05:00:00.000Z' }).ledger;
const otherMode = Object.keys(ledger.modes).find((key) => key !== modeKey);
ledger = calibrateEvaluator(ledger, otherMode, baseline, { at: '2026-09-22T05:01:00.000Z' }).ledger;
const replayedPass = claimProtection(ledger, otherMode, claimFor(), expected);
assert.equal(replayedPass.decision, 'held');
assert.deepEqual(replayedPass.reasons, ['replayed-test-evidence']);
assert.equal(protectionStatus(replayedPass.ledger, otherMode, HEAD).isProtected, false, 'a replayed pass protects nothing');
assert.equal(protectionStatus(replayedPass.ledger, modeKey, HEAD).isProtected, true, 'and does not disturb the mode that earned it');

// --- the file adapter and CLI fail closed across processes ------------------
const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trace-evaluation-gate-')), 'ledger.json');
const cli = (...args) => JSON.parse(execFileSync('node', [script, ...args, '--ledger', ledgerPath], { encoding: 'utf8' }));
const opened = cli('ingest', '--json', JSON.stringify(sampleFor()));
assert.equal(opened.decision, 'mode_opened');
const cliMode = opened.modeKey;
assert.equal(cli('ingest', '--json', JSON.stringify(sampleFor({ sampleId: 'trace-1-again' }))).decision, 'deduplicated', 'a replay across processes creates nothing');
assert.equal(cli('claim', '--mode', cliMode, '--json', JSON.stringify(claimFor()), '--context', JSON.stringify({ expected: { candidateHead: HEAD } })).decision, 'held');
assert.equal(cli('calibrate', '--mode', cliMode, '--json', JSON.stringify(baseline)).decision, 'admitted');
assert.equal(cli('claim', '--mode', cliMode, '--json', JSON.stringify(claimFor({ headSha: OTHER_HEAD })), '--context', JSON.stringify({ expected: { candidateHead: HEAD } })).decision, 'held');
assert.equal(cli('status', '--mode', cliMode, '--head', HEAD).status, 'diagnostic');
assert.equal(cli('claim', '--mode', cliMode, '--json', JSON.stringify(claimFor()), '--context', JSON.stringify({ expected: { candidateHead: HEAD } })).decision, 'protected');
assert.deepEqual(cli('status', '--mode', cliMode, '--head', HEAD), { status: 'protected', isProtected: true, reasons: [] });
assert.equal(cli('status', '--mode', cliMode, '--head', OTHER_HEAD).isProtected, false, 'protection is bound to one exact candidate head');
const persisted = readLedgerFile(ledgerPath);
assert.equal(Object.keys(persisted.modes).length, 1);
assert.ok(persisted.holds.length >= 2, 'holds are durable and auditable');
assert.doesNotMatch(JSON.stringify(persisted), /ghp_|AKIA|BEGIN [A-Z ]*PRIVATE KEY/, 'the persisted ledger carries no credential');
assert.equal(cli('ingest', '--json', JSON.stringify(sampleFor({ note: RAW_SENTENCE }))).decision, 'held', 'the CLI rejects a benign-looking raw field too');
assert.match(cli('ingest', '--json', JSON.stringify(sampleFor({ metadata: { ...metadata, summary: RAW_SENTENCE } }))).decision, /^(held|deduplicated_hold)$/);
assert.equal(carriesRawSentence(fs.readFileSync(ledgerPath, 'utf8')), false, 'no word of the raw sentence reaches the ledger file');

console.log('trace evaluation gate fault tests: passed');
