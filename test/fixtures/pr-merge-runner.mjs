#!/usr/bin/env node
/** Squash-merge only a pre-authorized, exact-head, review-clear PR. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWLIST = join(ROOT, 'policy', 'auto-merge-allowlist.json');
const TEMS_AUTHORITY_GATE = '/Users/jasongraham/.openclaw/repos/coding-control-harness/src/tems-merge-authority.mjs';
const CIVICLINE_AUTHORITY_GATE = '/Users/jasongraham/.openclaw/repos/coding-control-harness/src/civicline-merge-authority.mjs';
const CIVICLINE_GATE_SHA256 = 'cfbabd43297da4fa3787969b68516ef315c8206c736f5ce5d077f9fbac5806db';
const TEMS_HOST_PARITY_TEST = '/Users/jasongraham/.openclaw/repos/coding-control-harness/test/live-portfolio-merge-runner.host.test.mjs';
function arg(name) { const index = process.argv.indexOf(name); if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`); return process.argv[index + 1]; }
function run(argv) { return execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function writeAtomic(path, value) { mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; writeFileSync(temporary, canonical(value), { mode: 0o600 }); renameSync(temporary, path); }
function activeReviewThreads(repository, pr) {
  const [owner, name] = repository.split('/');
  if (!owner || !name) throw new Error(`invalid repository: ${repository}`);
  const query = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved isOutdated} pageInfo{hasNextPage}}}}}';
  const response = JSON.parse(run(['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${pr}`]));
  const threads = response.data?.repository?.pullRequest?.reviewThreads;
  if (!threads || threads.pageInfo?.hasNextPage) throw new Error('review-thread observation is incomplete');
  return threads.nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length;
}
function authorizationFor(repository, pr, head) {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  if (allowlist.schema_version !== 1 || !Array.isArray(allowlist.entries)) throw new Error('invalid auto-merge allowlist');
  const entry = allowlist.entries.find((item) => item.repository === repository && Number(item.pr) === Number(pr) && item.head_sha === head);
  if (!entry || !entry.authorized_at || !entry.authorized_by || !entry.reason) throw new Error(`PR is not explicitly authorized for auto-merge at this head: ${repository}#${pr}@${head}`);
  return { entry, digest: sha256(canonical(entry)) };
}
function cleanReviewFor(repository, pr, head) {
  const path = join(ROOT, 'evidence', 'codex-review', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`);
  if (!existsSync(path)) throw new Error(`current-head Codex review evidence is missing: ${path}`);
  const review = JSON.parse(readFileSync(path, 'utf8'));
  if (review.repository !== repository || Number(review.pr) !== Number(pr) || review.head_sha !== head || review.outcome !== 'clean') throw new Error('current-head Codex review is not clean');
  return { path, digest: sha256(canonical(review)), reviewed_at: review.reviewed_at };
}
function requireCurrentChecks(repository, head, rollup, reviewedAt) {
  if (!Array.isArray(rollup) || rollup.length === 0) throw new Error('PR checks are missing or empty');
  const name = (check) => check.name ?? check.context;
  const success = (check) => ('status' in check || 'conclusion' in check)
    ? check.status === 'COMPLETED' && check.conclusion === 'SUCCESS'
    : check.state === 'SUCCESS';
  const failed = rollup.filter((check) => !check || !success(check));
  if (failed.length) throw new Error(`PR has non-success checks: ${failed.map((check) => check ? name(check) : 'invalid').join(',')}`);
  for (const required of ['portfolio/review-clear', 'tems/canonical-host-integration']) {
    if (rollup.filter((check) => name(check) === required).length !== 1) {
      throw new Error(`required ${required} check is missing or ambiguous`);
    }
  }
  const response = JSON.parse(run(['api', `repos/${repository}/commits/${head}/status`]));
  const statuses = Array.isArray(response.statuses) ? response.statuses : [];
  const latest = statuses.filter((entry) => entry.context === 'portfolio/review-clear')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  const observed = Date.parse(latest?.created_at);
  const reviewed = Date.parse(reviewedAt);
  if (response.sha !== head || !latest || latest.state !== 'success' ||
      !Number.isFinite(observed) || !Number.isFinite(reviewed) || observed < reviewed || observed > Date.now()) {
    throw new Error('exact-head portfolio/review-clear status is missing, failing, or stale');
  }
  return latest.created_at;
}
function currentTemsHostStatus(repository, head) {
  const response = JSON.parse(run(['api', `repos/${repository}/commits/${head}/status`]));
  const statuses = response.statuses;
  const matching = Array.isArray(statuses) ? statuses.filter((entry) => entry.context === 'tems/canonical-host-integration') : [];
  matching.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = matching[0];
  const observed = Date.parse(latest?.created_at);
  if (response.sha !== head || !latest || latest.state !== 'success' ||
      !Number.isFinite(observed) || observed > Date.now() || Date.now() - observed > 30 * 60 * 1000) {
    throw new Error('current exact-head TEMS canonical-host integration status is missing, stale, or failed');
  }
  return latest.created_at;
}
function main() {
  const repository = arg('--repo'); const pr = arg('--pr'); const head = arg('--head');
  if (repository === 'jgraham310/tems') {
    const protocol = join(ROOT, 'evidence', 'merge-protocol', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`);
    execFileSync('node', [TEMS_AUTHORITY_GATE, repository, pr, head, protocol], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const evidence = join(ROOT, 'evidence', 'pr-merge', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`);
  const civicline = repository === 'jgraham310/local-government';
  const civiclineProof = civicline ? join(ROOT, 'evidence', 'merge-protocol', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`) : null;
  if (civicline) {
    if (sha256(readFileSync(CIVICLINE_AUTHORITY_GATE)) !== CIVICLINE_GATE_SHA256) throw new Error('installed CivicLine authority gate does not match reviewed candidate');
    execFileSync('node', [CIVICLINE_AUTHORITY_GATE, 'check', pr, civiclineProof], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const authorization = civicline ? { digest: 'signal:1790601059903' } : authorizationFor(repository, pr, head);
  const review = civicline ? { path: civiclineProof, digest: sha256(canonical(JSON.parse(readFileSync(civiclineProof, 'utf8')))), reviewed_at: JSON.parse(readFileSync(civiclineProof, 'utf8')).review?.observedAt } : cleanReviewFor(repository, pr, head);
  const current = JSON.parse(run(['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,mergeStateStatus,isDraft,statusCheckRollup']));
  if (current.headRefOid !== head) throw new Error(`PR head changed: expected ${head}, found ${current.headRefOid}`);
  if (current.isDraft || current.mergeStateStatus !== 'CLEAN') throw new Error(`PR is not mechanically mergeable: draft=${current.isDraft} merge=${current.mergeStateStatus}`);
  // Preserve the pre-existing all-success rollup rule for non-TEMS repositories.
  const reviewClearAt = repository === 'jgraham310/tems'
    ? requireCurrentChecks(repository, head, current.statusCheckRollup, review.reviewed_at)
    : null;
  if (repository !== 'jgraham310/tems') {
    const failed = (current.statusCheckRollup ?? []).filter((check) => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS');
    if (failed.length) throw new Error(`PR has non-success checks: ${failed.map((check) => check.name ?? check.context).join(',')}`);
  }
  const hostStatusAt = repository === 'jgraham310/tems' ? currentTemsHostStatus(repository, head) : null;
  if (repository === 'jgraham310/tems') {
    // A previously published status cannot attest to the currently installed files.
    execFileSync('node', [TEMS_HOST_PARITY_TEST], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const unresolvedThreads = activeReviewThreads(repository, pr);
  if (unresolvedThreads) throw new Error(`PR has ${unresolvedThreads} unresolved active review thread(s)`);
  // Persist the full authorization/review decision before executing the
  // irreversible GitHub merge, so a failed merge call cannot erase evidence.
  const decision = { schema_version: 2, repository, pr: Number(pr), head_sha: head, decision: civicline ? 'merge-attempt-pending-final-gate' : 'approved-for-squash-merge', decided_at: new Date().toISOString(), executor: 'portfolio-controller', authorization_sha256: authorization.digest, review_evidence_sha256: review.digest, review_evidence_path: review.path, review_completed_at: review.reviewed_at, ...(repository === 'jgraham310/tems' ? { portfolio_review_clear_at: reviewClearAt } : {}), unresolved_active_review_threads: 0, ci: 'all-success', tems_canonical_host_status_at: hostStatusAt, branch_merge_state: 'CLEAN' };
  writeAtomic(evidence, decision);
  if (civicline) {
    if (sha256(readFileSync(CIVICLINE_AUTHORITY_GATE)) !== CIVICLINE_GATE_SHA256) throw new Error('installed CivicLine authority gate changed before merge');
    execFileSync('node', [CIVICLINE_AUTHORITY_GATE, 'merge', pr, civiclineProof], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else run(['pr', 'merge', pr, '--repo', repository, '--squash', '--match-head-commit', head]);
  const record = { ...decision, merged_at: new Date().toISOString(), method: 'squash', outcome: 'merged' };
  writeAtomic(evidence, record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
try { main(); } catch (error) { process.stderr.write(`pr-merge-runner: ${error.message}\n`); process.exit(1); }
