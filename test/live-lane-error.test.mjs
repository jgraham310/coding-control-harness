import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'live-lane-error-')));
const stateFile = path.join(root, 'state.json');
const fakeBin = path.join(root, 'bin');
fs.mkdirSync(fakeBin);
const paneFile = path.join(root, 'pane.txt');
fs.writeFileSync(paneFile, "Error: Cannot find module '/deleted/hook.js'\n");
const tmux = path.join(fakeBin, 'tmux');
fs.writeFileSync(tmux, `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  display-message) printf '%s\\n' "$TEST_WORKTREE" ;;
  capture-pane) cat "$TEST_PANE_FILE" ;;
  list-sessions) exit 0 ;;
esac
`);
fs.chmodSync(tmux, 0o755);
const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../integrations/openclaw/execution-harness/harness.mjs');
const lane = {
  id: 'tems-566', issue: 566, repository: 'jgraham310/tems', phase: 'implementing', active: true,
  adapter: 'development', owner: 'Claude Code', worktree: root, successPredicate: 'synthetic evidence',
  nextAction: 'Preserve candidate and await review.', heartbeatDueAt: '2099-01-01T00:00:00Z',
  nextActionDueAt: '2099-01-01T00:00:00Z', blocker: null, lastEvidence: { at: '2026-09-28T19:00:00Z', detail: 'synthetic candidate' },
  dispatch: { status: 'attached', autoRecover: true, session: 'fake', pane: 'fake:0.0', worktree: root },
  review: { status: 'unreviewed', head: null, evidence: null, dueAt: null, updatedAt: null },
  verifications: [],
};
const fixture = { schemaVersion: 2, portfolio: { repositories: [{ id: 'tems', repository: 'jgraham310/tems' }] }, events: [], lanes: [lane] };
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, TEST_WORKTREE: root, TEST_PANE_FILE: paneFile };
const write = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
const run = (at) => JSON.parse(execFileSync('node', [harness, 'watch', '--apply', '--auto-recover', '--state', stateFile, '--skip-github', '--skip-staging', '--at', at], { encoding: 'utf8', env, cwd: root }));
try {
  write(fixture);
  const first = run('2026-09-28T19:10:00Z');
  assert.equal(first.findings.some((entry) => entry.kind === 'development_lane_error'), true);
  let stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(stored.lanes[0].phase, 'stalled');
  assert.match(stored.lanes[0].blocker, /^development_lane_error:/);
  assert.equal(stored.lanes[0].dispatch.status, 'attached');
  assert.equal(stored.lanes[0].dispatch.recoveryCount, undefined);
  assert.equal(stored.lanes[0].heartbeatDueAt, null);
  assert.equal(stored.events.filter((entry) => entry.kind === 'development_lane_error').length, 1);
  const again = run('2026-09-28T19:11:00Z');
  stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(again.findings.some((entry) => entry.kind === 'development_lane_error'), false);
  assert.equal(stored.events.filter((entry) => entry.kind === 'development_lane_error').length, 1);
  assert.equal(stored.lanes.length, 1);
  assert.equal(stored.lanes[0].dispatch.recoveryCount, undefined);

  write({ ...fixture, lanes: [{ ...lane, blocker: 'approval required' }] });
  assert.equal(run('2026-09-28T19:12:00Z').findings.some((entry) => entry.kind === 'development_lane_error'), false);
  fs.writeFileSync(paneFile, 'Execution continuing normally\n');
  write(fixture);
  assert.equal(run('2026-09-28T19:13:00Z').findings.some((entry) => entry.kind === 'development_lane_error'), false);
  console.log('live lane error tests: passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
