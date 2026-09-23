import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CONTRACT_VERSION, METADATA_FIELDS, METADATA_KEY_LIMIT, METADATA_TOKEN, MODE_SCHEMA,
  PLACEMENT_RECEIPT, TERMINAL_OUTCOMES, buildSample, calibrateEvaluator, claimProtection,
  deriveModeKey, emptyLedger, evaluateCalibration, ingestSample, protectionStatus, scoreConfusion,
} from '../src/trace-evaluation-gate.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../schemas/trace-evaluation-gate.schema.json', import.meta.url), 'utf8'));
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const digestOf = (seed) => `sha256:${seed.repeat(64).slice(0, 64)}`;

// Synthetic, already-redacted metadata: allowlisted triage fields, single tokens only.
const metadata = {
  failureSignature: 'terminal-exit-nonzero:lock-contention',
  component: 'harness/lock',
  exitClass: 'nonzero-exit',
  attempts: 3,
};
const sampleFor = (overrides = {}) => ({
  sampleId: 'trace-1', source: 'lane/alpha', observedAt: '2026-09-22T00:00:00.000Z',
  outcome: 'failed', sourceDigest: digestOf('1'), metadata, ...overrides,
});

// --- invariant 1: only bounded redacted metadata plus an immutable digest ---
const sample = buildSample(sampleFor());
assert.equal(sample.schema, MODE_SCHEMA);
assert.equal(sample.contractVersion, CONTRACT_VERSION);
assert.equal(sample.modeKey, deriveModeKey(metadata), 'the mode key is derivable from the redacted metadata alone');
assert.match(sample.digest, /^sha256:[0-9a-f]{64}$/);
assert.doesNotMatch(JSON.stringify(sample), /https?:\/\//, 'a sample must not point at a live endpoint');
assert.equal(deriveModeKey({ ...metadata }), deriveModeKey(Object.fromEntries(Object.entries(metadata).reverse())), 'the key is key-order independent');
assert.notEqual(deriveModeKey({ ...metadata, component: 'harness/other' }), sample.modeKey, 'different metadata is a different mode');
for (const key of Object.keys(metadata)) assert.ok(key in METADATA_FIELDS, `${key} must be an allowlisted triage field`);
for (const value of Object.values(sample.metadata)) {
  if (typeof value === 'string') assert.match(value, METADATA_TOKEN, 'every admitted string is a single token');
}

// --- UAT 1: two equivalent traces deduplicate to one mode, stable digest ----
let ledger = emptyLedger();
const first = ingestSample(ledger, sampleFor(), { at: '2026-09-22T00:00:01.000Z' });
assert.equal(first.decision, 'mode_opened');
ledger = first.ledger;
const second = ingestSample(ledger, sampleFor({ sampleId: 'trace-2', source: 'lane/beta', sourceDigest: digestOf('2') }), { at: '2026-09-22T00:00:02.000Z' });
assert.equal(second.decision, 'mode_extended');
ledger = second.ledger;
const modeKey = first.modeKey;
assert.equal(Object.keys(ledger.modes).length, 1, 'two equivalent redacted traces are one failure mode');
assert.equal(ledger.modes[modeKey].observations.length, 2, 'both immutable source digests are retained');
assert.equal(ledger.modes[modeKey].digest, first.entry.digest, 'the mode digest is stable across equivalent samples');
assert.deepEqual(Object.keys(ledger.modes[modeKey]).sort().filter((key) => schema.required.includes(key)).sort(), [...schema.required].sort());

// --- a mode is diagnostic until calibrated, whatever the trace count --------
assert.deepEqual(protectionStatus(ledger, modeKey, HEAD), { status: 'diagnostic', isProtected: false, reasons: ['evaluator-uncalibrated'] });

// --- UAT 2: labeled calibration plus held-out, threshold, confusion counts --
const calibration = {
  evaluatorId: 'evaluator/lock-contention-v1',
  threshold: 0.75,
  calibration: {
    samples: 40,
    labeler: { id: 'human/triage-lead', kind: 'human' },
    confusion: { truePositives: 18, falsePositives: 2, trueNegatives: 18, falseNegatives: 2 },
  },
  heldOut: { samples: 20, confusion: { truePositives: 8, falsePositives: 1, trueNegatives: 10, falseNegatives: 1 } },
  reviewers: [{ id: 'human/triage-lead', verdict: 'agree' }, { id: 'human/reviewer-2', verdict: 'agree' }],
  calibratedAt: '2026-09-22T01:00:00.000Z',
};
const scored = scoreConfusion(calibration.heldOut.confusion);
assert.ok(Math.min(scored.precision, scored.recall) >= calibration.threshold);
const admitted = calibrateEvaluator(ledger, modeKey, calibration, { at: '2026-09-22T01:00:01.000Z' });
assert.equal(admitted.decision, 'admitted');
assert.deepEqual(admitted.reasons, []);
ledger = admitted.ledger;
const evaluator = ledger.modes[modeKey].evaluator;
assert.equal(evaluator.threshold, 0.75, 'the admitted evaluator records its threshold');
assert.deepEqual(evaluator.heldOut.confusion, calibration.heldOut.confusion, 'held-out confusion evidence is recorded');
assert.deepEqual(evaluator.calibration.confusion, calibration.calibration.confusion, 'calibration confusion evidence is recorded');
assert.equal(evaluator.calibration.labeler.kind, 'human', 'admission requires human labels');
assert.match(evaluator.digest, /^sha256:[0-9a-f]{64}$/);
assert.equal(calibrateEvaluator(ledger, modeKey, calibration, { at: '2026-09-22T01:05:00.000Z' }).decision, 'deduplicated');

// --- UAT 3: calibration admits; only exact-head test evidence protects ------
assert.deepEqual(protectionStatus(ledger, modeKey, HEAD), { status: 'diagnostic', isProtected: false, reasons: ['missing-test-evidence'] });
const claim = {
  candidateHead: HEAD, testName: 'trace-evaluation-gate', command: 'node test/trace-evaluation-gate.test.mjs',
  status: 'passed', headSha: HEAD, producer: 'harness/regression', executedAt: '2026-09-22T02:00:00.000Z',
};
const protectedResult = claimProtection(ledger, modeKey, claim, { expected: { candidateHead: HEAD }, at: '2026-09-22T02:00:01.000Z' });
assert.equal(protectedResult.decision, 'protected');
assert.equal(protectedResult.protectedAtHead, HEAD);
ledger = protectedResult.ledger;
assert.deepEqual(protectionStatus(ledger, modeKey, HEAD), { status: 'protected', isProtected: true, reasons: [] });
assert.equal(ledger.modes[modeKey].protection.testName, 'trace-evaluation-gate', 'protection names the deterministic test');
assert.equal(claimProtection(ledger, modeKey, claim, { expected: { candidateHead: HEAD }, at: '2026-09-22T02:10:00.000Z' }).decision, 'deduplicated');

// --- invariant 4: protection never carries to another candidate head --------
assert.deepEqual(protectionStatus(ledger, modeKey, OTHER_HEAD), { status: 'diagnostic', isProtected: false, reasons: ['stale-candidate-head'] });

// --- a later ingest of the same mode does not disturb the protection --------
const later = ingestSample(ledger, sampleFor({ sampleId: 'trace-3', source: 'lane/gamma', sourceDigest: digestOf('3') }), { at: '2026-09-22T03:00:00.000Z' });
assert.equal(later.decision, 'mode_extended');
assert.equal(protectionStatus(later.ledger, modeKey, HEAD).isProtected, true);

// --- recalibration drops the old evaluator's pass ---------------------------
const recalibrated = calibrateEvaluator(later.ledger, modeKey, { ...calibration, evaluatorId: 'evaluator/lock-contention-v2' }, { at: '2026-09-22T04:00:00.000Z' });
assert.equal(recalibrated.decision, 'recalibrated');
assert.deepEqual(protectionStatus(recalibrated.ledger, modeKey, HEAD), { status: 'diagnostic', isProtected: false, reasons: ['missing-test-evidence'] });

// --- schema drift guard -----------------------------------------------------
assert.equal(schema.properties.schema.const, MODE_SCHEMA);
assert.equal(schema.properties.contractVersion.const, CONTRACT_VERSION);
assert.equal(schema.properties.metadata.maxProperties, METADATA_KEY_LIMIT);
assert.equal(schema.properties.metadata.additionalProperties, false, 'the published metadata shape is a closed allowlist');
assert.deepEqual(Object.keys(schema.properties.metadata.properties).sort(), Object.keys(METADATA_FIELDS).sort());
assert.equal(schema.$defs.token.pattern, METADATA_TOKEN.source);
assert.deepEqual([...schema.properties.observations.items.properties.outcome.enum].sort(), [...TERMINAL_OUTCOMES].sort());
assert.equal(schema.properties.protection.oneOf[1].properties.status.const, 'passed');
assert.equal(schema.properties.evaluator.oneOf[1].properties.reviewers.minItems, 2);
const declared = new Set(schema.holdReasons.enum);
for (const reason of ['self-score-only', 'evaluator-disagreement', 'evaluator-uncalibrated', 'stale-candidate-head',
  'cross-candidate-evidence', 'missing-source-digest', 'raw-content-field', 'replayed-sample',
  'replayed-test-evidence', 'unsafe-metadata']) {
  assert.ok(declared.has(reason), `${reason} must be a published hold reason`);
}
assert.deepEqual(schema.holdReasons.enum, [...schema.holdReasons.enum].sort(), 'hold reasons are published sorted');

// --- calibration evidence is evaluated on its own, offline ------------------
assert.equal(evaluateCalibration(calibration).accepted, true);
assert.ok(Object.isFrozen(PLACEMENT_RECEIPT));
assert.equal(PLACEMENT_RECEIPT.contract, `${MODE_SCHEMA}@${CONTRACT_VERSION}`);

console.log('trace evaluation gate tests: passed');
