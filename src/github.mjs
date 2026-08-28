/**
 * Deterministic GitHub adapter. Read-only against GitHub: it observes issues,
 * pull requests, and check results with `gh` and records them as evidence.
 * It never merges, closes, comments, or deploys — a model must not be able to
 * certify its own work by asking this module nicely.
 */
import { execFileSync } from 'node:child_process';
import { ORDER, addEvidence, evidenceTypes, missingEvidence, setStatus } from './control-plane.mjs';

export function gh(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

export function itemId(repo, issue) {
  return `${repo.split('/').pop()}#${issue}`;
}

// The rollup is absent on a PR with no configured checks. Absent is not green.
export function checkState(pr) {
  const checks = (pr.statusCheckRollup || []).filter((check) => check.status !== 'QUEUED');
  if (!checks.length) return 'none';
  const conclusion = (check) => check.conclusion || check.state;
  if (checks.some((check) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(conclusion(check)))) return 'failing';
  if (checks.every((check) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion(check)))) return 'passing';
  return 'pending';
}

function record(item, type, source, at) {
  if (evidenceTypes(item).has(type)) return false;
  addEvidence(item, { type, source, observedAt: at });
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
    '--json', 'number,title,url,state,isDraft,createdAt,headRefOid,statusCheckRollup,closingIssuesReferences']);

  for (const pr of prs) {
    for (const linked of pr.closingIssuesReferences || []) {
      const item = state.workItems.find((candidate) => candidate.id === itemId(repo.name, linked.number));
      if (!item) continue;
      if (item.pr && item.pr !== pr.number) {
        changes.push(`${item.id}: second PR #${pr.number} ignored; canonical stays #${item.pr}`);
        continue;
      }
      item.pr = pr.number;
      const touched = [];
      if (record(item, 'executor_started', `PR #${pr.number} opened ${pr.createdAt}`, pr.createdAt)) touched.push('executor_started');
      if (!pr.isDraft && record(item, 'executor_result', `PR #${pr.number} ready for review`, now)) touched.push('executor_result');
      const checks = checkState(pr);
      if (checks === 'passing' && !pr.isDraft && record(item, 'verification_passed', `PR #${pr.number} checks green at ${pr.headRefOid}`, now)) touched.push('verification_passed');
      if (checks === 'failing') {
        item.blockedReason = `PR #${pr.number} has failing checks at ${pr.headRefOid}`;
        if (item.status !== 'blocked') { item.status = 'blocked'; item.statusAt = now; changes.push(`${item.id}: blocked on failing checks`); }
        continue;
      }
      if (item.status === 'blocked' && checks !== 'failing') { delete item.blockedReason; item.status = 'reported_done'; }
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
