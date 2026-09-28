import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentTemsMergeAuthority, assertTemsMergeAuthority } from '../src/tems-merge-authority.mjs';

const base = { agentId: 'tems-cto', mode: 'routine', repositories: ['jgraham310/tems'], autonomousOperations: ['merge_green_pr'], protocolRequired: ['merge_green_pr'], productionAuthority: false, boundedAuthority: { merge: false, production: false, prohibitedOperations: ['merge_green_pr'] } };
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', base), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: undefined }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: ['merge_green_pr'] } }), /prohibited/);
const allowed = { ...base, boundedAuthority: { merge: true, production: false, prohibitedOperations: [] } };
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/tems', allowed));
for (const mode of ['shadow', 'controlled']) assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...allowed, mode }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...allowed, protocolRequired: [] }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...allowed, productionAuthority: true }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...allowed, boundedAuthority: { ...allowed.boundedAuthority, production: true } }), /prohibited/);
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/local-government', base));
const dir = mkdtempSync(join(tmpdir(), 'tems-merge-authority-'));
try {
  const charter = join(dir, 'CHARTER.json');
  const deployed = join(dir, 'DEPLOYED.json');
  writeFileSync(deployed, JSON.stringify(base));
  writeFileSync(charter, JSON.stringify(base));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed), /prohibited/);
  writeFileSync(charter, JSON.stringify(allowed));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed), /prohibited/);
  writeFileSync(deployed, JSON.stringify(allowed));
  const head = '1234567890abcdef1234567890abcdef12345678';
  const proof = join(dir, 'protocol.json');
  const statePath = join(dir, 'kernel-state.json');
  const now = Date.now();
  const valid = { kind: 'kernel_pr_verification', status: 'passed', repository: 'jgraham310/tems',
    pr: 654, head_sha: head, artifact: `git:${head}`, observer: 'coding-kernel',
    observedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString(),
    kernel_operation_id: 'kop-test-1', work_item_id: 'issue-567' };
  const operation = { id: valid.kernel_operation_id, operation: 'pr-observe', status: 'applied',
    repository: valid.repository, payload: { repository: valid.repository, workItemId: valid.work_item_id,
      event: 'checks_passed', head }, now: valid.observedAt,
    result: { ok: true, status: 'verified', head, workItemId: valid.work_item_id } };
  const item = { id: valid.work_item_id, repository: valid.repository, pr: valid.pr, head,
    status: 'verified', evidence: [{ type: 'verification_passed', commit: head, observedAt: valid.observedAt }] };
  const state = { schema: 'coding_control_kernel_state/v1', operations: [operation], prItems: [item] };
  writeFileSync(statePath, JSON.stringify(state));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed, 654, head), /protocol evidence/);
  for (const invalid of [{ ...valid, head_sha: '0'.repeat(40) },
    { ...valid, pr: 655 }, { ...valid, status: 'pending' },
    { ...valid, expiresAt: new Date(now - 1000).toISOString() },
    { ...valid, observedAt: new Date(now + 60000).toISOString() }]) {
    writeFileSync(proof, JSON.stringify(invalid));
    assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed, 654, head, proof, statePath), /protocol evidence/);
  }
  writeFileSync(proof, JSON.stringify(valid));
  assert.doesNotThrow(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed, 654, head, proof, statePath));
  for (const forged of [{ ...valid, kernel_operation_id: 'kop-absent' },
    { ...valid, work_item_id: 'issue-other' }]) {
    writeFileSync(proof, JSON.stringify(forged));
    assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed, 654, head, proof, statePath), /kernel-issued/);
  }
  writeFileSync(proof, JSON.stringify(valid));
  writeFileSync(statePath, JSON.stringify({ ...state, operations: [{ ...operation, payload: { ...operation.payload, head: '0'.repeat(40) } }] }));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed, 654, head, proof, statePath), /kernel-issued/);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('TEMS bounded merge authority tests: passed');
