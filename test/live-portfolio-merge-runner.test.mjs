import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(homedir(), '.openclaw/workspace-cos/portfolio-control-pilot');
const runner = resolve(root, 'bin/pr-merge-runner.mjs');
const head = '0000000000000000000000000000000000000000';
const receipt = resolve(root, `evidence/pr-merge/jgraham310__tems/pr-0/${head}.json`);

if (existsSync(runner)) {
  const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems', '--pr', '0', '--head', head], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bounded authority|not explicitly authorized for auto-merge/);
  assert.equal(existsSync(receipt), false, 'denied merge must not write a decision receipt');
  console.log('live portfolio merge runner TEMS unauthorized-head denial: passed');
} else {
  console.log('live portfolio merge runner unavailable; module denial tested separately');
}
