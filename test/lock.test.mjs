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
withLock(cwd, () => {
  assert.ok(fs.existsSync(lock));
  assert.throws(() => withLock(cwd, () => 'should never run'), /refusing to write concurrently/);
});
assert.ok(!fs.existsSync(lock), 'the lock is released on the way out');

// Released even when the critical section throws, or a crash wedges every later cycle.
assert.throws(() => withLock(cwd, () => { throw new Error('boom'); }), /boom/);
assert.ok(!fs.existsSync(lock), 'the lock is released when the body throws');

// A lock left behind by a killed process is broken once it is stale.
fs.writeFileSync(lock, '99999\n');
const stale = Date.now() - LOCK_STALE_MS - 1000;
fs.utimesSync(lock, stale / 1000, stale / 1000);
assert.equal(withLock(cwd, () => 'ran'), 'ran', 'a stale lock does not wedge the loop forever');

// State writes are atomic: no partial file is ever visible at the real path.
const statePath = path.join(cwd, 'ops', 'coding-control', 'state.json');
const before = fs.readFileSync(statePath, 'utf8');
JSON.parse(before);
execFileSync('node', [CLI, 'brief'], { cwd, encoding: 'utf8' });
assert.ok(JSON.parse(fs.readFileSync(statePath, 'utf8')).briefs.length === 1);
assert.deepEqual(fs.readdirSync(path.dirname(statePath)).filter((name) => name.endsWith('.tmp')), [], 'no temp files are left behind');

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
