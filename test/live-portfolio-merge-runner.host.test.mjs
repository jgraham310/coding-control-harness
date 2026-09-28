import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const liveRunner = resolve(homedir(), '.openclaw/workspace-cos/portfolio-control-pilot/bin/pr-merge-runner.mjs');
const pinnedRunner = fileURLToPath(new URL('./fixtures/pr-merge-runner.mjs', import.meta.url));
const liveGate = resolve(homedir(), '.openclaw/repos/coding-control-harness/src/tems-merge-authority.mjs');
const candidateGate = fileURLToPath(new URL('../src/tems-merge-authority.mjs', import.meta.url));
assert.ok(existsSync(liveRunner), `canonical host runner is required: ${liveRunner}`);
assert.ok(existsSync(pinnedRunner), 'pinned runner fixture is required');
assert.ok(existsSync(liveGate), `installed TEMS authority gate is required: ${liveGate}`);
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(digest(liveRunner), digest(pinnedRunner),
  'canonical host runner drifted from the pinned contract');
assert.equal(digest(liveGate), digest(candidateGate),
  'installed TEMS authority gate has not integrated the exact candidate');
const unmodified = spawnSync(process.execPath, [liveRunner, '--repo', 'jgraham310/tems',
  '--pr', '0', '--head', '0000000000000000000000000000000000000000'], { encoding: 'utf8' });
assert.equal(unmodified.status, 1, 'unlisted synthetic PR must not merge');
assert.match(unmodified.stderr, /TEMS autonomous merge is prohibited by bounded authority|current exact-head TEMS merge protocol evidence is missing or stale|not explicitly authorized for auto-merge/,
  'unmodified runner must reach its live authority or allowlist gate');
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./live-portfolio-merge-runner.test.mjs', import.meta.url))], {
  env: { ...process.env, TEMS_RUNNER_SOURCE: liveRunner }, encoding: 'utf8'
});
assert.equal(result.status, 0, `canonical host runner behavioral gate failed:\n${result.stdout}${result.stderr}`);
process.stdout.write(result.stdout);
console.log('canonical host runner presence, parity, and behavior: passed');
