import assert from 'node:assert/strict';
import {
  addCheckpoint, addEvidence, emptyState, evaluateSafetyRules, missingEvidence,
  pilotCompletion, pilotRecommendation, proposeMemory, recallMemory, recordPilotDecision, renderPilotReport, reserveFiles, reviewMemory, setStatus, validateState,
} from '../src/control-plane.mjs';

const state = emptyState();
const item = { id: 'CL-1', title: 'Evidence control', owner: 'codex', status: 'prepared', evidence: [] };
state.workItems.push(item);
assert.deepEqual(missingEvidence(item), []);
assert.throws(() => setStatus(item, 'running'), /executor_started/);
addEvidence(item, { type: 'executor_started', source: 'session observation', observedAt: '2026-08-27T00:00:00Z' });
setStatus(item, 'running');
reserveFiles(state, { workItemId: 'CL-1', owner: 'codex', paths: ['ops/coding-control'] });
state.workItems.push({ id: 'CL-2', title: 'Other', owner: 'claude', status: 'prepared', evidence: [] });
assert.throws(() => reserveFiles(state, { workItemId: 'CL-2', owner: 'claude', paths: ['ops/coding-control/test-control-plane.mjs'] }), /ownership conflict/);
addCheckpoint(state, { workItemId: 'CL-1', owner: 'codex', nextAction: 'Run checks', successPredicate: 'All required checks pass' });
proposeMemory(state, { id: 'm1', text: 'Use observed evidence for lifecycle claims.', source: 'control contract', tags: ['evidence'] });
assert.deepEqual(recallMemory(state, ['evidence']), []);
reviewMemory(state, { proposalId: 'm1', decision: 'approved', reviewer: 'jason' });
assert.equal(recallMemory(state, ['evidence']).length, 1);
assert.deepEqual(evaluateSafetyRules([{ id: 'no-force-push', tool: 'shell', commandPattern: 'git push --force', reason: 'Force pushes require explicit review.' }], { tool: 'shell', command: 'git push --force origin main' }), { allowed: false, ruleId: 'no-force-push', reason: 'Force pushes require explicit review.' });
assert.deepEqual(evaluateSafetyRules([], { tool: 'shell', command: 'git status' }), { allowed: true });
assert.deepEqual(validateState(state), []);

const incompletePrRecord = { id: 'CL-PR', title: 'PR pointer guard', owner: 'codex', status: 'prepared', evidence: [
  { type: 'executor_result', source: 'PR #42 opened with test evidence', observedAt: '2026-08-27T00:00:00Z' },
] };
state.workItems.push(incompletePrRecord);
assert.match(validateState(state).join('\n'), /evidence cites PR #42 but canonical pr is missing/);
incompletePrRecord.pr = 42;
assert.deepEqual(validateState(state), []);

const completed = { id: 'CL-3', title: 'Completed work', owner: 'codex', status: 'prepared', evidence: [] };
state.workItems.push(completed);
addEvidence(completed, { type: 'executor_started', source: 'session observation', observedAt: '2026-08-27T00:00:00Z' });
setStatus(completed, 'running');
addEvidence(completed, { type: 'executor_result', source: 'agent report', observedAt: '2026-08-27T00:01:00Z' });
setStatus(completed, 'reported_done');
assert.throws(() => setStatus(completed, 'verified'), /verification_passed/);
addEvidence(completed, { type: 'verification_passed', source: 'CI run', observedAt: '2026-08-27T00:02:00Z' });
setStatus(completed, 'verified');
assert.throws(() => setStatus(completed, 'released'), /release_smoke_passed/);
addEvidence(completed, { type: 'release_smoke_passed', source: 'production smoke', observedAt: '2026-08-27T00:03:00Z' });
setStatus(completed, 'released');
assert.deepEqual(validateState(state), []);

state.pilots.push({
  id: 'pilot-1', title: 'Control plane pilot', owner: 'jason', workItemIds: ['CL-3'],
  metrics: { unverifiedCompletionClaims: 0, missedEvidenceDeadlines: 0, abandonedGates: 0, handoffRecoveryRequired: 0, policyViolations: 0 },
  closeout: { decisionRequired: 'scale, adjust, or stop', deadline: '2026-09-01T00:00:00Z' },
});
assert.equal(pilotCompletion(state, state.pilots[0]).ready, true);
assert.deepEqual(pilotRecommendation(state.pilots[0]), { recommendation: 'scale', reason: 'All pilot issues completed with no measured control failures.' });
assert.match(renderPilotReport(state, state.pilots[0]), /SCALE/);
state.pilots[0].closeout.reportedAt = '2026-08-27T00:04:00Z';
assert.throws(() => recordPilotDecision(state, 'pilot-1', 'invalid', 'jason'), /scale, adjust, or stop/);
recordPilotDecision(state, 'pilot-1', 'scale', 'jason', '2026-08-27T00:05:00Z');
assert.equal(state.pilots[0].closeout.status, 'closed');
state.pilots[0].metrics.missedEvidenceDeadlines = 1;
assert.equal(pilotRecommendation(state.pilots[0]).recommendation, 'adjust');
state.pilots[0].metrics.policyViolations = 1;
assert.equal(pilotRecommendation(state.pilots[0]).recommendation, 'stop');
state.pilots[0].metrics.policyViolations = 0;
state.pilots[0].metrics.missedEvidenceDeadlines = 0;
assert.deepEqual(validateState(state), []);
console.log('coding-control tests: passed');
