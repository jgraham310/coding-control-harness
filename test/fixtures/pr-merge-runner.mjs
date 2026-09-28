#!/usr/bin/env node
/** Squash-merge only a pre-authorized, exact-head, review-clear PR. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const ALLOWLIST = join(ROOT, 'policy', 'auto-merge-allowlist.json');
const TEMS_AUTHORITY_GATE = '/Users/jasongraham/.openclaw/repos/coding-control-harness/src/tems-merge-authority.mjs';
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
function main() {
  const repository = arg('--repo'); const pr = arg('--pr'); const head = arg('--head');
  if (repository === 'jgraham310/tems') {
    const protocol = join(ROOT, 'evidence', 'merge-protocol', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`);
    execFileSync('node', [TEMS_AUTHORITY_GATE, repository, pr, head, protocol], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const evidence = join(ROOT, 'evidence', 'pr-merge', repository.replace('/', '__'), `pr-${pr}`, `${head}.json`);
  const authorization = authorizationFor(repository, pr, head);
  const review = cleanReviewFor(repository, pr, head);
  const current = JSON.parse(run(['pr', 'view', pr, '--repo', repository, '--json', 'headRefOid,mergeStateStatus,isDraft,statusCheckRollup']));
  if (current.headRefOid !== head) throw new Error(`PR head changed: expected ${head}, found ${current.headRefOid}`);
  if (current.isDraft || current.mergeStateStatus !== 'CLEAN') throw new Error(`PR is not mechanically mergeable: draft=${current.isDraft} merge=${current.mergeStateStatus}`);
  const failed = (current.statusCheckRollup ?? []).filter((check) => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS');
  if (failed.length) throw new Error(`PR has non-success checks: ${failed.map((check) => check.name ?? check.context).join(',')}`);
  const unresolvedThreads = activeReviewThreads(repository, pr);
  if (unresolvedThreads) throw new Error(`PR has ${unresolvedThreads} unresolved active review thread(s)`);
  // Persist the full authorization/review decision before executing the
  // irreversible GitHub merge, so a failed merge call cannot erase evidence.
  const decision = { schema_version: 2, repository, pr: Number(pr), head_sha: head, decision: 'approved-for-squash-merge', decided_at: new Date().toISOString(), executor: 'portfolio-controller', authorization_sha256: authorization.digest, review_evidence_sha256: review.digest, review_evidence_path: review.path, review_completed_at: review.reviewed_at, unresolved_active_review_threads: 0, ci: 'all-success', branch_merge_state: 'CLEAN' };
  writeAtomic(evidence, decision);
  run(['pr', 'merge', pr, '--repo', repository, '--squash', '--delete-branch']);
  const record = { ...decision, merged_at: new Date().toISOString(), method: 'squash', outcome: 'merged' };
  writeAtomic(evidence, record);
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
try { main(); } catch (error) { process.stderr.write(`pr-merge-runner: ${error.message}\n`); process.exit(1); }
