import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pinnedRunner = fileURLToPath(new URL('./fixtures/pr-merge-runner.mjs', import.meta.url));
assert.ok(existsSync(pinnedRunner), 'portfolio merge runner fixture is required');
const runnerSource = process.env.TEMS_RUNNER_SOURCE ? resolve(process.env.TEMS_RUNNER_SOURCE) : pinnedRunner;
assert.ok(existsSync(runnerSource), `runner source is required: ${runnerSource}`);
const source = readFileSync(runnerSource, 'utf8');
const candidateGate = fileURLToPath(new URL('../src/tems-merge-authority.mjs', import.meta.url));
const gateDeclaration = /^const TEMS_AUTHORITY_GATE = .*;$/m;
const parityDeclaration = /^const TEMS_HOST_PARITY_TEST = .*;$/m;
assert.match(source, gateDeclaration, 'runner must declare a TEMS authority gate');
assert.match(source, parityDeclaration, 'runner must declare a live TEMS host parity test');
assert.match(source, /\[TEMS_AUTHORITY_GATE, repository, pr, head, protocol\]/,
  'runner must pass exact PR, head, and protocol receipt to TEMS gate');

const head = '1234567890abcdef1234567890abcdef12345678';
const pr = 654;
const fixture = mkdtempSync(join(tmpdir(), 'tems-live-runner-'));
try {
  const runner = join(fixture, 'bin/pr-merge-runner.mjs');
  const shim = join(fixture, 'bin/authority-gate.mjs');
  const parity = join(fixture, 'bin/host-parity.mjs');
  const parityMarker = join(fixture, 'parity-ran');
  const sourceCharter = join(fixture, 'source-charter.json');
  const deployedCharter = join(fixture, 'deployed-charter.json');
  const receipt = join(fixture, `evidence/pr-merge/jgraham310__tems/pr-${pr}/${head}.json`);
  mkdirSync(dirname(runner), { recursive: true });
  mkdirSync(join(fixture, 'policy'), { recursive: true });
  writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
  writeFileSync(runner, source.replace(gateDeclaration, `const TEMS_AUTHORITY_GATE = ${JSON.stringify(shim)};`)
    .replace(parityDeclaration, `const TEMS_HOST_PARITY_TEST = ${JSON.stringify(parity)};`));
  writeFileSync(shim, `import { assertCurrentTemsMergeAuthority } from ${JSON.stringify(candidateGate)};
assertCurrentTemsMergeAuthority(process.argv[2], ${JSON.stringify(sourceCharter)}, ${JSON.stringify(deployedCharter)}, process.argv[3], process.argv[4], process.argv[5]);
`);
  writeFileSync(join(fixture, 'policy/auto-merge-allowlist.json'), JSON.stringify({
    schema_version: 1,
    entries: [{ repository: 'jgraham310/tems', pr, head_sha: head,
      authorized_at: '2026-09-27T00:00:00Z', authorized_by: 'test fixture',
      reason: 'Exercise otherwise-authorized exact head without any merge.' }]
  }));
  const allowed = { agentId: 'tems-cto', mode: 'routine', repositories: ['jgraham310/tems'],
    autonomousOperations: ['merge_green_pr'], protocolRequired: ['merge_green_pr'],
    productionAuthority: false, boundedAuthority: { merge: true, production: false, prohibitedOperations: [] } };
  const revoked = { ...allowed, boundedAuthority: { merge: false, production: false, prohibitedOperations: ['merge_green_pr'] } };
  for (const revokedPath of [sourceCharter, deployedCharter]) {
    writeFileSync(sourceCharter, JSON.stringify(revokedPath === sourceCharter ? revoked : allowed));
    writeFileSync(deployedCharter, JSON.stringify(revokedPath === deployedCharter ? revoked : allowed));
    const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
      '--pr', String(pr), '--head', head], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 1, `revoked ${revokedPath} must deny`);
    assert.match(result.stderr, /TEMS autonomous merge is prohibited by bounded authority/);
    assert.doesNotMatch(result.stderr, /not explicitly authorized for auto-merge/);
    assert.equal(existsSync(receipt), false, 'denied merge must not write a decision receipt');
  }
  writeFileSync(sourceCharter, JSON.stringify(allowed));
  writeFileSync(deployedCharter, JSON.stringify(allowed));
  const denied = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
    '--pr', String(pr), '--head', head], { cwd: fixture, encoding: 'utf8' });
  assert.equal(denied.status, 1, 'missing exact-head protocol proof must deny');
  assert.equal(existsSync(receipt), false, 'protocol denial must not write merge decision');
  // Isolate the subsequent host-status gate after the authority gate has been tested above.
  writeFileSync(shim, '');
  const review = join(fixture, `evidence/codex-review/jgraham310__tems/pr-${pr}/${head}.json`);
  mkdirSync(dirname(review), { recursive: true });
  writeFileSync(review, JSON.stringify({ repository: 'jgraham310/tems', pr, head_sha: head,
    outcome: 'clean', reviewed_at: new Date().toISOString() }));
  const bin = join(fixture, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const head = process.env.TEMS_TEST_HEAD;
if (process.argv[2] === 'pr') {
  const checks = process.env.TEMS_TEST_CHECKS;
  const review = { context: 'portfolio/review-clear', state: checks === 'failed-clear' ? 'FAILURE' : 'SUCCESS' };
  const rollup = checks === 'empty' ? [] : [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ...(checks === 'missing-clear' ? [] : [review])];
  process.stdout.write(JSON.stringify({ headRefOid: head, isDraft: false, mergeStateStatus: 'CLEAN',
    ...(checks === 'missing' ? {} : { statusCheckRollup: rollup }) }));
} else {
  const mode = process.env.TEMS_TEST_HOST_STATUS;
  const checks = process.env.TEMS_TEST_CHECKS;
  const hostAt = mode === 'stale' ? new Date(Date.now() - 3600000).toISOString() : new Date().toISOString();
  const reviewAt = checks === 'stale-clear' ? new Date(0).toISOString() : new Date().toISOString();
  process.stdout.write(JSON.stringify({ sha: mode === 'wrong-head' || checks === 'wrong-head-clear' ? '0'.repeat(40) : head,
    statuses: [
      ...(checks === 'absent-clear' ? [] : [{ context: 'portfolio/review-clear',
        state: checks === 'failed-clear-status' ? 'failure' : 'success', created_at: reviewAt }]),
      ...(mode === 'absent' ? [] : [{ context: 'tems/canonical-host-integration',
        state: mode === 'failure' ? 'failure' : 'success', created_at: hostAt }]) ] }));
}
`, { mode: 0o755 });
  for (const checks of ['missing', 'empty', 'missing-clear', 'failed-clear', 'absent-clear',
    'failed-clear-status', 'stale-clear', 'wrong-head-clear']) {
    const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
      '--pr', String(pr), '--head', head], { cwd: fixture, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEMS_TEST_HEAD: head,
        TEMS_TEST_HOST_STATUS: 'success', TEMS_TEST_CHECKS: checks } });
    assert.equal(result.status, 1, `${checks} must deny`);
    assert.match(result.stderr, /checks are missing or empty|portfolio\/review-clear|non-success checks/);
    assert.equal(existsSync(receipt), false, `${checks} denial must not write merge decision`);
  }
  for (const mode of ['absent', 'failure', 'stale', 'wrong-head']) {
    const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
      '--pr', String(pr), '--head', head], { cwd: fixture, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEMS_TEST_HEAD: head, TEMS_TEST_HOST_STATUS: mode } });
    assert.equal(result.status, 1, `${mode} canonical-host status must deny`);
    assert.match(result.stderr, mode === 'wrong-head'
      ? /exact-head portfolio\/review-clear status|canonical-host integration status/
      : /canonical-host integration status/);
    assert.equal(existsSync(receipt), false, `${mode} denial must not write a merge decision`);
  }
  writeFileSync(parity, `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(parityMarker)}, 'ran');
if (process.env.TEMS_TEST_PARITY === 'drift') process.exit(1);
`);
  for (const mode of ['drift', 'match']) {
    const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems',
      '--pr', String(pr), '--head', head], { cwd: fixture, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEMS_TEST_HEAD: head,
        TEMS_TEST_HOST_STATUS: 'success', TEMS_TEST_PARITY: mode } });
    assert.equal(result.status, 1, `${mode} parity fixture must stop before merge`);
    assert.equal(existsSync(parityMarker), true, 'live parity gate must run at the exact head');
    assert.equal(existsSync(receipt), false, 'no decision receipt before live parity and review-thread clearance');
    if (mode === 'drift') assert.match(result.stderr, /host-parity\.mjs/);
    else assert.doesNotMatch(result.stderr, /host-parity\.mjs/);
    rmSync(parityMarker);
  }
  console.log('live portfolio merge runner source/deployed charter denial: passed');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
