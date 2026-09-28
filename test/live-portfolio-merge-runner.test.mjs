import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(homedir(), '.openclaw/workspace-cos/portfolio-control-pilot');
const runner = resolve(root, 'bin/pr-merge-runner.mjs');
const head = 'cd9b2661af84cbfd58f39907cc6a42e38934106a';
const receipt = resolve(root, `evidence/pr-merge/jgraham310__tems/pr-654/${head}.json`);

if (existsSync(runner)) {
  const result = spawnSync(process.execPath, [runner, '--repo', 'jgraham310/tems', '--pr', '654', '--head', head], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEMS autonomous merge is prohibited by bounded authority/);
  assert.equal(existsSync(receipt), false, 'denied merge must not write a decision receipt');
  console.log('live portfolio merge runner TEMS denial: passed');
} else {
  console.log('live portfolio merge runner unavailable; module denial tested separately');
}
