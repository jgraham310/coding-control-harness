import assert from 'node:assert/strict';
import { emptyState } from '../src/control-plane.mjs';
import { SCHEMA, buildExport, canonical, deploymentStateClaims, releaseItemClaims, stateDigest } from '../src/memory-export.mjs';

const NOW = '2026-08-28T12:00:00Z';
const HEAD = 'cccccccccccccccccccccccccccccccccccccccc';
const MERGE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

// A ledger holding one released item, plus the chain of evidence it needs to
// be valid at all.
const released = (overrides = {}) => ({
  id: 'api#7', title: 'Rate limit', owner: 'openclaw', repository: 'acme/api', issue: 7, pr: 31,
  status: 'released', statusAt: NOW, head: HEAD, mergeCommit: MERGE, mergedAt: NOW,
  evidence: [
    { type: 'executor_started', source: 'PR #31 opened', observedAt: NOW },
    { type: 'executor_result', source: 'PR #31 ready for review', observedAt: NOW },
    { type: 'verification_passed', source: 'PR #31 checks green at the head', observedAt: NOW, commit: HEAD },
    { type: 'release_smoke_passed', source: '2 smoke check(s) passed', observedAt: NOW, commit: HEAD, mergeCommit: MERGE, deployed: LIVE, witnesses: 2 },
  ],
  ...overrides,
});

const board = (...items) => ({ ...emptyState(), repos: [{ name: 'acme/api' }], workItems: items });

