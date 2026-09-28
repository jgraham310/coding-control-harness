import assert from 'node:assert/strict';
import { assertCurrentTemsMergeAuthority, assertTemsMergeAuthority } from '../src/tems-merge-authority.mjs';

const base = { agentId: 'tems-cto', repositories: ['jgraham310/tems'], boundedAuthority: { merge: false, prohibitedOperations: ['merge_green_pr'] } };
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', base), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: undefined }), /prohibited/);
assert.throws(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: ['merge_green_pr'] } }), /prohibited/);
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/tems', { ...base, boundedAuthority: { merge: true, prohibitedOperations: [] } }));
assert.doesNotThrow(() => assertTemsMergeAuthority('jgraham310/local-government', base));
assert.throws(() => assertCurrentTemsMergeAuthority('jgraham310/tems'), /prohibited/);
console.log('TEMS bounded merge authority tests: passed');
