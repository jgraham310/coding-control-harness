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

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 30_000;

export function pluck(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => (current == null ? current : current[key]), value);
}

export async function httpGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  const body = await response.text();
  return { status: response.status, body };
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
export async function containsCommit(repoName, base, deployed, { run = shellRun } = {}) {
  if (base === deployed) return true;
  const result = await run(`gh api repos/${repoName}/compare/${base}...${deployed} --jq .status`);
  if (!result.ok) throw new Error(`cannot compare ${base}...${deployed}: ${result.output}`);
  return ['ahead', 'identical'].includes(result.output.trim());
}

export async function liveCommit(release, { get = httpGet } = {}) {
  const { status, body } = await get(release.versionUrl, { timeoutMs: release.timeoutMs });
  if (status !== 200) throw new Error(`${release.versionUrl} returned ${status}`);
  const commit = release.commitPath ? pluck(JSON.parse(body), release.commitPath) : body.trim();
  if (!commit) throw new Error(`no commit at "${release.commitPath || '(body)'}" in ${release.versionUrl}`);
  return String(commit).trim();
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

export async function syncRelease(state, repo, { now = new Date().toISOString(), get = httpGet, run = shellRun } = {}) {
  const changes = [];
  const release = repo.release;
  const candidates = releaseCandidates(state, repo.name);
  if (!release?.versionUrl || !candidates.length) return changes;

  let deployed;
  try {
    deployed = await liveCommit(release, { get });
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
      contains = await containsCommit(repo.name, item.mergeCommit, deployed, { run });
    } catch (error) {
      changes.push(`${item.id}: ${error.message}`);
      continue;
    }
    if (!contains) {
      changes.push(`${item.id}: merge ${item.mergeCommit.slice(0, 7)} is not in the live deployment ${deployed.slice(0, 7)}; still awaiting release`);
      continue;
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
      source: `${results.length} smoke check(s) passed against ${repo.name} at ${deployed}, which contains merge ${item.mergeCommit}`,
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
