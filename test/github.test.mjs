import assert from 'node:assert/strict';
import { emptyState, missingEvidence, staleEvidence, validateState } from '../src/control-plane.mjs';
import { checkState, itemId, syncRepo } from '../src/github.mjs';

const NOW = '2026-08-28T12:00:00Z';
const repo = { name: 'acme/api', label: 'cto', owner: 'openclaw' };

// A PR with no configured checks is not green.
assert.equal(checkState({ statusCheckRollup: [] }), 'none');
assert.equal(checkState({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }] }), 'passing');
assert.equal(checkState({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] }), 'failing');
assert.equal(checkState({ statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: null }] }), 'pending');

const stub = (issues, prs) => (args) => (args[0] === 'issue' ? issues : prs);

// 1. A labelled issue with no PR becomes prepared work.
const state = { ...emptyState(), repos: [repo] };
let changes = syncRepo(state, repo, { now: NOW, fetch: stub([{ number: 7, title: 'Rate limit the API', url: 'u', createdAt: NOW }], []) });
assert.deepEqual(changes, ['api#7: added from open issue']);
const item = state.workItems.find((candidate) => candidate.id === itemId('acme/api', 7));
assert.equal(item.status, 'prepared');

// 2. A draft PR proves work started but is not a completion claim.
const draft = { number: 31, isDraft: true, createdAt: NOW, headRefOid: 'abc', statusCheckRollup: [], closingIssuesReferences: [{ number: 7 }] };
syncRepo(state, repo, { now: NOW, fetch: stub([], [draft]) });
assert.equal(item.status, 'running');
assert.equal(item.pr, 31);

// 3. Ready for review is a claim; green checks on an observed commit are the verification.
const ready = { ...draft, isDraft: false };
syncRepo(state, repo, { now: NOW, fetch: stub([], [ready]) });
assert.equal(item.status, 'reported_done', 'an agent report alone must not reach verified');
const green = { ...ready, statusCheckRollup: [{ conclusion: 'SUCCESS' }] };
syncRepo(state, repo, { now: NOW, fetch: stub([], [green]) });
assert.equal(item.status, 'verified');
assert.match(item.evidence.at(-1).source, /checks green at abc/);
assert.deepEqual(validateState(state), [], 'canonical PR pointer stays consistent with evidence');

// 4. Red checks block, and the adapter never reaches released on its own.
const red = { ...green, headRefOid: 'def', statusCheckRollup: [{ conclusion: 'FAILURE' }] };
changes = syncRepo(state, repo, { now: NOW, fetch: stub([], [red]) });
assert.match(changes.join('\n'), /head moved abc → def/, 'a moved head retires the old verification');
assert.match(changes.join('\n'), /blocked on failing checks/);
assert.match(item.blockedReason, /failing checks at def/);
assert.ok(!state.workItems.some((candidate) => candidate.status === 'released'));

// 5. A second PR closing the same issue does not silently retarget the record.
const second = { ...green, number: 44 };
changes = syncRepo(state, repo, { now: NOW, fetch: stub([], [second]) });
assert.match(changes.join('\n'), /second PR #44 ignored; canonical stays #31/);
assert.equal(item.pr, 31);

// 6. Verification is bound to the commit it was observed on.
const fresh = { ...emptyState(), repos: [repo] };
syncRepo(fresh, repo, { now: NOW, fetch: stub([{ number: 7, title: 'Rate limit', url: 'u', createdAt: NOW }], []) });
const tracked = fresh.workItems[0];
const at = (sha, rollup) => ({ number: 31, isDraft: false, createdAt: NOW, headRefOid: sha, statusCheckRollup: rollup, closingIssuesReferences: [{ number: 7 }] });
const done = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

syncRepo(fresh, repo, { now: NOW, fetch: stub([], [at('abc', done)]) });
assert.equal(tracked.status, 'verified');
assert.equal(tracked.head, 'abc');

// The author pushes a new commit; checks restart. The old green run is not proof of the new code.
changes = syncRepo(fresh, repo, { now: NOW, fetch: stub([], [at('def', [{ status: 'IN_PROGRESS', conclusion: null }])]) });
assert.equal(tracked.status, 'reported_done', 'verification of abc must not survive a move to def');
assert.match(changes.join('\n'), /head moved abc → def/);
assert.equal(staleEvidence(tracked).length, 1, 'the superseded observation is retained, it just stops counting');
assert.deepEqual(missingEvidence(tracked, 'verified'), ['verification_passed']);

// Re-verifying on the new head restores it, and both observations remain on the record.
syncRepo(fresh, repo, { now: NOW, fetch: stub([], [at('def', done)]) });
assert.equal(tracked.status, 'verified');
assert.equal(tracked.evidence.filter((entry) => entry.type === 'verification_passed').length, 2);
assert.equal(tracked.evidence.at(-1).commit, 'def');

// 7. An unfinished check is never a passing one.
assert.equal(checkState({ statusCheckRollup: [...done, { status: 'QUEUED', conclusion: null }] }), 'pending', 'a queued check is pending, not passing');
assert.equal(checkState({ statusCheckRollup: [...done, { status: 'IN_PROGRESS', conclusion: null }] }), 'pending');
assert.equal(checkState({ statusCheckRollup: [{ state: 'PENDING' }] }), 'pending', 'commit status contexts report state, not conclusion');
assert.equal(checkState({ statusCheckRollup: [{ state: 'SUCCESS' }] }), 'passing');
assert.equal(checkState({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' }] }), 'failing');
syncRepo(fresh, repo, { now: NOW, fetch: stub([], [at('def', [...done, { status: 'QUEUED', conclusion: null }])]) });
assert.equal(tracked.evidence.filter((entry) => entry.type === 'verification_passed' && entry.commit === 'def').length, 1, 'a queued check adds no new verification');
console.log('github adapter tests: passed');