// A valid export carries the versioned envelope, and one release produces both
// the durable item fact and the repository's current deployment state.
const exported = buildExport(board(released()), { now: NOW });
assert.equal(exported.schema, SCHEMA);
assert.equal(exported.generatedAt, '2026-08-28T12:00:00.000Z');
assert.deepEqual(Object.keys(exported), ['schema', 'generatedAt', 'source', 'claims']);
assert.equal(exported.source.system, 'coding-control-harness');
assert.match(exported.source.stateDigest, /^sha256:[0-9a-f]{64}$/);
assert.deepEqual(exported.claims.map((entry) => entry.subject), ['delivery/item/acme/api/api#7', 'release/state/acme/api']);
// Item facts stay outside the `release/` prefix a consumer governs release
// state by. They never close, so under that prefix every item ever shipped
// would be served as current release state.
assert.ok(exported.claims.every((entry) => !/^release\//.test(entry.subject) || entry.subject === 'release/state/acme/api'));
assert.equal(exported.claims.filter((entry) => /^release\//.test(entry.subject) && entry.validUntil === null).length, 1,
  'exactly one claim under the governed release prefix is open');
const [claim, deployment] = exported.claims;
assert.equal(claim.subject, 'delivery/item/acme/api/api#7');
assert.match(deployment.claim, /^acme\/api is deployed at commit bbbb/);
assert.equal(deployment.validUntil, null, 'the only deployment is the current one');
assert.deepEqual(deployment.provenance.evidenceIds, [`api#7/release_smoke_passed@${HEAD}`]);
assert.equal(claim.authority, 'harness');
assert.equal(claim.source, 'harness ledger');
assert.equal(claim.validFrom, '2026-08-28');
assert.equal(claim.validUntil, null);
assert.match(claim.id, /^[0-9a-f]{32}$/);
assert.match(claim.claim, /was released: merge commit aaaa/);
assert.deepEqual(claim.provenance, {
  evidenceIds: [`api#7/release_smoke_passed@${HEAD}`, `api#7/verification_passed@${HEAD}`],
  repository: 'acme/api',
});
for (const entry of exported.claims) {
  for (const key of ['id', 'claim', 'subject', 'validFrom', 'source', 'authority', 'provenance']) {
    assert.ok(entry[key], `every claim carries ${key}`);
  }
  assert.equal(entry.authority, 'harness');
  assert.ok(entry.provenance.evidenceIds.length, 'every claim carries evidence');
}

// Nothing that is not an allowlisted scalar reaches the output: evidence prose,
// blocked reasons, and configured commands stay inside the harness.
const leaky = board(released({ blockedReason: 'token ghp_SECRETSECRETSECRET rejected' }));
leaky.workItems[0].evidence[3].source = 'smoke passed via https://api.example.com/?token=ghp_SECRETSECRETSECRET';
leaky.notify = 'curl -H "Authorization: Bearer ghp_SECRETSECRETSECRET" https://hooks.example.com';
const rendered = JSON.stringify(buildExport(leaky, { now: NOW }));
assert.ok(!rendered.includes('ghp_SECRET'), 'no credential from the ledger appears in the export');
assert.ok(!rendered.includes('hooks.example.com'), 'no configured URL appears in the export');
assert.ok(!rendered.includes('smoke passed via'), 'no evidence prose appears in the export');

// An item that has not reached `released` is not a fact about production, and
// an empty board still produces a well-formed envelope rather than an error.
const notYet = released({ status: 'verified' });
notYet.evidence = notYet.evidence.filter((entry) => entry.type !== 'release_smoke_passed');
assert.deepEqual(releaseItemClaims(board(notYet)), []);
assert.deepEqual(buildExport(board(), { now: NOW }).claims, []);
assert.deepEqual(buildExport(board(notYet), { now: NOW }).claims, []);

// Evidence that is present but incomplete is refused outright. Emitting the
// claim without its deployment commit would weaken it into something the
// ledger never observed.
for (const field of ['mergeCommit', 'deployed', 'observedAt']) {
  const broken = released();
  delete broken.evidence[3][field];
  assert.throws(() => releaseItemClaims(board(broken)), /refusing to export a weakened claim/, `missing ${field} is refused`);
}
const malformed = released();
malformed.evidence[3].deployed = 'not-a-commit';
assert.throws(() => releaseItemClaims(board(malformed)), /deployed commit is missing or malformed/);

// A ledger that contradicts itself is not an authority, so the whole export is
// refused rather than filtered down to the parts that still look intact.
const invalid = board(released(), { id: 'api#8', title: 'Bad', owner: 'openclaw', repository: 'acme/api', status: 'released', statusAt: NOW, evidence: [] });
assert.throws(() => buildExport(invalid, { now: NOW }), /fails its own validation/);

// Determinism: same ledger, different clock and different array order, byte-identical claims.
const shuffled = board(released({ id: 'api#9', issue: 9 }), released());
const forwards = buildExport(shuffled, { now: NOW });
const backwards = buildExport({ ...shuffled, workItems: [...shuffled.workItems].reverse() }, { now: '2027-01-01T00:00:00Z' });
assert.equal(canonical(forwards.claims), canonical(backwards.claims), 'claims and ids do not depend on clock or ledger ordering');
assert.deepEqual(forwards.claims.map((entry) => entry.subject),
  ['delivery/item/acme/api/api#7', 'delivery/item/acme/api/api#9', 'release/state/acme/api']);
assert.equal(forwards.claims[0].id, exported.claims[0].id, 'the same fact keeps the same id across exports');
assert.equal(new Set(forwards.claims.map((entry) => entry.id)).size, 3, 'distinct facts get distinct ids');

// The digest tracks the source state: an unrelated ledger change moves it, and
// key ordering alone does not.
const base = board(released());
assert.equal(stateDigest(base), stateDigest({ ...base }));
assert.equal(stateDigest({ schema: base.schema, workItems: [] }), stateDigest({ workItems: [], schema: base.schema }));
const touched = board(released());
touched.checkpoints.push({ workItemId: 'api#7', owner: 'codex', nextAction: 'watch', successPredicate: 'quiet', recordedAt: NOW });
assert.notEqual(stateDigest(touched), stateDigest(base), 'a change anywhere in the source state changes the digest');
// A changed fact changes both the digest and the claim id.
const moved = board(released());
moved.workItems[0].evidence[3].deployed = 'dddddddddddddddddddddddddddddddddddddddd';
assert.notEqual(stateDigest(moved), stateDigest(base));
assert.notEqual(buildExport(moved, { now: NOW }).claims[0].id, exported.claims[0].id);

// --- deployment state supersedes; item facts do not ---

const DAY1 = '2026-08-20T09:00:00Z';
const DAY2 = '2026-08-24T09:00:00Z';
const DAY3 = '2026-08-28T09:00:00Z';
const D1 = '1111111111111111111111111111111111111111';
const D2 = '2222222222222222222222222222222222222222';

// One repository, released twice, against two different deployments.
const at = (id, when, deployed, head) => {
  const item = released({ id, issue: Number(id.split('#')[1]), head, statusAt: when });
  item.mergeCommit = `${id.split('#')[1]}`.repeat(40).slice(0, 40);
  for (const entry of item.evidence) {
    entry.observedAt = when;
    if (entry.commit) entry.commit = head;
  }
  const smoke = item.evidence.at(-1);
  smoke.deployed = deployed;
  smoke.mergeCommit = item.mergeCommit;
  return item;
};
const sequential = board(at('api#1', DAY1, D1, 'd'.repeat(40)), at('api#2', DAY2, D2, 'e'.repeat(40)));

// A "what is live" query is the open claim on the repository subject, and there
// is exactly one of them however many releases the repository has had.
const states = deploymentStateClaims(sequential).filter((entry) => entry.subject === 'release/state/acme/api');
assert.equal(states.length, 2, 'each deployment is recorded, not just the latest');
const current = states.filter((entry) => entry.validUntil === null);
assert.equal(current.length, 1, 'exactly one deployment state is current');
assert.match(current[0].claim, new RegExp(`deployed at commit ${D2}`), 'the newest deployment is the current one');

// The superseded state is closed by its successor rather than deleted, so an
// as-of query still resolves it — and the two windows do not overlap.
const asOf = (date) => states.filter((entry) => entry.validFrom <= date && (entry.validUntil === null || date < entry.validUntil));
assert.equal(asOf('2026-08-22').length, 1);
assert.match(asOf('2026-08-22')[0].claim, new RegExp(`deployed at commit ${D1}`), 'an as-of query retrieves the prior state');
assert.match(asOf('2026-08-28')[0].claim, new RegExp(`deployed at commit ${D2}`));
assert.equal(asOf('2026-08-19').length, 0, 'nothing is claimed before the first release');
assert.deepEqual(states.map((entry) => [entry.validFrom, entry.validUntil]), [['2026-08-20', '2026-08-24'], ['2026-08-24', null]]);

// The item facts are durable: a later release supersedes neither of them, and
// they never share a subject.
const items = releaseItemClaims(sequential);
assert.deepEqual(items.map((entry) => entry.subject), ['delivery/item/acme/api/api#1', 'delivery/item/acme/api/api#2']);
assert.deepEqual(items.map((entry) => entry.validUntil), [null, null], 'reaching production does not stop being true');

// Repositories do not supersede one another.
const twoRepos = board(at('api#1', DAY1, D1, 'd'.repeat(40)), { ...at('web#1', DAY2, D2, 'f'.repeat(40)), repository: 'acme/web' });
const live = deploymentStateClaims(twoRepos).filter((entry) => entry.validUntil === null);
assert.deepEqual(live.map((entry) => entry.subject).sort(), ['release/state/acme/api', 'release/state/acme/web']);
assert.equal(live.length, 2, 'each repository keeps its own current deployment');

// Several items released against one deployment describe one state, and it
// carries all of their evidence.
const together = board(at('api#1', DAY1, D1, 'd'.repeat(40)), at('api#2', DAY1, D1, 'e'.repeat(40)));
const [shared] = deploymentStateClaims(together);
assert.equal(deploymentStateClaims(together).length, 1, 'one deployment is one state, however many items rode it');
assert.deepEqual(shared.provenance.evidenceIds, [`api#1/release_smoke_passed@${'d'.repeat(40)}`, `api#2/release_smoke_passed@${'e'.repeat(40)}`]);

// A rollback to an earlier commit is a new state, not a re-opening of the old one.
const rolledBack = board(at('api#1', DAY1, D1, 'd'.repeat(40)), at('api#2', DAY2, D2, 'e'.repeat(40)), at('api#3', DAY3, D1, 'f'.repeat(40)));
const rollback = deploymentStateClaims(rolledBack);
assert.deepEqual(rollback.map((entry) => entry.validFrom), ['2026-08-20', '2026-08-24', '2026-08-28']);
assert.equal(new Set(rollback.map((entry) => entry.id)).size, 3, 'a returning commit is a distinct state with its own id');
assert.equal(new Set(rollback.map((entry) => entry.claim)).size, 2, 'the returning state repeats its wording but not its identity');
assert.equal(rollback.filter((entry) => entry.validUntil === null).length, 1);

// Validity is day-granular, so a day carries one state: the one live at the end
// of it. Emitting the earlier ones would mean windows that start and end on the
// same date, which a consumer ordering claims by date cannot sequence — the
// day's real final state can be closed by one of its own predecessors, leaving
// the repository with no current deployment at all.
const sameDay = board(
  at('api#1', '2026-08-20T09:00:00Z', D1, 'd'.repeat(40)),
  at('api#2', '2026-08-20T11:00:00Z', D2, 'e'.repeat(40)),
  at('api#3', '2026-08-20T15:00:00Z', D1, 'f'.repeat(40)),
);
const endOfDay = deploymentStateClaims(sameDay);
assert.equal(endOfDay.length, 1, 'a day is one state');
assert.match(endOfDay[0].claim, new RegExp(`deployed at commit ${D1}`), 'the state live at the end of the day is the one recorded');
assert.equal(endOfDay[0].validUntil, null);
assert.deepEqual(endOfDay[0].provenance.evidenceIds, [`api#3/release_smoke_passed@${'f'.repeat(40)}`],
  'the evidence is the surviving state\'s own, not a different commit\'s');
assert.equal(new Set(endOfDay.map((entry) => entry.id)).size, endOfDay.length);
// The intra-day releases are not lost — they remain durable item facts.
assert.equal(releaseItemClaims(sameDay).length, 3);

// No two claims on a subject may share a validFrom, or a consumer ordering by
// date has no way to sequence them.
for (const ledger of [sequential, rolledBack, sameDay, together]) {
  const seen = new Map();
  for (const entry of deploymentStateClaims(ledger)) {
    const key = `${entry.subject}@${entry.validFrom}`;
    assert.ok(!seen.has(key), `two claims share ${key}`);
    seen.set(key, entry);
    assert.ok(entry.validUntil === null || entry.validUntil > entry.validFrom, 'a window that ends must end after it starts');
  }
}

// A commit still deployed the next day is not a new state.
const stillThere = board(at('api#1', DAY1, D1, 'd'.repeat(40)), at('api#2', DAY2, D1, 'e'.repeat(40)));
assert.equal(deploymentStateClaims(stillThere).length, 1, 'an unchanged deployment is one continuing state');

// Two commits recorded live at the same instant is the ledger contradicting
// itself. Ordering them would be a guess.
const contradictory = board(at('api#1', DAY1, D1, 'd'.repeat(40)), at('api#2', DAY1, D2, 'e'.repeat(40)));
assert.throws(() => deploymentStateClaims(contradictory), /both recorded live at .*refusing to guess/s);
assert.throws(() => buildExport(contradictory, { now: NOW }), /refusing to guess/);

// Deployment state is deterministic across ledger ordering, like everything else.
assert.equal(
  canonical(deploymentStateClaims(rolledBack)),
  canonical(deploymentStateClaims({ ...rolledBack, workItems: [...rolledBack.workItems].reverse() })),
  'the deployment timeline does not depend on the order items sit in the ledger',
);

console.log('coding-control memory-export tests: passed');
