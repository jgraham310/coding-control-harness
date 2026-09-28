import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const pinnedRunner = resolve('test/fixtures/pr-merge-runner.mjs');
assert.ok(existsSync(pinnedRunner), 'portfolio merge runner fixture is required');
const runnerSource = process.env.TEMS_RUNNER_SOURCE ? resolve(process.env.TEMS_RUNNER_SOURCE) : pinnedRunner;
assert.ok(existsSync(runnerSource), `runner source is required: ${runnerSource}`);
const source = readFileSync(runnerSource, 'utf8');
const candidateGate = resolve('src/tems-merge-authority.mjs');
const gateDeclaration = /^const TEMS_AUTHORITY_GATE = .*;$/m;
assert.match(source, gateDeclaration, 'runner must declare a TEMS authority gate');
assert.match(source, /if \(repository === 'jgraham310\/tems'\) execFileSync\('node', \[TEMS_AUTHORITY_GATE, repository\]/,
  'runner must invoke the TEMS gate');

const head = '1234567890abcdef1234567890abcdef12345678';
const pr = 654;
const fixture = mkdtempSync(join(tmpdir(), 'tems-live-runner-'));
try {
  const runner = join(fixture, 'bin/pr-merge-runner.mjs');
  const shim = join(fixture, 'bin/authority-gate.mjs');
  const sourceCharter = join(fixture, 'source-charter.json');
  const deployedCharter = join(fixture, 'deployed-charter.json');
  const receipt = join(fixture, `evidence/pr-merge/jgraham310__tems/pr-${pr}/${head}.json`);
  mkdirSync(dirname(runner), { recursive: true });
  mkdirSync(join(fixture, 'policy'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(runner, source.replace(gateDeclaration, `const TEMS_AUTHORITY_GATE = ${JSON.stringify(shim)};`));
  writeFileSync(shim, `import { assertCurrentTemsMergeAuthority } from ${JSON.stringify(candidateGate)};
assertCurrentTemsMergeAuthority(process.argv[2], ${JSON.stringify(sourceCharter)}, ${JSON.stringify(deployedCharter)});
`);
  writeFileSync(join(fixture, 'policy/auto-merge-allowlist.json'), JSON.stringify({
    schema_version: 1,
    entries: [{ repository: 'jgraham310/tems', pr, head_sha: head,
      authorized_at: '2026-09-27T00:00:00Z', authorized_by: 'test fixture',
      reason: 'Exercise otherwise-authorized exact head without any merge.' }]
  }));
  const allowed = { agentId: 'tems-cto', mode: 'routine', repositories: ['jgraham310/tems'],
    autonomousOperations: ['merge_green_pr'], protocolRequired: ['merge_green_pr'],
    boundedAuthority: { merge: true, prohibitedOperations: [] } };
  const revoked = { ...allowed, boundedAuthority: { merge: false, prohibitedOperations: ['merge_green_pr'] } };
  for (const revokedPath of [sourceCharter, deployedCharter]) {
    writeFileSync(sourceCharter, JSON.stringify(revokedPath === sourceCharter ? revoked : allowed));
    writeFileSync(deployedCharter, JSON.stringify(revokedPath === deployedCharter ? revoked : allowed));
    const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
      '--pr', String(pr), '--head', head], { encoding: 'utf8' });
    assert.equal(result.status, 1, `revoked ${revokedPath} must deny`);
    assert.match(result.stderr, /TEMS autonomous merge is prohibited by bounded authority/);
    assert.doesNotMatch(result.stderr, /not explicitly authorized for auto-merge/);
    assert.equal(existsSync(receipt), false, 'denied merge must not write a decision receipt');
  }
  console.log('live portfolio merge runner source/deployed charter denial: passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
