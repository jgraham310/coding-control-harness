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
export const EVIDENCE_FOR = {
  running: ['executor_started'],
  reported_done: ['executor_result'],
  verified: ['verification_passed'],
  released: ['release_smoke_passed'],
};

export function emptyState() {
  return {
    schema: 'coding_control_state/v1',
    workItems: [], checkpoints: [], fileReservations: [], memory: { proposals: [], reviews: [] }, safetyRules: [], pilots: [],
  };
}

export function evidenceTypes(item) {
  return new Set((item.evidence || []).map((entry) => entry.type));
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

export function missingEvidence(item, status = item.status) {
  return (EVIDENCE_FOR[status] || []).filter((type) => !evidenceTypes(item).has(type));
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

function statePath(cwd) { return path.join(cwd, 'ops', 'coding-control', 'state.json'); }
function readState(cwd) { return JSON.parse(fs.readFileSync(statePath(cwd), 'utf8')); }
function writeState(cwd, state) { fs.writeFileSync(statePath(cwd), `${JSON.stringify(state, null, 2)}\n`); }

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command = 'help'] = process.argv.slice(2);
  const cwd = process.cwd();
  if (command === 'init') {
    const target = statePath(cwd);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) writeState(cwd, emptyState());
    console.log(target);
  } else if (command === 'validate') {
    const errors = validateState(readState(cwd));
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; } else console.log('coding-control validation: passed');
  } else if (command === 'board') {
    console.log(JSON.stringify(readState(cwd).workItems.map(({ id, title, owner, status, statusAt }) => ({ id, title, owner, status, statusAt })), null, 2));
  } else if (command === 'pilot-report') {
    const pilot = readState(cwd).pilots.find((candidate) => candidate.id === process.argv[3]);
    if (!pilot) throw new Error(`Unknown pilot: ${process.argv[3] || '(id required)'}`);
    const state = readState(cwd);
    const completion = pilotCompletion(state, pilot);
    if (!completion.ready) {
      console.log(JSON.stringify({ pilot: pilot.id, ready: false, remaining: completion.incomplete.map((item) => ({ id: item.id, status: item.status })), missing: completion.missing }, null, 2));
    } else {
      const report = renderPilotReport(state, pilot);
      const reportPath = path.join(cwd, 'ops', 'coding-control', 'reports', `${pilot.id}.md`);
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, report);
      pilot.closeout.reportedAt = new Date().toISOString();
      pilot.closeout.reportPath = path.relative(cwd, reportPath);
      writeState(cwd, state);
      console.log(reportPath);
    }
  } else if (command === 'record-pilot-decision') {
    const [pilotId, decision, decidedBy] = process.argv.slice(3);
    const state = readState(cwd);
    recordPilotDecision(state, pilotId, decision, decidedBy);
    writeState(cwd, state);
    console.log(`pilot decision recorded: ${pilotId}=${decision}`);
  } else {
    console.log('Usage: node ops/coding-control/control-plane.mjs <init|validate|board|pilot-report PILOT_ID|record-pilot-decision PILOT_ID scale|adjust|stop DECIDED_BY>');
  }
}
