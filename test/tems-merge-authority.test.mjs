import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCurrentTemsMergeAuthority, assertTemsMergeAuthority } from '../src/tems-merge-authority.mjs';

const base = { agentId: 'tems-cto', repositories: ['jgraham310/tems'], boundedAuthority: { merge: false, prohibitedOperations: ['merge_green_pr'] } };
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', base), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: undefined }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: ['merge_green_pr'] } }), /prohibited/);
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/local-government', base));
const dir = mkdtempSync(join(tmpdir(), 'tems-merge-authority-'));
try {
  const charter = join(dir, 'CHARTER.json');
  writeFileSync(charter, JSON.stringify(base));
  assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter), /prohibited/);
  writeFileSync(charter, JSON.stringify({ ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
  assert.doesNotThrow(() => assertCurrentTemsMergeAuthority('jgraham310/tems', charter));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('TEMS bounded merge authority tests: passed');
