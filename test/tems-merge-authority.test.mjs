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
  assert.doesNotThrow(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter, deployed));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('TEMS bounded merge authority tests: passed');
