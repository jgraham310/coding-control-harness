/**
 * Deterministic release adapter. It observes production and records
 * `release_smoke_passed` — the one gate no GitHub observation can supply.
 *
 * It does not deploy, promote, roll back, or restart anything. Deployment is
 * somebody else's job precisely so that the thing certifying a release is not
 * the thing performing it.
 *
 * The load-bearing check is not "did the smoke tests pass" but "did they pass
 * against code that actually contains this item". A green smoke run against a
 * deployment that predates the merge proves nothing about the merge.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { addEvidence, evidenceTypes, setStatus } from './control-plane.mjs';
import { rollupState } from './github.mjs';

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

// The live commit arrives from a network response, and it is used to build a
// GitHub API path. Anything that is not a plain SHA is rejected before it can
// reach an argument list or traverse a path.
const SHA = /^[0-9a-f]{7,40}$/i;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function assertSha(value, label) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${label} is not a commit SHA: ${JSON.stringify(String(value).slice(0, 80))}`);
  }
  return value;
}

export function assertRepo(name) {
  if (typeof name !== 'string' || !REPO.test(name)) throw new Error(`not an owner/repo name: ${JSON.stringify(name)}`);
  return name;
}

export function pluck(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => (current == null ? current : current[key]), value);
}

export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  const body = await response.text();
  return { status: response.status, body };
}

// `gh` is invoked with an argument list and no shell, so nothing observed can
// be interpreted as a command. User-authored smoke commands still go through a
// shell below — that is their own configuration, and the point of them.
export async function ghApi(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec('gh', args, { timeout: timeoutMs, encoding: 'utf8' });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stderr || error.stdout || error.message}`.trim() };
  }
}

export async function shellRun(command, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await exec('sh', ['-c', command], { timeout: timeoutMs, encoding: 'utf8' });
    return { ok: true, output: stdout.trim() };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}`.trim() || error.message };
  }
}

// `gh api compare` describes head relative to base. With the merge commit as
// base, a deployment that contains it reads as ahead (or identical to) it.
export async function containsCommit(repoName, base, deployed, { api = ghApi } = {}) {
  assertRepo(repoName); assertSha(base, 'merge commit'); assertSha(deployed, 'deployed commit');
  if (base === deployed) return true;
  const result = await api(['api', `repos/${repoName}/compare/${base}...${deployed}`, '--jq', '.status']);
  if (!result.ok) throw new Error(`cannot compare ${base}...${deployed}: ${result.output}`);
  return ['ahead', 'identical'].includes(result.output.trim());
}

/**
 * CI ran against the PR head. A squash or merge commit is a different commit,
 * and it is the one that gets deployed. Unless CI also ran on that commit,
 * nothing has tested the artifact production is serving, so this asks GitHub
 * for the checks recorded against the merge commit itself. Check runs and
 * commit statuses are both consulted: external CI reports as the latter.
 */
export async function mergeCheckState(repoName, sha, { api = ghApi } = {}) {
  assertRepo(repoName); assertSha(sha, 'merge commit');
  const [runs, statuses] = await Promise.all([
    api(['api', `repos/${repoName}/commits/${sha}/check-runs`, '--jq', '.check_runs[] | {status, conclusion}', '--paginate']),
    api(['api', `repos/${repoName}/commits/${sha}/status`, '--jq', '.statuses[] | {state}']),
  ]);
  if (!runs.ok && !statuses.ok) throw new Error(`cannot read checks for ${sha}: ${runs.output || statuses.output}`);
  const parse = (result) => (result.ok ? result.output.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : []);
  return rollupState([...parse(runs), ...parse(statuses)]);
}

/**
 * The version endpoint is the deployment describing itself. That is one
 * witness, and a compromised or misconfigured one can report a syntactically
 * valid SHA that is not what is running. This asks an independent source what
 * was deployed and requires the two to agree.
 *
 * It cannot make the claim unforgeable — something must be trusted — but it
 * raises forgery from "compromise the app" to "compromise the app and the
 * deployment record, consistently".
 *
 * ponytail: two source kinds, both returning a bare SHA. Add a third only when
 * a real deployment target cannot be read through either.
 */
