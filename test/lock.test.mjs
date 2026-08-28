import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_STALE_MS, withLock } from '../src/control-plane.mjs';

const CLI = fileURLToPath(new URL('../src/control-plane.mjs', import.meta.url));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-control-lock-'));
execFileSync('node', [CLI, 'init'], { cwd, encoding: 'utf8' });
const lock = path.join(cwd, 'ops', 'coding-control', '.lock');

// One writer at a time.
await withLock(cwd, async () => {
  assert.ok(fs.existsSync(lock));
  await assert.rejects(() => withLock(cwd, () => 'should never run'), /refusing to write concurrently/);
});
assert.ok(!fs.existsSync(lock), 'the lock is released on the way out');

// Released even when the critical section throws, or a crash wedges every later cycle.
await assert.rejects(() => withLock(cwd, () => { throw new Error('boom'); }), /boom/);
assert.ok(!fs.existsSync(lock), 'the lock is released when the body throws');

// An async critical section must hold the lock until it actually finishes,
// not until it returns a promise.
let observedInside = false;
const slow = withLock(cwd, async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  observedInside = fs.existsSync(lock);
  return 'done';
});
await assert.rejects(() => withLock(cwd, () => 'should never run'), /refusing to write concurrently/, 'the lock is held across an await');
assert.equal(await slow, 'done');
assert.ok(observedInside, 'the lock still existed when the async body finished');
assert.ok(!fs.existsSync(lock));

// A lock left behind by a killed process is broken once it is stale.
fs.writeFileSync(lock, '99999\n');
const stale = Date.now() - LOCK_STALE_MS - 1000;
fs.utimesSync(lock, stale / 1000, stale / 1000);
assert.equal(await withLock(cwd, () => 'ran'), 'ran', 'a stale lock does not wedge the loop forever');

// State writes are atomic: no partial file is ever visible at the real path.
const statePath = path.join(cwd, 'ops', 'coding-control', 'state.json');
const before = fs.readFileSync(statePath, 'utf8');
JSON.parse(before);
execFileSync('node', [CLI, 'brief'], { cwd, encoding: 'utf8' });
assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).briefs.length === 1);
assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((name) => name.endsWith('.tmp')), [], 'no temp files are left behind');

// Every command must be able to load its adapter. Awaiting the dispatch at the
// top level used to deadlock the ones whose adapter imports the control plane
// back, so `sync` and `smoke` exited 13 without running at all.
for (const [command, expected] of [['sync', /no changes observed/], ['smoke', /nothing awaiting release/], ['patterns', /nothing recurring/]]) {
  const ran = spawnSync('node', [CLI, command], { cwd, encoding: 'utf8' });
  assert.equal(ran.status, 0, `${command} exited ${ran.status}: ${ran.stderr}`);
  assert.match(ran.stdout, expected);
}

// A command that throws reports the reason and fails the cycle, rather than
// surfacing as an unhandled rejection.
const failed = spawnSync('node', [CLI, 'route', 'nope', 'skill', 'jason', 'because'], { cwd, encoding: 'utf8' });
assert.equal(failed.status, 1);
assert.match(failed.stderr, /^Unknown work item: nope$/m);

fs.rmSync(cwd, { recursive: true, force: true });
console.log('lock tests: passed');

// --- delivery and scheduling are configured, not hand-waved ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-control-deliver-'));
execFileSync('node', [CLI, 'init'], { cwd: dir, encoding: 'utf8' });
const delivered = path.join(dir, 'delivered.md');
const target = path.join(dir, 'ops', 'coding-control', 'state.json');
const configured = JSON.parse(fs.readFileSync(target, 'utf8'));
configured.notify = `cat > ${delivered}`;
fs.writeFileSync(target, JSON.stringify(configured));
execFileSync('node', [CLI, 'brief'], { cwd: dir, encoding: 'utf8' });
assert.match(fs.readFileSync(delivered, 'utf8'), /# CTO brief/, 'the brief reaches the configured channel');

// A channel that is down must not silently swallow the report.
const broken = JSON.parse(fs.readFileSync(target, 'utf8'));
broken.notify = 'exit 7';
fs.writeFileSync(target, JSON.stringify(broken));
const result = spawnSync('node', [CLI, 'brief'], { cwd: dir, encoding: 'utf8' });
assert.equal(result.status, 1, 'a failed delivery is a failed cycle');
assert.match(result.stderr, /delivery failed/);
assert.match(result.stdout, /# CTO brief/, 'the brief is still written and printed');

const line = execFileSync(fileURLToPath(new URL('../scripts/schedule.sh', import.meta.url)), ['plan'], { encoding: 'utf8', env: { ...process.env, SCHEDULE: '*/30 * * * *', AGENT: 'my-agent' } }).trim();
assert.match(line, /^\*\/30 \* \* \* \* cd \S+ && my-agent >> \S+cycle\.log 2>&1 # coding-control-harness:/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('delivery and schedule tests: passed');
