/**
 * The loop from what actually happened to a skill that changed because of it.
 *
 *   traces → observed pattern → promoted (a human agreed) → skill revision
 *          → measured outcome (did the signal actually stop?)
 *
 * Two things this deliberately does not do. It does not write the skill
 * change: deriving "these items keep getting blocked" is arithmetic, deciding
 * what to do about it is judgement, and the harness does not hold judgement.
 * And it does not pronounce a revision good — it only reports whether the
 * pattern that motivated it recurred afterwards. A skill update is a
 * hypothesis, and this measures it rather than believing it.
 */

export const PATTERN_THRESHOLD = 3;
export const SETTLE_HOURS = 168;

const since = (at, from) => !from || (at || '') > from;

/**
 * Derived fresh from the record every time, never stored as opinion. A single
 * bad day is not a pattern, so nothing below the threshold is reported.
 */
export function observePatterns(state, { denials = [], from, threshold = PATTERN_THRESHOLD } = {}) {
  const found = [];
  const add = (kind, subject, occurrences, detail) => {
    if (occurrences.length >= threshold) {
      found.push({
        id: `${kind}:${subject}`, kind, subject, detail,
        count: occurrences.length,
        first: occurrences[0], last: occurrences[occurrences.length - 1],
      });
    }
  };

  for (const item of state.workItems) {
    const blocks = (item.history || []).filter((entry) => entry.to === 'blocked' && since(entry.at, from)).map((entry) => entry.at);
    add('repeated_block', item.id, blocks, `${item.id} has entered blocked ${blocks.length} times`);
  }

  const byRule = {};
  for (const denial of denials) {
    if (since(denial.at, from)) (byRule[denial.ruleId] ||= []).push(denial.at);
  }
  for (const [ruleId, times] of Object.entries(byRule)) {
    add('rule_friction', ruleId, times.sort(), `safety rule ${ruleId} stopped the agent ${times.length} times`);
  }

  // The one that points at a skill: work routed to it that then went wrong.
  const bySkill = {};
  for (const item of state.workItems) {
    if (!item.route) continue;
    for (const entry of item.history || []) {
      if (entry.to !== 'blocked' || !since(entry.at, from)) continue;
      if (entry.at >= item.route.at) (bySkill[item.route.skill] ||= []).push(entry.at);
    }
  }
  for (const [skill, times] of Object.entries(bySkill)) {
    add('skill_ineffective', skill, times.sort(), `work routed to ${skill} was blocked ${times.length} times afterwards`);
  }

  return found.sort((a, b) => b.count - a.count);
}

/**
 * A pattern becomes durable when a person says it is. Promotion snapshots the
 * count that justified it, so a later revision can be judged against what was
 * actually seen rather than against a number that has since moved.
 */
export function promotePattern(state, patternId, { reviewer, note }, observed, at = new Date().toISOString()) {
  const pattern = observed.find((candidate) => candidate.id === patternId);
  if (!pattern) throw new Error(`${patternId} is not an observed pattern; only what the traces show can be promoted.`);
  if (!String(reviewer || '').trim()) throw new Error('Promoting a pattern requires the reviewer.');
  state.patterns ||= [];
  if (state.patterns.some((candidate) => candidate.id === patternId && !candidate.closedAt)) {
    throw new Error(`${patternId} is already promoted.`);
  }
  const record = { ...pattern, reviewer: reviewer.trim(), note: String(note || '').trim() || undefined, promotedAt: at, baseline: pattern.count };
  state.patterns.push(record);
  return record;
}

export function recordSkillRevision(state, { skill, pattern, revision, by, note }, at = new Date().toISOString()) {
  const promoted = (state.patterns || []).find((candidate) => candidate.id === pattern && !candidate.closedAt);
  if (!promoted) throw new Error(`${pattern} is not a promoted pattern; a revision must answer one that was confirmed.`);
  if (!(state.skills || []).some((candidate) => candidate.id === skill)) throw new Error(`Unknown skill: ${skill}.`);
  const version = String(revision || '').trim();
  const author = String(by || '').trim();
  if (!version) throw new Error('A revision requires an identifier — a version or a commit — so the change can be found.');
  if (!author) throw new Error('A revision requires its author.');
  state.revisions ||= [];
  const record = { id: `${skill}@${version}`, skill, pattern, revision: version, by: author, note: String(note || '').trim() || undefined, at, outcome: 'open' };
  state.revisions.push(record);
  return record;
}

/**
 * The test. A revision holds only once the pattern has not recurred for the
 * settle window — not when someone declares it fixed. Any recurrence after the
 * revision landed marks it regressed, however good the change looked.
 */
export function assessRevisions(state, { observed = [], now = new Date().toISOString(), settleHours = SETTLE_HOURS } = {}) {
  const changed = [];
  for (const revision of state.revisions || []) {
    // `held` is a standing claim about the present, not a verdict earned once.
    // Every revision is re-assessed on every pass, so a pattern that comes
    // back months later still overturns it — a fix that stopped working is
    // exactly the thing this loop exists to catch.
    const pattern = observed.find((candidate) => candidate.id === revision.pattern);
    const recurredAt = pattern && pattern.last > revision.at ? pattern.last : null;
    const settled = (Date.parse(now) - Date.parse(revision.at)) / 3.6e6 >= settleHours;
    const outcome = recurredAt ? 'regressed' : settled ? 'held' : 'open';
    const was = revision.outcome;
    if (outcome !== was) {
      revision.outcome = outcome;
      revision.outcomeAt = now;
      changed.push(`${revision.id}: ${outcome}`
        + (outcome === 'regressed' ? ` (${revision.pattern} recurred at ${recurredAt}${was === 'held' ? ', after it had held' : ''})` : ''));
    }
    const promoted = (state.patterns || []).find((candidate) => candidate.id === revision.pattern);
    if (!promoted) continue;
    if (outcome === 'held' && !promoted.closedAt) { promoted.closedAt = now; promoted.closedBy = revision.id; }
    // A pattern that recurred is not closed, whatever was concluded earlier.
    // Only the revision that closed it may reopen it, so one revision's
    // regression cannot undo another's.
    if (outcome === 'regressed' && promoted.closedBy === revision.id) {
      delete promoted.closedAt;
      delete promoted.closedBy;
    }
  }
  return changed;
}

/** What the loop is waiting on, for the brief. */
export function loopStatus(state, observed) {
  const promoted = (state.patterns || []).filter((pattern) => !pattern.closedAt);
  const answered = new Set((state.revisions || []).filter((revision) => revision.outcome !== 'regressed').map((revision) => revision.pattern));
  return {
    unpromoted: observed.filter((pattern) => !(state.patterns || []).some((candidate) => candidate.id === pattern.id && !candidate.closedAt)),
    unanswered: promoted.filter((pattern) => !answered.has(pattern.id)),
    regressed: (state.revisions || []).filter((revision) => revision.outcome === 'regressed'),
  };
}
