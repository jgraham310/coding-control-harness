/**
 * Export of the harness's authoritative facts for a downstream memory
 * consumer. It reads the ledger and writes JSON. It never writes to the
 * ledger, never touches release state, and never infers anything the evidence
 * does not already carry.
 *
 * Only allowlisted fact kinds leave the harness, and each is built from named
 * scalar fields of the ledger — never from free text. Evidence prose, blocked
 * reasons, notify commands, repo config, and agent narrative are structurally
 * unable to reach the output, so a secret pasted into a `source` string cannot
 * be exported by accident.
 */
import { createHash } from 'node:crypto';
import { validateState } from './control-plane.mjs';

export const SCHEMA = 'harness-memory-export/v1';
export const SYSTEM = 'coding-control-harness';

// Same shapes the release adapter enforces on observed values, applied again
// here: an export is a second trust boundary, not a continuation of the first.
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const ITEM_ID = /^[A-Za-z0-9._#\/-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function require_(value, pattern, label, context) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${context}: ${label} is missing or malformed (${JSON.stringify(String(value ?? '').slice(0, 80))}); refusing to export a weakened claim`);
  }
  return value;
}

// Key-sorted serialisation, so the digest depends on the state's content and
// not on the order a writer happened to emit its keys.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function stateDigest(state) {
  return `sha256:${createHash('sha256').update(canonical(state)).digest('hex')}`;
}

// Derived from the claim itself, so the same fact keeps the same id across
// exports and a changed fact gets a new one. The ledger stores no claim ids of
// its own, and inventing stored ones would mean writing to it.
//
// The observed instant is hashed rather than `validFrom`, which is only its
// date. Two states that begin on one day — a deployment rolled back and
// restored the same day — would otherwise hash identically, and a consumer
// entitled to expect unique ids would reject the whole export over it.
function claimId(claim, observedAt) {
  return createHash('sha256').update(`${claim.subject}\n${claim.claim}\n${observedAt}`).digest('hex').slice(0, 32);
}

// Evidence records carry no id, so a reference is derived from the fields that
// identify one: the item, the kind, and the commit it was observed on.
function evidenceId(item, entry) {
  return `${item.id}/${entry.type}@${entry.commit}`;
}

function currentEvidence(item, type) {
  return (item.evidence || []).filter((entry) => entry.type === type && entry.commit === item.head);
}

/**
 * The validated release facts the ledger holds, oldest first. An item is a
 * fact source only once the ledger already says `released` and still holds
 * release-smoke evidence for its head. Anything earlier in the lifecycle is
 * not a fact about production and is simply not read.
 */
