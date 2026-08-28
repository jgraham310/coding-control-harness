import assert from 'node:assert/strict';
import { emptyState, validateState } from '../src/control-plane.mjs';
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
assert.deepEqual(changes, ['api#7: blocked on failing checks']);
assert.match(item.blockedReason, /failing checks at def/);
assert.ok(!state.workItems.some((candidate) => candidate.status === 'released'));

// 5. A second PR closing the same issue does not silently retarget the record.
const second = { ...green, number: 44 };
changes = syncRepo(state, repo, { now: NOW, fetch: stub([], [second]) });
assert.match(changes.join('\n'), /second PR #44 ignored; canonical stays #31/);
assert.equal(item.pr, 31);
console.log('github adapter tests: passed');
