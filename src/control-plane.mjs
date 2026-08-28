#!/usr/bin/env node
/**
 * Local, evidence-bound control plane for coding work.
 * It intentionally records control facts only; it does not start agents,
 * execute commands, mutate GitHub, or turn a handoff into execution evidence.
 */
import fs from 'node:fs';
import path from 'node:path';

export const LIFECYCLE = ['prepared', 'running', 'reported_done', 'verified', 'blocked', 'released'];
export const ACTIVE = new Set(['prepared', 'running', 'reported_done']);
export const TERMINAL = new Set(['verified', 'released']);
export const ORDER = ['prepared', 'running', 'reported_done', 'verified', 'released'];
export const EVIDENCE_FOR = {
  running: ['executor_started'],
  reported_done: ['executor_result'],
  verified: ['verification_passed'],
  released: ['release_smoke_passed'],
};

export function emptyState() {
  return {
    schema: 'coding_control_state/v1',
    workItems: [], checkpoints: [], fileReservations: [], memory: { proposals: [], reviews: [] }, safetyRules: [], pilots: [], skills: [],
  };
}

// Evidence about a commit only counts for that commit. Once an item records a
// head, a verification observed on an earlier commit stops satisfying its gate,
// so a PR that moves after a green run falls back out of `verified` instead of
// carrying stale proof forward into a release decision.
export const COMMIT_BOUND = new Set(['verification_passed', 'release_smoke_passed']);

export function isCurrent(item, entry) {
  return !item.head || !COMMIT_BOUND.has(entry.type) || entry.commit === item.head;
}

export function evidenceTypes(item) {
  return new Set((item.evidence || []).filter((entry) => isCurrent(item, entry)).map((entry) => entry.type));
}

export function staleEvidence(item) {
  return (item.evidence || []).filter((entry) => !isCurrent(item, entry));
}