export async function corroborate(repoName, release, deployed, { api = ghApi, run = shellRun } = {}) {
  const source = release.corroborate;
  if (!source) return { witnesses: 1, sources: ['the deployment\'s own version endpoint'] };

  let reported;
  let describedAs;
  if (source.deployments) {
    const active = await activeDeployment(repoName, source.deployments, { api, scan: source.scan });
    reported = active.sha;
    describedAs = `the active ${source.deployments} deployment record (#${active.id})`;
  } else if (source.command) {
    const result = await run(source.command, { timeoutMs: release.timeoutMs });
    if (!result.ok) throw new Error(`corroborating command failed: ${result.output}`);
    reported = result.output.trim();
  } else {
    throw new Error('release.corroborate needs either `deployments` or `command`.');
  }
  describedAs ||= 'a corroborating command';

  assertSha(reported, `the commit reported by the corroborating source`);
  // Short and long forms of the same commit agree.
  const [shorter, longer] = [reported, deployed].sort((a, b) => a.length - b.length);
  if (!longer.toLowerCase().startsWith(shorter.toLowerCase())) {
    throw new Error(`sources disagree about what is live: the version endpoint says ${deployed}, ${describedAs} says ${reported}`);
  }
  return { witnesses: 2, sources: ['the deployment\'s own version endpoint', describedAs] };
}

/**
 * The deployment that is actually serving an environment — not merely the most
 * recently created record. A deployment is only serving if the newest status
 * on it is `success`: one that failed, is still running, or was superseded and
 * marked `inactive` is not what production is running, and GitHub keeps all of
 * them in the same list. So walk back from the newest until one qualifies.
 *
 * ponytail: scans the last `scan` records (default 10) and costs one API call
 * per record inspected, which is one or two in practice. Raise `scan` for an
 * environment that records many failed deployments in a row.
 */
export async function activeDeployment(repoName, environment, { api = ghApi, scan = 10 } = {}) {
  assertRepo(repoName);
  const route = `repos/${repoName}/deployments?environment=${encodeURIComponent(environment)}&per_page=${Number(scan) || 10}`;
  const listed = await api(['api', route, '--jq', '.[] | [.id, .sha] | @tsv']);
  if (!listed.ok) throw new Error(`cannot read deployments for ${environment}: ${listed.output}`);
  const records = listed.output.split('\n').filter(Boolean).map((line) => line.split('\t'));
  if (!records.length) throw new Error(`no deployments recorded for ${environment}`);

  const rejected = [];
  for (const [id, sha] of records) {
    const status = await api(['api', `repos/${repoName}/deployments/${encodeURIComponent(id)}/statuses?per_page=1`, '--jq', '.[0].state']);
    if (!status.ok) throw new Error(`cannot read the status of deployment ${id}: ${status.output}`);
    const state = status.output.trim() || 'none';
    if (state === 'success') return { id, sha: assertSha(sha, `the commit on deployment ${id}`), state };
    rejected.push(`#${id} ${state}`);
  }
  throw new Error(`no active deployment for ${environment}: the last ${records.length} record(s) are ${rejected.join(', ')}`);
}

export async function liveCommit(release, { get = httpGet } = {}) {
  const { status, body } = await get(release.versionUrl, { timeoutMs: release.timeoutMs });
  if (status !== 200) throw new Error(`${release.versionUrl} returned ${status}`);
  const commit = release.commitPath ? pluck(JSON.parse(body), release.commitPath) : body.trim();
  if (!commit) throw new Error(`no commit at "${release.commitPath || '(body)'}" in ${release.versionUrl}`);
  return assertSha(String(commit).trim(), `the commit reported by ${release.versionUrl}`);
}

export async function runCheck(check, { get = httpGet, run = shellRun } = {}) {
  try {
    if (check.command) {
      const result = await run(check.command, { timeoutMs: check.timeoutMs });
      return { name: check.name, ok: result.ok, detail: result.ok ? 'exit 0' : result.output.slice(0, 300) };
    }
    const expected = check.expectStatus || 200;
    const { status, body } = await get(check.url, { timeoutMs: check.timeoutMs });
    if (status !== expected) return { name: check.name, ok: false, detail: `expected ${expected}, got ${status}` };
    if (check.expectBody && !new RegExp(check.expectBody).test(body)) {
      return { name: check.name, ok: false, detail: `body did not match /${check.expectBody}/` };
    }
    return { name: check.name, ok: true, detail: `${status}` };
  } catch (error) {
    return { name: check.name, ok: false, detail: error.message };
  }
}

