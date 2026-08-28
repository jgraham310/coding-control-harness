import assert from 'node:assert/strict';
import { addEvidence, emptyState, recordRoute, setStatus } from '../src/control-plane.mjs';
import { assessRevisions, loopStatus, observePatterns, promotePattern, recordSkillRevision } from '../src/patterns.mjs';

const T = (h) => `2026-08-${String(1 + Math.floor(h / 24)).padStart(2, '0')}T${String(h % 24).padStart(2, '0')}:00:00Z`;

const board = () => {
  const state = emptyState();
  state.skills = [{ id: 'unlazy', version: '2.0.0' }, { id: 'define-goal' }];
  return state;
};
// Drive an item through real transitions rather than hand-writing history.
const churn = (state, id, blockedAt) => {
  const item = { id, title: id, owner: 'openclaw', status: 'prepared', statusAt: T(0), evidence: [] };
  state.workItems.push(item);
  addEvidence(item, { type: 'executor_started', source: 'PR', observedAt: T(0) });
  setStatus(item, 'running', T(0));
  for (const at of blockedAt) { setStatus(item, 'blocked', at); setStatus(item, 'running', at); }
  return item;
};

// --- one bad day is not a pattern ---
let state = board();
churn(state, 'api#7', [T(1), T(2)]);
assert.deepEqual(observePatterns(state), [], 'two occurrences is under the threshold');
churn(state, 'api#8', [T(1), T(2), T(3)]);
let observed = observePatterns(state);
assert.deepEqual(observed.map((pattern) => pattern.id), ['repeated_block:api#8']);
assert.equal(observed[0].count, 3);
assert.equal(observed[0].first, T(1));

// Patterns are derived, never stored opinion: a narrowed window changes them.
assert.deepEqual(observePatterns(state, { from: T(2) }).map((pattern) => pattern.id), [], 'the window is honoured');

// --- a rule the agent keeps hitting is a pattern about the work, not the rule ---
const denials = [1, 2, 3].map((n) => ({ at: T(n), ruleId: 'no-force-push', reason: 'r', tool: 'Bash', subject: 'git push --force' }));
assert.ok(observePatterns(board(), { denials }).some((pattern) => pattern.id === 'rule_friction:no-force-push'));

// --- the one that points at a skill ---
state = board();
const routed = churn(state, 'api#9', []);
recordRoute(state, 'api#9', { skill: 'unlazy', decidedBy: 'openclaw', why: 'long autonomous run' }, T(1));
for (const at of [T(2), T(3), T(4)]) { setStatus(routed, 'blocked', at); setStatus(routed, 'running', at); }
observed = observePatterns(state);
const ineffective = observed.find((pattern) => pattern.kind === 'skill_ineffective');
assert.equal(ineffective.subject, 'unlazy');
assert.equal(ineffective.count, 3);
assert.match(ineffective.detail, /work routed to unlazy was blocked 3 times afterwards/);

// Blocks before the routing decision are not that skill's doing.
const early = board();
const item = churn(early, 'api#1', [T(1), T(2), T(3)]);
recordRoute(early, 'api#1', { skill: 'unlazy', decidedBy: 'openclaw', why: 'x' }, T(9));
assert.ok(!observePatterns(early).some((pattern) => pattern.kind === 'skill_ineffective'), 'a skill is not blamed for what preceded it');

// --- promotion needs a person, and can only promote what the traces show ---
assert.throws(() => promotePattern(state, 'skill_ineffective:invented', { reviewer: 'jason' }, observed), /not an observed pattern/);
assert.throws(() => promotePattern(state, ineffective.id, { reviewer: '  ' }, observed), /requires the reviewer/);
const promoted = promotePattern(state, ineffective.id, { reviewer: 'jason', note: 'unlazy is being applied to work it does not fit' }, observed, T(5));
assert.equal(promoted.baseline, 3, 'the count that justified promotion is snapshotted');
assert.throws(() => promotePattern(state, ineffective.id, { reviewer: 'jason' }, observed), /already promoted/);