// A PR mentioned in observed executor evidence is part of the canonical work
// record, not merely narrative. Keeping this check local makes a partial
// manual update fail validation before a reconciler can report a false
// "no PR" result.
export function evidencePrNumbers(item) {
  const numbers = new Set();
  for (const evidence of item.evidence || []) {
    for (const match of evidence.source?.matchAll(/\b(?:PR|pull request)\s*#(\d+)\b/gi) || []) {
      numbers.add(Number(match[1]));
    }
  }
  return [...numbers];
}

// A later state implies every earlier gate. Without this, `released` needed
// only a smoke record and an item could skip verification entirely.
export function requiredEvidence(status) {
  const index = ORDER.indexOf(status);
  if (index < 0) return [];
  return ORDER.slice(0, index + 1).flatMap((state) => EVIDENCE_FOR[state] || []);
}

export function missingEvidence(item, status = item.status) {
  return requiredEvidence(status).filter((type) => !evidenceTypes(item).has(type));
}

export function lastEvidenceAt(item) {
  return (item.evidence || []).map((entry) => entry.observedAt).sort().pop() || item.statusAt;
}

export function setStatus(item, status, at = new Date().toISOString()) {
  if (!LIFECYCLE.includes(status)) throw new Error(`Unknown lifecycle state: ${status}`);
  const missing = missingEvidence(item, status);
  if (missing.length) throw new Error(`${status} requires observed evidence: ${missing.join(', ')}`);
  item.status = status;
  item.statusAt = at;
  return item;
}

export function addEvidence(item, evidence) {
  if (!evidence?.type || !evidence?.observedAt || !evidence?.source) {
    throw new Error('Evidence requires type, observedAt, and source.');
  }
  item.evidence ||= [];
  item.evidence.push(evidence);
  return item;
}

export function reserveFiles(state, reservation, at = new Date().toISOString()) {
  if (!reservation.workItemId || !reservation.owner || !Array.isArray(reservation.paths) || !reservation.paths.length) {
    throw new Error('Reservation requires workItemId, owner, and one or more paths.');
  }
  const item = state.workItems.find((candidate) => candidate.id === reservation.workItemId);
  if (!item) throw new Error(`Unknown work item: ${reservation.workItemId}`);
  const conflicts = state.fileReservations.filter((existing) =>
    existing.releasedAt === undefined && existing.workItemId !== reservation.workItemId &&
    ACTIVE.has(state.workItems.find((candidate) => candidate.id === existing.workItemId)?.status) &&
    existing.paths.some((held) => reservation.paths.some((wanted) => held === wanted || held.startsWith(`${wanted}/`) || wanted.startsWith(`${held}/`))),
  );
  if (conflicts.length) throw new Error(`File ownership conflict with: ${conflicts.map((entry) => entry.workItemId).join(', ')}`);
  const record = { ...reservation, reservedAt: at };
  state.fileReservations.push(record);
  return record;
}

export function addCheckpoint(state, checkpoint) {
  if (!checkpoint.workItemId || !checkpoint.owner || !checkpoint.nextAction || !checkpoint.successPredicate) {
    throw new Error('Checkpoint requires workItemId, owner, nextAction, and successPredicate.');
  }
  const record = { ...checkpoint, recordedAt: checkpoint.recordedAt || new Date().toISOString() };
  state.checkpoints.push(record);
  return record;
}

export function proposeMemory(state, proposal) {
  if (!proposal.id || !proposal.text || !proposal.source) throw new Error('Memory proposal requires id, text, and source.');
  state.memory.proposals.push({ ...proposal, proposedAt: proposal.proposedAt || new Date().toISOString() });
}

export function reviewMemory(state, review) {
  const proposal = state.memory.proposals.find((candidate) => candidate.id === review.proposalId);
  if (!proposal) throw new Error(`Unknown memory proposal: ${review.proposalId}`);
  if (!['approved', 'rejected'].includes(review.decision) || !review.reviewer) throw new Error('Memory review requires approved/rejected decision and reviewer.');
  state.memory.reviews.push({ ...review, reviewedAt: review.reviewedAt || new Date().toISOString() });
}

export function recallMemory(state, tags = []) {
  const approved = new Set(state.memory.reviews.filter((review) => review.decision === 'approved').map((review) => review.proposalId));
  return state.memory.proposals.filter((proposal) => approved.has(proposal.id) && (!tags.length || proposal.tags?.some((tag) => tags.includes(tag))));
}

export function evaluateSafetyRules(rules, action) {
  for (const rule of rules.filter((candidate) => candidate.enabled !== false)) {
    const matchesTool = !rule.tool || rule.tool === action.tool;
    const matchesCommand = !rule.commandPattern || new RegExp(rule.commandPattern).test(action.command || '');
    if (matchesTool && matchesCommand) return { allowed: false, ruleId: rule.id, reason: rule.reason };
  }
  return { allowed: true };
}

export function pilotCompletion(state, pilot) {
  const items = pilot.workItemIds.map((id) => state.workItems.find((item) => item.id === id));
  const missing = pilot.workItemIds.filter((id, index) => !items[index]);
  const incomplete = items.filter((item) => item && !TERMINAL.has(item.status));
  return { ready: !missing.length && !incomplete.length, items, missing, incomplete };
}

export function pilotRecommendation(pilot) {
  const metrics = pilot.metrics || {};
  if ((metrics.policyViolations || 0) > 0) return { recommendation: 'stop', reason: 'A policy violation occurred during the pilot.' };
  const friction = ['unverifiedCompletionClaims', 'missedEvidenceDeadlines', 'abandonedGates', 'handoffRecoveryRequired']
    .reduce((total, key) => total + (metrics[key] || 0), 0);
  if (friction > 0) return { recommendation: 'adjust', reason: `${friction} measured control failure(s) need remediation before expansion.` };
  return { recommendation: 'scale', reason: 'All pilot issues completed with no measured control failures.' };
}

export function renderPilotReport(state, pilot, generatedAt = new Date().toISOString()) {
  const completion = pilotCompletion(state, pilot);
  if (!completion.ready) throw new Error(`Pilot ${pilot.id} is not complete: ${completion.incomplete.map((item) => item.id).join(', ') || completion.missing.join(', ')}`);
  const decision = pilotRecommendation(pilot);
  const rows = completion.items.map((item) => `| ${item.id} | ${item.status} | ${item.repository || ''}#${item.issue || ''} | ${item.pr || '—'} | ${item.evidence?.length || 0} |`).join('\n');
  const metrics = Object.entries(pilot.metrics || {}).map(([key, value]) => `- ${key}: ${value}`).join('\n') || '- No metrics recorded.';
  return `# Pilot closeout: ${pilot.title}\n\nGenerated: ${generatedAt}\n\n## Evidence\n\n| Work item | Lifecycle | Issue | PR | Evidence records |\n| --- | --- | --- | --- | --- |\n${rows}\n\n## Measured control outcomes\n\n${metrics}\n\n## Recommendation\n\n**${decision.recommendation.toUpperCase()}** — ${decision.reason}\n\n## Jason decision required\n\nChoose **scale**, **adjust**, or **stop** for the coding-control rollout. This closeout is mandatory before the pilot can be considered complete.\n`;
}

export function recordPilotDecision(state, pilotId, decision, decidedBy, at = new Date().toISOString()) {
  const pilot = state.pilots.find((candidate) => candidate.id === pilotId);
  if (!pilot) throw new Error(`Unknown pilot: ${pilotId}`);
  if (!pilot.closeout?.reportedAt) throw new Error(`${pilotId}: a closeout report must be generated before recording a decision.`);
  if (!['scale', 'adjust', 'stop'].includes(decision)) throw new Error('Pilot decision must be scale, adjust, or stop.');
  if (!decidedBy) throw new Error('Pilot decision requires the decision maker.');
  pilot.closeout.decision = decision;
  pilot.closeout.decidedBy = decidedBy;
  pilot.closeout.decidedAt = at;
  pilot.closeout.status = 'closed';
  return pilot;
}

export function validateState(state) {
  const errors = [];
  if (state.schema !== 'coding_control_state/v1') errors.push('Unexpected state schema.');
  for (const item of state.workItems) {
    if (!LIFECYCLE.includes(item.status)) errors.push(`${item.id}: invalid lifecycle state.`);
    const missing = missingEvidence(item);
    if (missing.length) errors.push(`${item.id}: ${item.status} missing ${missing.join(', ')}.`);
    if (item.route && !(state.skills || []).some((skill) => skill.id === item.route.skill)) {
      errors.push(`${item.id}: routed to unknown skill "${item.route.skill}".`);
    }
    const evidencePrs = evidencePrNumbers(item);
    if (evidencePrs.length > 1) errors.push(`${item.id}: evidence cites multiple PRs (${evidencePrs.join(', ')}); resolve the canonical PR.`);
    if (evidencePrs.length === 1 && item.pr !== evidencePrs[0]) {
      errors.push(`${item.id}: evidence cites PR #${evidencePrs[0]} but canonical pr is ${item.pr ? `#${item.pr}` : 'missing'}.`);
    }
  }
  for (const reservation of state.fileReservations.filter((entry) => !entry.releasedAt)) {
    const owner = state.workItems.find((item) => item.id === reservation.workItemId);
    if (!owner) errors.push(`Reservation references missing item ${reservation.workItemId}.`);
  }
  for (const rule of state.safetyRules) {
    try { if (rule.commandPattern) new RegExp(rule.commandPattern); } catch { errors.push(`Safety rule ${rule.id}: invalid commandPattern.`); }
    if (!rule.id || !rule.reason) errors.push('Safety rules require id and explanation.');
  }
  for (const pilot of state.pilots || []) {
    if (!pilot.id || !pilot.title || !pilot.owner || !Array.isArray(pilot.workItemIds) || !pilot.workItemIds.length) errors.push('Pilots require id, title, owner, and one or more workItemIds.');
    if (new Set(pilot.workItemIds || []).size !== (pilot.workItemIds || []).length) errors.push(`${pilot.id}: duplicate workItemIds.`);
    for (const id of pilot.workItemIds || []) if (!state.workItems.some((item) => item.id === id)) errors.push(`${pilot.id}: missing work item ${id}.`);
    if (!pilot.closeout?.decisionRequired || !pilot.closeout?.deadline) errors.push(`${pilot.id}: closeout requires decisionRequired and deadline.`);
    if (pilot.closeout?.status === 'closed' && (!pilot.closeout?.reportedAt || !pilot.closeout?.decision || !pilot.closeout?.decidedBy || !pilot.closeout?.decidedAt)) errors.push(`${pilot.id}: closed pilot requires report and recorded decision.`);
  }
  return errors;
}

export const DIRECTION_TEMPLATE = `# Direction

Edit this file. The CTO reads it at the start of every cycle and it outranks
its own judgement. Nothing here is parsed except the Pinned list.

## Pinned

Work item ids listed here sort to the top, in order.

- (none)

## Standing instructions

- Open a PR per work item; never merge your own work.
- Ask before anything destructive or public-facing.

## Not now

- (nothing deferred)
`;

// Only the Pinned ids are parsed. Everything else is prose the agent reads.
// ponytail: heading-scoped bullet scan, swap for a real parser if the file
// grows structure worth validating.
export function parseDirection(text = '') {
  const sections = {};
  let current = 'preamble';
  for (const line of text.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { current = heading[1].toLowerCase(); sections[current] = []; continue; }
    (sections[current] ||= []).push(line);
  }
  const bullets = (name) => (sections[name] || [])
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1])
    .filter((value) => value && !/^\(/.test(value));
  return {
    text,
    pinned: bullets('pinned').map((value) => value.split(/\s+/)[0]),
    standingInstructions: bullets('standing instructions'),
    notNow: bullets('not now'),
  };
}

/**
 * Which approach applies to a piece of work. The harness cannot make an agent
 * consult the catalog — a rule an agent calls on itself is not a control — so
 * it does the part that survives a misbehaving agent instead: it records the
 * choice and makes its absence visible. Work advanced with no recorded
 * approach shows up in the brief as exactly that.
 */
export function suggestSkills(state, item) {
  const subject = `${item.title || ''} ${(item.labels || []).join(' ')} ${item.repository || ''}`;
  return (state.skills || []).filter((skill) => {
    try { return !skill.match || new RegExp(skill.match, 'i').test(subject); } catch { return false; }
  });
}

export function recordRoute(state, workItemId, { skill, decidedBy, why }, at = new Date().toISOString()) {
  const item = state.workItems.find((candidate) => candidate.id === workItemId);
  if (!item) throw new Error(`Unknown work item: ${workItemId}`);
  if (!decidedBy) throw new Error('A route requires the decision maker.');
  if (!(state.skills || []).some((candidate) => candidate.id === skill)) {
    throw new Error(`Unknown skill: ${skill}. Add it to the catalog before routing work to it.`);
  }
  item.route = { skill, decidedBy, why, at };
  return item.route;
}

// Only meaningful once a catalog exists; an empty catalog means the feature is
// unused, not that every item is adrift.
export function unroutedItems(state) {
  if (!(state.skills || []).length) return [];
  return state.workItems.filter((item) => ACTIVE.has(item.status) && item.status !== 'prepared' && !item.route);
}

const RANK_RULES = [
  { when: (item) => item.status === 'blocked', score: 900, why: 'blocked — needs a decision' },
  { when: (item) => item.status === 'verified', score: 700, why: 'verified — ready to release' },
  { when: (item) => item.status === 'reported_done', score: 600, why: 'reported done — needs verification' },
  { when: (item, stale) => item.status === 'running' && stale, score: 500, why: 'running but stale — no new evidence' },
  { when: (item) => item.status === 'running', score: 300, why: 'in progress' },
  { when: (item) => item.status === 'prepared', score: 200, why: 'ready to start' },
];

// ponytail: additive heuristic, no learning. If the ordering starts feeling
// wrong, tune these weights before reaching for anything cleverer.
export function rank(state, { direction = { pinned: [], notNow: [] }, now = new Date().toISOString(), staleHours = 24 } = {}) {
  const nowMs = Date.parse(now);
  const deferred = new Set(direction.notNow?.map((entry) => entry.split(/\s+/)[0]) || []);
  return state.workItems
    .filter((item) => !TERMINAL.has(item.status) || item.status === 'verified')
    .map((item) => {
      const idleHours = (nowMs - Date.parse(lastEvidenceAt(item) || now)) / 3.6e6;
      const rule = RANK_RULES.find((candidate) => candidate.when(item, idleHours > staleHours));
      const pinnedAt = direction.pinned?.indexOf(item.id) ?? -1;
      let score = (rule?.score || 100) + Math.min(idleHours, 168) + (item.priority || 0) * 25;
      if (pinnedAt >= 0) score += 1000 - pinnedAt;
      if (deferred.has(item.id)) score -= 2000;
      return {
        item, score: Math.round(score), idleHours: Math.round(idleHours),
        skills: suggestSkills(state, item).map((skill) => skill.id),
        why: [pinnedAt >= 0 && 'pinned in direction.md', deferred.has(item.id) && 'deferred by direction.md', rule?.why].filter(Boolean).join('; '),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function readDenials(dir, since) {
  const file = path.join(dir, 'denials.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((entry) => !since || entry.at > since);
}

export function renderBrief(state, { direction = { pinned: [] }, since, now = new Date().toISOString(), limit = 5, denials = [] } = {}) {
  const ranked = rank(state, { direction, now });
  const moved = state.workItems.filter((item) => since && item.statusAt && item.statusAt > since);
  const errors = validateState(state);
  const awaitingDecision = (state.pilots || []).filter((pilot) => pilot.closeout?.reportedAt && !pilot.closeout?.decision);
  const list = (rows, empty) => (rows.length ? rows.join('\n') : empty);
  return [
    `# CTO brief — ${now}`,
    since ? `\nCovering changes since ${since}.` : '\nFirst brief; covering all current state.',
    '\n## Needs you\n',
    list([
      ...ranked.filter((entry) => entry.item.status === 'blocked').map((entry) => `- **${entry.item.id}** ${entry.item.title} — blocked: ${entry.item.blockedReason || 'reason not recorded'}`),
      ...awaitingDecision.map((pilot) => `- **${pilot.id}** pilot closeout awaiting your scale/adjust/stop decision`),
      ...errors.map((error) => `- state validation: ${error}`),
      ...Object.values(denials.reduce((byRule, entry) => ({ ...byRule, [entry.ruleId]: { ...entry, count: (byRule[entry.ruleId]?.count || 0) + 1 } }), {}))
        .map((entry) => `- safety rule **${entry.ruleId}** stopped the agent ${entry.count}\u00d7 (${entry.reason}) — last on \`${entry.tool}\`: \`${entry.subject}\``),
    ], '- Nothing. No decision required.'),
    '\n## Moved since last brief\n',
    list(moved.map((item) => `- **${item.id}** → \`${item.status}\` (${item.statusAt})`), '- No lifecycle changes.'),
    '\n## Working on next\n',
    list(ranked.slice(0, limit).map((entry, index) => `${index + 1}. **${entry.item.id}** ${entry.item.title} — ${entry.why} (idle ${entry.idleHours}h)`), '- Board is empty.'),
    '\n## In flight\n',
    list(state.workItems.filter((item) => ACTIVE.has(item.status)).map((item) => `- **${item.id}** \`${item.status}\` ${item.repository ? `${item.repository}#${item.issue || '?'}` : ''}${item.pr ? ` PR #${item.pr}` : ''}`
      + (item.route ? ` — via **${item.route.skill}** (${item.route.decidedBy})` : (state.skills || []).length ? ' — **no recorded approach**' : '')), '- Nothing in flight.'),
    `\n## Steering\n\nEdit \`ops/coding-control/direction.md\` to change priorities. Pinned right now: ${direction.pinned?.length ? direction.pinned.join(', ') : 'none'}.\n`,
  ].join('\n');
}

function statePath(cwd) { return path.join(cwd, 'ops', 'coding-control', 'state.json'); }
function directionPath(cwd) { return path.join(cwd, 'ops', 'coding-control', 'direction.md'); }
function readDirection(cwd) {
  return parseDirection(fs.existsSync(directionPath(cwd)) ? fs.readFileSync(directionPath(cwd), 'utf8') : DIRECTION_TEMPLATE);
}
function readState(cwd) { return JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')); }

// Write through a temp file so a cycle killed mid-write cannot leave a
// truncated state file behind.
function writeState(cwd, state) {
  const target = statePath(cwd);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, target);
}

export const LOCK_STALE_MS = 15 * 60 * 1000;

// Single writer. `wx` is an atomic create-or-fail, so two cycles cannot both
// enter a read-modify-write of the same state file.
// ponytail: a lock left by a killed process is broken after LOCK_STALE_MS, and
// two processes breaking the same stale lock race — the loser gets EEXIST and
// exits. Reach for a real lease only if cycles start running on many hosts.
// Anything held longer than LOCK_STALE_MS is at risk of being broken under it,
// so keep slow work inside the section bounded by its own timeouts.
export async function withLock(cwd, fn) {
  const lock = path.join(path.dirname(statePath(cwd)), '.lock');
  let handle;
  try {
    handle = fs.openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const held = fs.statSync(lock);
    if (Date.now() - held.mtimeMs < LOCK_STALE_MS) {
      throw new Error(`another cycle holds ${lock} (since ${held.mtime.toISOString()}); refusing to write concurrently.`);
    }
    fs.rmSync(lock, { force: true });
    handle = fs.openSync(lock, 'wx');
  }
  try {
    fs.writeSync(handle, `${process.pid}\n`);
    // Awaited, so an async critical section holds the lock until it finishes
    // rather than releasing it the moment it returns a promise.
    return await fn();
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command = 'help'] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === 'init') {
    const target = statePath(cwd);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) writeState(cwd, { ...emptyState(), repos: [], briefs: [] });
    if (!fs.existsSync(directionPath(cwd))) fs.writeFileSync(directionPath(cwd), DIRECTION_TEMPLATE);
    console.log(`${target}\n${directionPath(cwd)}`);
  } else if (command === 'sync') {
    const { syncAll } = await import('./github.mjs');
    const changes = await withLock(cwd, () => {
      const state = readState(cwd);
      const observed = syncAll(state);
      writeState(cwd, state);
      return observed;
    });
    console.log(changes.length ? changes.join('\n') : 'sync: no changes observed');
  } else if (command === 'smoke') {
    const { syncAllReleases } = await import('./release.mjs');
    const changes = await withLock(cwd, async () => {
      const state = readState(cwd);
      const observed = await syncAllReleases(state, {});
      if (observed.length) writeState(cwd, state);
      return observed;
    });
    console.log(changes.length ? changes.join('\n') : 'smoke: nothing awaiting release');
  } else if (command === 'next') {
    const state = readState(cwd);
    const ranked = rank(state, { direction: readDirection(cwd) });
    console.log(ranked.length
      ? ranked.map((entry, index) => `${index + 1}. ${entry.item.id} [${entry.item.status}] ${entry.item.title} — ${entry.why}`
        + (entry.item.route ? ` | routed: ${entry.item.route.skill}` : entry.skills.length ? ` | applicable: ${entry.skills.join(', ')}` : '')).join('\n')
      : 'next: board is empty');
  } else if (command === 'route') {
    const [workItemId, skill, decidedBy, ...why] = process.argv.slice(3);
    await withLock(cwd, () => {
      const state = readState(cwd);
      recordRoute(state, workItemId, { skill, decidedBy, why: why.join(' ') || undefined });
      writeState(cwd, state);
    });
    console.log(`routed ${workItemId} to ${skill}`);
  } else if (command === 'brief') {
    const now = new Date().toISOString();
    const { brief, notify } = await withLock(cwd, () => {
      const state = readState(cwd);
      const since = state.briefs?.at(-1)?.at;
      const rendered = renderBrief(state, { direction: readDirection(cwd), since, now, denials: readDenials(path.dirname(statePath(cwd)), since) });
      const briefPath = path.join(cwd, 'ops', 'coding-control', 'reports', `brief-${now.replace(/[:.]/g, '-')}.md`);
      fs.mkdirSync(path.dirname(briefPath), { recursive: true });
      fs.writeFileSync(briefPath, rendered);
      (state.briefs ||= []).push({ at: now, path: path.relative(cwd, briefPath) });
      writeState(cwd, state);
      return { brief: rendered, notify: state.notify };
    });
    // Delivery is a command you configure; the harness does not own a channel.
    if (notify) {
      const { execFileSync } = await import('node:child_process');
      try { execFileSync('sh', ['-c', notify], { input: brief, stdio: ['pipe', 'inherit', 'inherit'] }); }
      catch (error) { console.error(`brief written but delivery failed: ${error.message}`); process.exitCode = 1; }
    }
    console.log(brief);
  } else if (command === 'validate') {
    const errors = validateState(readState(cwd));
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log('coding-control validation: passed');
  } else if (command === 'board') {
    console.log(JSON.stringify(readState(cwd).workItems.map(({ id, title, owner, status, statusAt }) => ({ id, title, owner, status, statusAt })), null, 2));
  } else if (command === 'pilot-report') {
    console.log(await withLock(cwd, () => {
      const state = readState(cwd);
      const pilot = state.pilots.find((candidate) => candidate.id === process.argv[3]);
      if (!pilot) throw new Error(`Unknown pilot: ${process.argv[3] || '(id required)'}`);
      const completion = pilotCompletion(state, pilot);
      if (!completion.ready) {
        return JSON.stringify({ pilot: pilot.id, ready: false, remaining: completion.incomplete.map((item) => ({ id: item.id, status: item.status })), missing: completion.missing }, null, 2);
      }
      const report = renderPilotReport(state, pilot);
      const reportPath = path.join(cwd, 'ops', 'coding-control', 'reports', `${pilot.id}.md`);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, report);
      pilot.closeout.reportedAt = new Date().toISOString();
      pilot.closeout.reportPath = path.relative(cwd, reportPath);
      writeState(cwd, state);
      return reportPath;
    }));
  } else if (command === 'record-pilot-decision') {
    const [pilotId, decision, decidedBy] = process.argv.slice(3);
    await withLock(cwd, () => {
      const state = readState(cwd);
      recordPilotDecision(state, pilotId, decision, decidedBy);
      writeState(cwd, state);
    });
    console.log(`pilot decision recorded: ${pilotId}=${decision}`);
  } else {
    console.log(['Usage: node src/control-plane.mjs <command>', '',
      '  init                     create state.json and direction.md',
      '  sync                     observe configured repos via gh and record evidence',
      '  smoke                    observe production and record release evidence',
      '  next                     print the prioritised queue and applicable skills',
      '  route ID SKILL BY [WHY]  record which approach was chosen for a work item',
      '  brief                    write and print the standing report for the human',
      '  validate                 check the state file',
      '  board                    dump the work item board',
      '  pilot-report PILOT_ID',
      '  record-pilot-decision PILOT_ID scale|adjust|stop DECIDED_BY'].join('\n'));
  }
}