/**
 * Candidates are items that passed verification and were merged. Anything
 * earlier in the lifecycle has no business being smoke-checked, and the
 * evidence chain would reject the result anyway.
 */
export function releaseCandidates(state, repoName) {
  return state.workItems.filter((item) => item.repository === repoName
    && item.status === 'verified'
    && item.mergeCommit
    && !evidenceTypes(item).has('release_smoke_passed'));
}

export async function syncRelease(state, repo, { now = new Date().toISOString(), get = httpGet, run = shellRun, api = ghApi } = {}) {
  const changes = [];
  const release = repo.release;
  const candidates = releaseCandidates(state, repo.name);
  if (!release?.versionUrl || !candidates.length) return changes;

  let deployed;
  let attestation;
  try {
    deployed = await liveCommit(release, { get });
    // Disagreement between sources is a strong signal that something is wrong,
    // so it stops the release pass rather than picking a winner.
    attestation = await corroborate(repo.name, release, deployed, { api, run });
  } catch (error) {
    // Not knowing what is live is a reason to record nothing, never a reason
    // to assume the newest thing is live.
    return [`${repo.name}: cannot determine the live commit (${error.message}); recorded no release evidence`];
  }

  // Smoke checks describe the deployment, not one item, so run them once.
  let results = null;
  for (const item of candidates) {
    let contains;
    try {
      contains = await containsCommit(repo.name, item.mergeCommit, deployed, { api });
    } catch (error) {
      changes.push(`${item.id}: ${error.message}`);
      continue;
    }
    if (!contains) {
      changes.push(`${item.id}: merge ${item.mergeCommit.slice(0, 7)} is not in the live deployment ${deployed.slice(0, 7)}; still awaiting release`);
      continue;
    }

    // Verification was recorded against the PR head. The merge commit is a
    // different commit, and it is the one deployed, so it needs its own green
    // run before this can claim the deployed artifact was tested.
    let mergeChecks = 'skipped';
    if (release.requireMergeChecks !== false) {
      try {
        mergeChecks = await mergeCheckState(repo.name, item.mergeCommit, { api });
      } catch (error) {
        changes.push(`${item.id}: ${error.message}; recorded no release evidence`);
        continue;
      }
      if (mergeChecks !== 'passing') {
        changes.push(`${item.id}: merge ${item.mergeCommit.slice(0, 7)} has ${mergeChecks === 'none' ? 'no CI run of its own' : `CI ${mergeChecks}`}; the deployed commit is not verified`);
        continue;
      }
    }

    results ||= await Promise.all((release.checks || []).map((check) => runCheck(check, { get, run })));
    const failed = results.filter((result) => !result.ok);
    if (!results.length) {
      changes.push(`${item.id}: no smoke checks configured; refusing to certify a release without them`);
      continue;
    }
    if (failed.length) {
      item.blockedReason = `smoke checks failed against live ${deployed.slice(0, 7)}: ${failed.map((result) => `${result.name} (${result.detail})`).join('; ')}`;
      if (item.status !== 'blocked') { item.status = 'blocked'; item.statusAt = now; }
      changes.push(`${item.id}: blocked — ${item.blockedReason}`);
      continue;
    }

    addEvidence(item, {
      type: 'release_smoke_passed',
      // Bound to the item's own head, so a later push retires it like any
      // other commit-scoped evidence. The deployment it was seen against is
      // recorded alongside for audit.
      commit: item.head,
      deployed,
      mergeCommit: item.mergeCommit,
      witnesses: attestation.witnesses,
      source: `${results.length} smoke check(s) passed against ${repo.name} at ${deployed}, which contains merge ${item.mergeCommit}`
        + (mergeChecks === 'passing' ? ` (CI green on the merge commit)` : ` (merge-commit CI not required by config, so the deployed artifact's own CI is unproven)`)
        + `; deployed commit attested by ${attestation.sources.join(' and ')}`
        + (attestation.witnesses === 1 ? ' only, which is self-reported and unconfirmed' : ''),
      observedAt: now,
    });
    setStatus(item, 'released', now);
    changes.push(`${item.id}: verified → released (live ${deployed.slice(0, 7)})`);
  }
  return changes;
}

export async function syncAllReleases(state, options = {}) {
  const changes = [];
  for (const repo of state.repos || []) changes.push(...await syncRelease(state, repo, options));
  return changes;
}
