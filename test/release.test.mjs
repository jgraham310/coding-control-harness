import assert from 'node:assert/strict';
import { emptyState, evidenceTypes, missingEvidence, validateState } from '../src/control-plane.mjs';
import { containsCommit, liveCommit, pluck, releaseCandidates, runCheck, syncRelease } from '../src/release.mjs';

const NOW = '2026-08-28T12:00:00Z';
const MERGE = 'merge111';
const LIVE = 'live222';

const repo = () => ({
  name: 'acme/api',
  release: {
    versionUrl: 'https://api.example.com/version',
    commitPath: 'build.commit',
    checks: [
      { name: 'health', url: 'https://api.example.com/health', expectStatus: 200 },
      { name: 'auth-required', url: 'https://api.example.com/me', expectStatus: 401 },
    ],
  },
});

const board = (overrides = {}) => {
  const state = { ...emptyState(), repos: [repo()] };
  state.workItems.push({
    id: 'api#7', title: 'Rate limit', owner: 'openclaw', repository: 'acme/api', issue: 7, pr: 31,
    status: 'verified', statusAt: NOW, head: 'head999', mergeCommit: MERGE, mergedAt: NOW,
    evidence: [
      { type: 'executor_started', source: 'PR #31 opened', observedAt: NOW },
      { type: 'executor_result', source: 'PR #31 ready for review', observedAt: NOW },
      { type: 'verification_passed', source: 'PR #31 checks green at head999', observedAt: NOW, commit: 'head999' },
    ],
    ...overrides,
  });
  return state;
};

const stub = ({ version = { build: { commit: LIVE } }, status = 200, checks = {}, compare = 'ahead' } = {}) => ({
  get: async (url) => {
    if (url.endsWith('/version')) return { status, body: JSON.stringify(version) };
    return { status: checks[url] ?? (url.endsWith('/me') ? 401 : 200), body: 'ok' };
  },
  run: async (command) => (command.includes('compare')
    ? { ok: true, output: compare }
    : { ok: true, output: '' }),
});

assert.equal(pluck({ build: { commit: 'abc' } }, 'build.commit'), 'abc');
assert.equal(pluck({}, 'build.commit'), undefined);
assert.equal(await liveCommit(repo().release, stub()), LIVE);
await assert.rejects(() => liveCommit(repo().release, stub({ status: 503 })), /returned 503/);
await assert.rejects(() => liveCommit(repo().release, stub({ version: {} })), /no commit at "build.commit"/);

// The happy path: production contains the merge and every check passes.
let state = board();
let changes = await syncRelease(state, state.repos[0], { now: NOW, ...stub() });
let item = state.workItems[0];
assert.deepEqual(changes, [`api#7: verified → released (live ${LIVE.slice(0, 7)})`]);
assert.equal(item.status, 'released');
const smoke = item.evidence.at(-1);
assert.equal(smoke.type, 'release_smoke_passed');
assert.equal(smoke.deployed, LIVE);
assert.equal(smoke.commit, 'head999', 'bound to the item head so a later push retires it');
assert.match(smoke.source, /contains merge merge111/);
assert.deepEqual(validateState(state), []);

// The check that matters: green smoke against a deployment predating the merge.
state = board();
changes = await syncRelease(state, state.repos[0], { now: NOW, ...stub({ compare: 'behind' }) });
assert.match(changes.join('\n'), /is not in the live deployment/);
assert.equal(state.workItems[0].status, 'verified', 'a passing smoke run cannot release code that is not deployed');
assert.deepEqual(missingEvidence(state.workItems[0], 'released'), ['release_smoke_passed']);

// Diverged history is not containment either.
state = board();
await syncRelease(state, state.repos[0], { now: NOW, ...stub({ compare: 'diverged' }) });
assert.equal(state.workItems[0].status, 'verified');

// An unknown live commit records nothing rather than assuming the newest thing is live.
state = board();
changes = await syncRelease(state, state.repos[0], { now: NOW, ...stub({ status: 500 }) });
assert.match(changes.join('\n'), /cannot determine the live commit.*recorded no release evidence/s);
assert.equal(state.workItems[0].status, 'verified');

// A failing smoke check blocks with the live commit named.
state = board();
changes = await syncRelease(state, state.repos[0], { now: NOW, ...stub({ checks: { 'https://api.example.com/health': 502 } }) });
assert.equal(state.workItems[0].status, 'blocked');
assert.match(state.workItems[0].blockedReason, /smoke checks failed against live live222: health \(expected 200, got 502\)/);
assert.ok(!evidenceTypes(state.workItems[0]).has('release_smoke_passed'));

// No configured checks is not a silent pass.
state = board();
state.repos[0].release.checks = [];
changes = await syncRelease(state, state.repos[0], { now: NOW, ...stub() });
assert.match(changes.join('\n'), /refusing to certify a release without them/);
assert.equal(state.workItems[0].status, 'verified');

// Only merged, verified, not-yet-released work is a candidate.
assert.deepEqual(releaseCandidates(board({ status: 'reported_done' }), 'acme/api'), []);
assert.deepEqual(releaseCandidates(board({ mergeCommit: undefined }), 'acme/api'), []);
assert.equal(releaseCandidates(board(), 'acme/api').length, 1);
state = board();
await syncRelease(state, state.repos[0], { now: NOW, ...stub() });
assert.deepEqual(await syncRelease(state, state.repos[0], { now: NOW, ...stub() }), [], 'a released item is not smoke-checked again');

// A push after release retires the smoke evidence with everything else.
state = board();
await syncRelease(state, state.repos[0], { now: NOW, ...stub() });
state.workItems[0].head = 'head000';
assert.deepEqual(missingEvidence(state.workItems[0], 'released'), ['verification_passed', 'release_smoke_passed']);

// Individual checks: commands, bodies, and unreachable hosts.
assert.deepEqual(await runCheck({ name: 'c', command: 'true' }, { run: async () => ({ ok: true, output: '' }) }), { name: 'c', ok: true, detail: 'exit 0' });
assert.deepEqual(await runCheck({ name: 'c', command: 'false' }, { run: async () => ({ ok: false, output: 'nope' }) }), { name: 'c', ok: false, detail: 'nope' });
assert.equal((await runCheck({ name: 'b', url: 'u', expectBody: 'healthy' }, { get: async () => ({ status: 200, body: 'degraded' }) })).ok, false);
assert.match((await runCheck({ name: 'x', url: 'u' }, { get: async () => { throw new Error('ECONNREFUSED'); } })).detail, /ECONNREFUSED/);
await assert.rejects(() => containsCommit('a/b', 'x', 'y', { run: async () => ({ ok: false, output: 'no such ref' }) }), /cannot compare x\.\.\.y/);
assert.equal(await containsCommit('a/b', 'same', 'same', { run: async () => { throw new Error('must not call gh'); } }), true);

console.log('release adapter tests: passed');
