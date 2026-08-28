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

// --- direction, ranking, brief ---
import { DIRECTION_TEMPLATE, parseDirection, rank, renderBrief, requiredEvidence } from '../src/control-plane.mjs';

assert.deepEqual(requiredEvidence('released'), ['executor_started', 'executor_result', 'verification_passed', 'release_smoke_passed']);
const skipper = { id: 'CL-SKIP', title: 'Skipper', owner: 'codex', status: 'prepared', evidence: [] };
addEvidence(skipper, { type: 'release_smoke_passed', source: 'smoke', observedAt: '2026-08-27T00:00:00Z' });
assert.throws(() => setStatus(skipper, 'released'), /verification_passed/);

const direction = parseDirection(`${DIRECTION_TEMPLATE}`);
assert.deepEqual(direction.pinned, []);
const steered = parseDirection('## Pinned\n\n- CL-9 ship this first\n- CL-4\n\n## Not now\n\n- CL-2 wait for design\n');
assert.deepEqual(steered.pinned, ['CL-9', 'CL-4']);
assert.deepEqual(steered.notNow, ['CL-2 wait for design']);

const board = emptyState();
board.workItems.push(
  { id: 'CL-2', title: 'Deferred', owner: 'a', status: 'prepared', statusAt: '2026-08-27T00:00:00Z', evidence: [] },
  { id: 'CL-4', title: 'Pinned second', owner: 'a', status: 'prepared', statusAt: '2026-08-27T00:00:00Z', evidence: [] },
  { id: 'CL-9', title: 'Pinned first', owner: 'a', status: 'prepared', statusAt: '2026-08-27T00:00:00Z', evidence: [] },
  { id: 'CL-B', title: 'Blocked', owner: 'a', status: 'blocked', statusAt: '2026-08-27T00:00:00Z', blockedReason: 'checks red', evidence: [] },
);
const ordered = rank(board, { direction: steered, now: '2026-08-27T01:00:00Z' }).map((entry) => entry.item.id);
assert.deepEqual(ordered, ['CL-9', 'CL-4', 'CL-B', 'CL-2'], 'pinned beat blocked; deferred sinks below everything');
assert.deepEqual(rank(board, { now: '2026-08-27T01:00:00Z' }).map((e) => e.item.id)[0], 'CL-B', 'unsteered, blocked work leads');

const brief = renderBrief(board, { direction: steered, since: '2026-08-26T00:00:00Z', now: '2026-08-27T01:00:00Z' });
assert.match(brief, /## Needs you/);
assert.match(brief, /CL-B.*checks red/);
assert.match(brief, /1\. \*\*CL-9\*\*/);
assert.match(brief, /Pinned right now: CL-9, CL-4/);
console.log('coding-control cto tests: passed');

// A rail the agent hit is a thing the human needs to see, not a line in a log.
import { renderBrief as brief2 } from '../src/control-plane.mjs';
const withDenials = brief2(board, { direction: steered, now: '2026-08-27T01:00:00Z', denials: [
  { at: '2026-08-27T00:30:00Z', ruleId: 'no-force-push', reason: 'Force pushes require explicit review.', tool: 'Bash', subject: 'git push --force origin main' },
  { at: '2026-08-27T00:40:00Z', ruleId: 'no-force-push', reason: 'Force pushes require explicit review.', tool: 'Bash', subject: 'git push --force origin main' },
] });
assert.match(withDenials, /safety rule \*\*no-force-push\*\* stopped the agent 2×/);
console.log('coding-control denial-surfacing test: passed');

// --- which approach was taken, and when nobody recorded one ---
import { recordRoute, suggestSkills, unroutedItems } from '../src/control-plane.mjs';

const routed = emptyState();
routed.skills = [
  { id: 'security-fix', match: 'security|CVE|vulnerab', when: 'A reported vulnerability.' },
  { id: 'dependency-bump', match: 'bump|upgrade|dependab', when: 'A routine version bump.' },
  { id: 'feature', when: 'Anything else. No match pattern, so it always applies.' },
];
routed.workItems.push(
  { id: 'W-1', title: 'Patch CVE-2026-1 in the auth path', owner: 'openclaw', status: 'running', statusAt: '2026-08-27T00:00:00Z', evidence: [{ type: 'executor_started', source: 'PR', observedAt: '2026-08-27T00:00:00Z' }] },
  { id: 'W-2', title: 'Bump lockfile', owner: 'openclaw', status: 'prepared', statusAt: '2026-08-27T00:00:00Z', labels: ['dependabot'], evidence: [] },
);
assert.deepEqual(suggestSkills(routed, routed.workItems[0]).map((skill) => skill.id), ['security-fix', 'feature']);
assert.deepEqual(suggestSkills(routed, routed.workItems[1]).map((skill) => skill.id), ['dependency-bump', 'feature'], 'labels are matched as well as titles');

// Work in flight with nothing recorded is drift, and the brief says so.
assert.deepEqual(unroutedItems(routed).map((item) => item.id), ['W-1'], 'prepared work has not been approached yet');
assert.match(renderBrief(routed, { now: '2026-08-27T01:00:00Z' }), /\*\*W-1\*\* `running`.*no recorded approach/);

recordRoute(routed, 'W-1', { skill: 'security-fix', decidedBy: 'openclaw', why: 'CVE in the auth path' }, '2026-08-27T00:30:00Z');
assert.deepEqual(unroutedItems(routed), []);
assert.match(renderBrief(routed, { now: '2026-08-27T01:00:00Z' }), /via \*\*security-fix\*\* \(openclaw\)/);
assert.deepEqual(rank(routed, { now: '2026-08-27T01:00:00Z' })[0].skills, ['security-fix', 'feature']);

// A route must name a real skill and a real decider, and drift into an unknown one is caught.
assert.throws(() => recordRoute(routed, 'W-2', { skill: 'improvise', decidedBy: 'openclaw' }), /Unknown skill: improvise/);
assert.throws(() => recordRoute(routed, 'W-2', { skill: 'feature' }), /requires the decision maker/);
assert.throws(() => recordRoute(routed, 'nope', { skill: 'feature', decidedBy: 'x' }), /Unknown work item/);
assert.deepEqual(validateState(routed), []);
routed.workItems[0].route.skill = 'deleted-skill';
assert.match(validateState(routed).join('\n'), /W-1: routed to unknown skill "deleted-skill"/);

// With no catalog the feature is simply unused; it does not nag about every item.
const noCatalog = emptyState();
noCatalog.workItems.push({ id: 'X-1', title: 'x', owner: 'a', status: 'running', statusAt: '2026-08-27T00:00:00Z', evidence: [] });
assert.deepEqual(unroutedItems(noCatalog), []);
assert.ok(!renderBrief(noCatalog, { now: '2026-08-27T01:00:00Z' }).includes('no recorded approach'));
console.log('coding-control routing tests: passed');
