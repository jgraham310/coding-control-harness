/**
 * Deterministic GitHub adapter. Read-only against GitHub: it observes issues,
 * pull requests, and check results with `gh` and records them as evidence.
 * It never merges, closes, comments, or deploys — a model must not be able to
 * certify its own work by asking this module nicely.
 */
import { execFileSync } from 'node:child_process';
import { ORDER, addEvidence, evidenceTypes, missingEvidence, recordTransition, setStatus, staleEvidence } from './control-plane.mjs';

export function gh(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

export function itemId(repo, issue) {
  return `${repo.split('/').pop()}#${issue}`;
}

const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

// The rollup is absent on a PR with no configured checks. Absent is not green,
// and neither is a check that has not finished: a QUEUED or IN_PROGRESS run is
// pending, never passing. Check runs report status + conclusion; commit status
// contexts report only state.
export function rollupState(checks = []) {
  if (!checks.length) return 'none';
  const outcome = (check) => (check.status && check.status !== 'COMPLETED'
    ? 'PENDING'
    : check.conclusion || check.state || 'PENDING');
  const outcomes = checks.map(outcome);
  if (outcomes.some((result) => FAILING.has(result))) return 'failing';
  if (outcomes.every((result) => PASSING.has(result))) return 'passing';
  return 'pending';
}

export function checkState(pr) {
  return rollupState(pr.statusCheckRollup || []);
}

function record(item, type, source, at, commit) {
  if (evidenceTypes(item).has(type)) return false;
  addEvidence(item, { type, source, observedAt: at, ...(commit ? { commit } : {}) });
  return true;
}

// Move to the furthest state whose full evidence chain is satisfied. `released`
// is unreachable here by design: no smoke evidence comes from GitHub.
export function advance(item, at) {
  for (const status of [...ORDER].reverse()) {
    if (!missingEvidence(item, status).length) {
      if (item.status !== status) setStatus(item, status, at);
      return item.status;
    }
  }
  return item.status;
}

export function syncRepo(state, repo, { now = new Date().toISOString(), fetch = gh } = {}) {
  const changes = [];
  const label = repo.label ? ['--label', repo.label] : [];
  const issues = fetch(['issue', 'list', '--repo', repo.name, '--state', 'open', '--limit', '100',
    ...label, '--json', 'number,title,url,createdAt']);

  for (const issue of issues) {
    const id = itemId(repo.name, issue.number);
    if (state.workItems.some((item) => item.id === id)) continue;
    state.workItems.push({
      id, title: issue.title, owner: repo.owner || 'unassigned', repository: repo.name,
      issue: issue.number, url: issue.url, status: 'prepared', statusAt: now,
      priority: repo.priority || 0, evidence: [],
    });
    changes.push(`${id}: added from open issue`);
  }

  const prs = fetch(['pr', 'list', '--repo', repo.name, '--state', 'all', '--limit', '100',
    '--json', 'number,title,url,state,isDraft,createdAt,headRefOid,mergeCommit,mergedAt,statusCheckRollup,closingIssuesReferences']);

  for (const pr of prs) {
    for (const linked of pr.closingIssuesReferences || []) {
      const item = state.workItems.find((candidate) => candidate.id === itemId(repo.name, linked.number));
      if (!item) continue;
      if (item.pr && item.pr !== pr.number) {
        changes.push(`${item.id}: second PR #${pr.number} ignored; canonical stays #${item.pr}`);
        continue;
      }
      item.pr = pr.number;
      // Evidence about a commit is evidence for that commit only. Recording the
      // new head before evaluating retires any verification of an older one.
      const priorHead = item.head;
      item.head = pr.headRefOid;
      if (priorHead && priorHead !== item.head && staleEvidence(item).length) {
        changes.push(`${item.id}: head moved ${priorHead.slice(0, 7)} → ${item.head.slice(0, 7)}; verification of the old commit no longer counts`);
      }
      // The merge commit, not the PR head, is what a deployment can contain.
      if (pr.mergedAt && pr.mergeCommit?.oid) { item.mergeCommit = pr.mergeCommit.oid; item.mergedAt = pr.mergedAt; }
      const touched = [];
      if (record(item, 'executor_started', `PR #${pr.number} opened ${pr.createdAt}`, pr.createdAt)) touched.push('executor_started');
      if (!pr.isDraft && record(item, 'executor_result', `PR #${pr.number} ready for review`, now)) touched.push('executor_result');
      const checks = checkState(pr);
      if (checks === 'passing' && !pr.isDraft
        && record(item, 'verification_passed', `PR #${pr.number} checks green at ${pr.headRefOid}`, now, pr.headRefOid)) touched.push('verification_passed');
      if (checks === 'failing') {
        item.blockedReason = `PR #${pr.number} has failing checks at ${pr.headRefOid}`;
        if (item.status !== 'blocked') { recordTransition(item, 'blocked', now); item.status = 'blocked'; item.statusAt = now; changes.push(`${item.id}: blocked on failing checks`); }
        continue;
      }
      if (item.status === 'blocked' && checks !== 'failing') { delete item.blockedReason; recordTransition(item, 'reported_done', now); item.status = 'reported_done'; }
      const before = item.status;
      const after = advance(item, now);
      if (before !== after) changes.push(`${item.id}: ${before} → ${after}`);
      else if (touched.length) changes.push(`${item.id}: recorded ${touched.join(', ')}`);
    }
  }
  return changes;
}

export function syncAll(state, { now = new Date().toISOString(), fetch = gh } = {}) {
  return (state.repos || []).flatMap((repo) => syncRepo(state, repo, { now, fetch }));
}