function releaseFacts(state) {
  const facts = [];
  for (const item of state.workItems || []) {
    if (item.status !== 'released') continue;
    const [smoke] = currentEvidence(item, 'release_smoke_passed');
    if (!smoke) continue;

    const context = `${item.id}: release_smoke_passed`;
    const id = require_(item.id, ITEM_ID, 'work item id', context);
    const repository = require_(item.repository, REPO, 'repository', context);
    require_(smoke.commit, SHA, 'observed commit', context);
    const mergeCommit = require_(smoke.mergeCommit, SHA, 'merge commit', context);
    const deployed = require_(smoke.deployed, SHA, 'deployed commit', context);
    const observedAt = require_(smoke.observedAt, ISO, 'observedAt', context);

    const [verification] = currentEvidence(item, 'verification_passed');
    if (!verification) throw new Error(`${context}: released without current verification evidence; refusing to export a weakened claim`);

    facts.push({
      id, repository, mergeCommit, deployed, observedAt, at: Date.parse(observedAt),
      smokeEvidenceId: evidenceId(item, smoke),
      evidenceIds: [evidenceId(item, verification), evidenceId(item, smoke)].sort(),
    });
  }
  // The deployment timeline is read off this order, so it is sorted by the
  // instant observed rather than by the string, and ties break on the item id
  // so the same ledger always yields the same timeline.
  return facts.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function finish(claim, observedAt) {
  claim.id = claimId(claim, observedAt);
  return claim;
}

/**
 * Allowlisted fact kind #1: an item reached production. This is a durable
 * historical fact — a later release does not make it untrue — so each item
 * gets its own subject and nothing supersedes anything.
 *
 * It is deliberately *not* under `release/`. A consumer that governs release
 * state matches the subject by prefix, and these claims never close, so under
 * that prefix every item ever shipped would be served as current release
 * state — reintroducing through the namespace exactly the staleness the
 * repository-scoped state subject exists to prevent.
 */
export function releaseItemClaims(state) {
  return releaseFacts(state).map((fact) => finish({
    id: '',
    claim: `Work item ${fact.id} in ${fact.repository} was released: merge commit ${fact.mergeCommit} reached the live deployment ${fact.deployed}, and release smoke checks passed against it.`,
    subject: `delivery/item/${fact.repository}/${fact.id}`,
    validFrom: fact.observedAt.slice(0, 10),
    validUntil: null,
    source: 'harness ledger',
    authority: 'harness',
    provenance: { evidenceIds: fact.evidenceIds, repository: fact.repository },
  }, fact.observedAt));
}

/**
 * Allowlisted fact kind #2: what a repository currently has deployed. Unlike
 * the item facts this is *state*, and state supersedes: every repository has
 * one subject, and each deployment observed under it closes the one before.
 *
 * So the claims for a repository form a non-overlapping timeline. The open one
 * — `validUntil: null` — is the current deployment and is the only answer to a
 * "what is live" query; the closed ones remain answerable as of a past date.
 * Several items released against a single deployment describe one state, not
 * several, so they collapse into one claim carrying all of their evidence.
 */
export function deploymentStateClaims(state) {
  const byRepository = new Map();
  for (const fact of releaseFacts(state)) {
    if (!byRepository.has(fact.repository)) byRepository.set(fact.repository, []);
    byRepository.get(fact.repository).push(fact);
  }

  const claims = [];
  for (const [repository, facts] of [...byRepository].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Two different commits observed live at the same instant is the ledger
    // contradicting itself about what is running. Ordering them would be a
    // guess, and a guess is exactly what must not reach a memory system. This
    // runs across every fact, before anything below can collapse the pair out
    // of sight.
    for (const [index, fact] of facts.entries()) {
      const previous = facts[index - 1];
      if (previous && previous.at === fact.at && previous.deployed !== fact.deployed) {
        throw new Error(`${repository}: commits ${previous.deployed} and ${fact.deployed} are both recorded live at ${fact.observedAt}; refusing to guess which superseded the other`);
      }
    }

    // Validity is day-granular, so a day holds one state: the one live at the
    // end of it. Emitting the earlier states of a day would mean emitting
    // windows that start and end on the same date, which say nothing, and
    // which a consumer ordering claims by date cannot sequence — the day's
    // real final state can then be closed by one of its own predecessors and
    // the repository ends up with no current deployment at all. Intra-day
    // history stays in the ledger and in the per-item claims; what this
    // timeline can express, it expresses exactly.
    const perDay = new Map();
    for (const fact of facts) {
      const day = fact.observedAt.slice(0, 10);
      const held = perDay.get(day);
      // Every item that rode the surviving state attests it, so their evidence
      // accumulates. An earlier commit that day attests a state this one
      // replaced, and its evidence stays with that state's own claim.
      const evidenceIds = held?.deployed === fact.deployed ? held.evidenceIds : new Set();
      perDay.set(day, { ...fact, evidenceIds: evidenceIds.add(fact.smokeEvidenceId) });
    }

    // A commit still deployed the next day is not a new state.
    const timeline = [];
    for (const fact of perDay.values()) {
      const open = timeline.at(-1);
      if (open && open.deployed === fact.deployed) {
        for (const evidence of fact.evidenceIds) open.evidenceIds.add(evidence);
        continue;
      }
      timeline.push({ deployed: fact.deployed, observedAt: fact.observedAt, evidenceIds: new Set(fact.evidenceIds) });
    }

    for (const [index, entry] of timeline.entries()) {
      const next = timeline[index + 1];
      claims.push(finish({
        id: '',
        claim: `${repository} is deployed at commit ${entry.deployed}, attested by release smoke checks.`,
        subject: `release/state/${repository}`,
        validFrom: entry.observedAt.slice(0, 10),
        validUntil: next ? next.observedAt.slice(0, 10) : null,
        source: 'harness ledger',
        authority: 'harness',
        provenance: { evidenceIds: [...entry.evidenceIds].sort(), repository },
      }, entry.observedAt));
    }
  }
  return claims;
}

/**
 * A ledger that fails its own validation is not a source of authoritative
 * facts, so the whole export is refused rather than filtered down to the parts
 * that still look intact.
 */
export function buildExport(state, { now = new Date().toISOString() } = {}) {
  const errors = validateState(state);
  if (errors.length) throw new Error(`refusing to export from a ledger that fails its own validation:\n${errors.join('\n')}`);
  return {
    schema: SCHEMA,
    generatedAt: new Date(now).toISOString(),
    source: { system: SYSTEM, stateDigest: stateDigest(state) },
    claims: [...deploymentStateClaims(state), ...releaseItemClaims(state)]
      .sort((a, b) => a.subject.localeCompare(b.subject) || a.validFrom.localeCompare(b.validFrom) || a.id.localeCompare(b.id)),
  };
}