// --- a revision must answer a confirmed pattern and be findable ---
assert.throws(() => recordSkillRevision(state, { skill: 'unlazy', pattern: 'repeated_block:api#9', revision: '2.1.0', by: 'jason' }), /not a promoted pattern/);
assert.throws(() => recordSkillRevision(state, { skill: 'ghost', pattern: promoted.id, revision: '2.1.0', by: 'jason' }), /Unknown skill: ghost/);
assert.throws(() => recordSkillRevision(state, { skill: 'unlazy', pattern: promoted.id, revision: '  ', by: 'jason' }), /requires an identifier/);
assert.throws(() => recordSkillRevision(state, { skill: 'unlazy', pattern: promoted.id, revision: '2.1.0', by: '' }), /requires its author/);
const revision = recordSkillRevision(state, { skill: 'unlazy', pattern: promoted.id, revision: '2.1.0', by: 'jason', note: 'narrowed when-to-use' }, T(6));
assert.equal(revision.id, 'unlazy@2.1.0');
assert.equal(revision.outcome, 'open');

// --- the test: a revision holds only when the signal actually stopped ---
assert.deepEqual(assessRevisions(state, { observed: observePatterns(state), now: T(7) }), [], 'still inside the settle window');
assert.equal(state.revisions[0].outcome, 'open');

