import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentTemsMergeAuthority, assertTemsMergeAuthority } from '../src/tems-merge-authority.mjs';

const base = { agentId: 'tems-cto', mode: 'routine', repositories: ['jgraham310/tems'], autonomousOperations: ['merge_green_pr'], protocolRequired: ['merge_green_pr'], boundedAuthority: { merge: false, prohibitedOperations: ['merge_green_pr'] } };
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', base), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: undefined }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: ['merge_green_pr'] } }), /prohibited/);
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, mode: 'shadow', boundedAuthority: { merge: true, prohibitedOperations: [] } }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, protocolRequired: [], boundedAuthority: { merge: true, prohibitedOperations: [] } }), /prohibited/);
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/local-government', base));
const dir = mkdtempSync(join(tmpdir(), 'tems-merge-authority-'));
try {
  const charter = join(dir, 'CHARTER.json');
  const deployed = join(dir, 'DEPLOYED.json');
  writeFileSync(deployed, JSON.stringify(base));
  writeFileSync(charter, JSON.stringify(base));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed), /prohibited/);
  writeFileSync(charter, JSON.stringify({ ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed), /prohibited/);
  writeFileSync(deployed, JSON.stringify({ ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
  assert.doesNotThrow(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('TEMS bounded merge authority tests: passed');
