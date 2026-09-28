import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const receiptPath = 'test/fixtures/tems-host-integration-receipt.json';
const inputs = [
  'package.json',
  'src/coding-kernel.mjs',
  'src/tems-merge-authority.mjs',
  'test/coding-kernel.test.mjs',
  'test/tems-merge-authority.test.mjs',
  'test/live-portfolio-merge-runner.test.mjs',
  'test/live-portfolio-merge-runner.host.test.mjs',
  'test/fixtures/pr-merge-runner.mjs',
  'scripts/publish-tems-host-status.py'
];
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes = () => Object.fromEntries(inputs.map((path) => [path, digest(path)]));

if (process.argv[2] === 'record') {
  const result = spawnSync(process.execPath, ['test/live-portfolio-merge-runner.test.mjs'], { encoding: 'utf8' });
  assert.equal(result.status, 0, `candidate runner contract failed:\n${result.stdout}${result.stderr}`);
  writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, gate: 'candidate-runner-contract-only', observedAt: new Date().toISOString(), hashes: hashes() }, null, 2)}\n`);
  process.stdout.write(result.stdout);
} else if (process.argv[2] === 'verify') {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.gate, 'candidate-runner-contract-only');
  assert.deepEqual(receipt.hashes, hashes(), 'candidate contract proof is stale');
  assert.ok(Number.isFinite(Date.parse(receipt.observedAt)), 'candidate observation timestamp is required');
  console.log('content-bound candidate runner contract receipt: passed (live host status separate)');
} else {
  throw new Error('usage: node test/host-integration-receipt.mjs record|verify');
}