// Recurrence after the revision landed marks it regressed, however good it looked.
setStatus(routed, 'blocked', T(8));
setStatus(routed, 'running', T(8));
let changes = assessRevisions(state, { observed: observePatterns(state), now: T(9) });
assert.match(changes.join('\n'), /unlazy@2\.1\.0: regressed \(skill_ineffective:unlazy recurred at/);
assert.equal(state.patterns[0].closedAt, undefined, 'a regressed revision does not close its pattern');

// A clean settle window holds it, and closes the pattern it answered.
const clean = board();
const quiet = churn(clean, 'api#2', []);
recordRoute(clean, 'api#2', { skill: 'unlazy', decidedBy: 'openclaw', why: 'x' }, T(1));
for (const at of [T(2), T(3), T(4)]) { setStatus(quiet, 'blocked', at); setStatus(quiet, 'running', at); }
const p2 = promotePattern(clean, 'skill_ineffective:unlazy', { reviewer: 'jason' }, observePatterns(clean), T(5));
recordSkillRevision(clean, { skill: 'unlazy', pattern: p2.id, revision: '2.1.0', by: 'jason' }, T(6));
// Nothing recurs after T(6); assess past the settle window.
changes = assessRevisions(clean, { observed: observePatterns(clean, { from: T(6) }), now: T(6 + 200) });
assert.deepEqual(changes, ['unlazy@2.1.0: held']);
assert.equal(clean.patterns[0].closedBy, 'unlazy@2.1.0');
assert.equal(clean.patterns[0].closedAt, T(6 + 200));

// --- held is a standing claim, not a verdict earned once ---

// The gap that let this ship: every earlier test recurred *before* the
// revision held. A fix that stops working later is the whole point of the loop.
const late = board();
const drifter = churn(late, 'api#3', []);
recordRoute(late, 'api#3', { skill: 'unlazy', decidedBy: 'openclaw', why: 'x' }, T(1));
for (const at of [T(2), T(3), T(4)]) { setStatus(drifter, 'blocked', at); setStatus(drifter, 'running', at); }
const p3 = promotePattern(late, 'skill_ineffective:unlazy', { reviewer: 'jason' }, observePatterns(late), T(5));
recordSkillRevision(late, { skill: 'unlazy', pattern: p3.id, revision: '2.1.0', by: 'jason' }, T(6));
assert.deepEqual(assessRevisions(late, { observed: observePatterns(late, { from: T(6) }), now: T(206) }), ['unlazy@2.1.0: held']);
assert.ok(late.patterns[0].closedAt, 'holding closes the pattern it answered');

// Months later, it comes back.
setStatus(drifter, 'blocked', T(500));
setStatus(drifter, 'running', T(500));
changes = assessRevisions(late, { observed: observePatterns(late), now: T(501) });
assert.match(changes.join('\n'), /unlazy@2\.1\.0: regressed .*after it had held/);
assert.equal(late.revisions[0].outcome, 'regressed', 'held must be overturnable, as the README promises');
assert.equal(late.patterns[0].closedAt, undefined, 'a pattern that recurred is not closed');
assert.deepEqual(loopStatus(late, observePatterns(late)).unanswered.map((pattern) => pattern.id), [p3.id], 'and it is unanswered again');

// Re-assessing a regressed revision is stable rather than flapping.
assert.deepEqual(assessRevisions(late, { observed: observePatterns(late), now: T(502) }), []);

// One pattern regressing must not disturb another pattern's closure.
const shared = board();
const other = churn(shared, 'api#4', []);
recordRoute(shared, 'api#4', { skill: 'define-goal', decidedBy: 'openclaw', why: 'x' }, T(1));
for (const at of [T(2), T(3), T(4)]) { setStatus(other, 'blocked', at); setStatus(other, 'running', at); }
const p4 = promotePattern(shared, 'skill_ineffective:define-goal', { reviewer: 'jason' }, observePatterns(shared), T(5));
const p5 = promotePattern(shared, 'repeated_block:api#4', { reviewer: 'jason' }, observePatterns(shared), T(5));
recordSkillRevision(shared, { skill: 'define-goal', pattern: p4.id, revision: '1.1.0', by: 'jason' }, T(6));
recordSkillRevision(shared, { skill: 'unlazy', pattern: p5.id, revision: '2.1.0', by: 'jason' }, T(6));
assessRevisions(shared, { observed: observePatterns(shared, { from: T(6) }), now: T(206) });
assert.deepEqual(shared.patterns.map((pattern) => pattern.closedBy), ['define-goal@1.1.0', 'unlazy@2.1.0']);

// Only api#4's own block recurs, so only the patterns it feeds are overturned.
setStatus(other, 'blocked', T(500));
setStatus(other, 'running', T(500));
assessRevisions(shared, { observed: observePatterns(shared), now: T(501) });
assert.deepEqual(shared.revisions.map((revision) => revision.outcome), ['regressed', 'regressed'], 'both patterns draw on the same block');
assert.deepEqual(shared.patterns.map((pattern) => pattern.closedAt), [undefined, undefined]);

// A revision whose pattern never recurs keeps its closure untouched.
const isolated = board();
const calm = churn(isolated, 'api#5', [T(2), T(3), T(4)]);
const p6 = promotePattern(isolated, 'repeated_block:api#5', { reviewer: 'jason' }, observePatterns(isolated), T(5));
recordSkillRevision(isolated, { skill: 'unlazy', pattern: p6.id, revision: '3.0.0', by: 'jason' }, T(6));
assessRevisions(isolated, { observed: observePatterns(isolated, { from: T(6) }), now: T(206) });
churn(isolated, 'api#6', [T(300), T(301), T(302)]);
assert.deepEqual(assessRevisions(isolated, { observed: observePatterns(isolated), now: T(400) }), [], 'an unrelated pattern does not overturn it');
assert.equal(isolated.revisions[0].outcome, 'held');
assert.equal(isolated.patterns[0].closedBy, 'unlazy@3.0.0');

// --- what the loop is waiting on ---
const status = loopStatus(state, observePatterns(state));
assert.ok(status.regressed.some((entry) => entry.id === 'unlazy@2.1.0'));
assert.ok(status.unpromoted.every((pattern) => pattern.id !== promoted.id), 'a promoted pattern is not still awaiting promotion');
console.log('pattern loop tests: passed');
