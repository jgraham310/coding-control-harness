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
function claimId(claim) {
  return createHash('sha256').update(`${claim.subject}\n${claim.claim}\n${claim.validFrom}`).digest('hex').slice(0, 32);
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

function finish(claim) {
  claim.id = claimId(claim);
  return claim;
}

/**
 * Allowlisted fact kind #1: an item reached production. This is a durable
 * historical fact — a later release does not make it untrue — so each item
 * gets its own subject and nothing supersedes anything.
 */
export function releaseItemClaims(state) {
  return releaseFacts(state).map((fact) => finish({
    id: '',
    claim: `Work item ${fact.id} in ${fact.repository} was released: merge commit ${fact.mergeCommit} reached the live deployment ${fact.deployed}, and release smoke checks passed against it.`,
    subject: `release/item/${fact.repository}/${fact.id}`,
    validFrom: fact.observedAt.slice(0, 10),
    validUntil: null,
    source: 'harness ledger',
    authority: 'harness',
    provenance: { evidenceIds: fact.evidenceIds, repository: fact.repository },
  }));
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
    const timeline = [];
    for (const fact of facts) {
      const open = timeline.at(-1);
      // Two different commits observed live at the same instant is the ledger
      // contradicting itself about what is running. Ordering them would be a
      // guess, and a guess is exactly what must not reach a memory system.
      if (open && open.lastAt === fact.at && open.deployed !== fact.deployed) {
        throw new Error(`${repository}: commits ${open.deployed} and ${fact.deployed} are both recorded live at ${fact.observedAt}; refusing to guess which superseded the other`);
      }
      if (open && open.deployed === fact.deployed) {
        open.lastAt = fact.at;
        open.evidenceIds.add(fact.smokeEvidenceId);
        continue;
      }
      timeline.push({ deployed: fact.deployed, observedAt: fact.observedAt, lastAt: fact.at, evidenceIds: new Set([fact.smokeEvidenceId]) });
    }

    for (const [index, entry] of timeline.entries()) {
      const next = timeline[index + 1];
      claims.push(finish({
        id: '',
        claim: `${repository} is deployed at commit ${entry.deployed}, attested by release smoke checks.`,
        subject: `release/state/${repository}`,
        validFrom: entry.observedAt.slice(0, 10),
        // Day-granular, per the contract. Two deployments on one day leave the
        // earlier with an empty window, which is the right reading: by the end
        // of that day the later one is what was live.
        validUntil: next ? next.observedAt.slice(0, 10) : null,
        source: 'harness ledger',
        authority: 'harness',
        provenance: { evidenceIds: [...entry.evidenceIds].sort(), repository },
      }));
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
