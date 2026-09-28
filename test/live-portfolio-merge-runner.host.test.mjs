import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const liveRunner = resolve(homedir(), '.openclaw/workspace-cos/portfolio-control-pilot/bin/pr-merge-runner.mjs');
const pinnedRunner = resolve('test/fixtures/pr-merge-runner.mjs');
assert.ok(existsSync(liveRunner), `canonical host runner is required: ${liveRunner}`);
assert.ok(existsSync(pinnedRunner), 'pinned runner fixture is required');
assert.equal(readFileSync(liveRunner, 'utf8'), readFileSync(pinnedRunner, 'utf8'),
  'canonical host runner drifted from the pinned contract');
const unmodified = spawnSync(process.execPath, [liveRunner, '--repo', 'jgraham310/tems',
  '--pr', '0', '--head', '0000000000000000000000000000000000000000'], { encoding: 'utf8' });
assert.equal(unmodified.status, 1, 'unlisted synthetic PR must not merge');
assert.match(unmodified.stderr, /TEMS autonomous merge is prohibited by bounded authority|not explicitly authorized for auto-merge/,
  'unmodified runner must reach its live authority or allowlist gate');
const result = spawnSync(process.execPath, ['test/live-portfolio-merge-runner.test.mjs'], {
  env: { ...process.env, TEMS_RUNNER_SOURCE: liveRunner }, encoding: 'utf8'
});
assert.equal(result.status, 0, `canonical host runner behavioral gate failed:\n${result.stdout}${result.stderr}`);
process.stdout.write(result.stdout);
console.log('canonical host runner presence, parity, and behavior: passed');
