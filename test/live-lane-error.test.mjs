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
const pipeMarker = path.join(root, 'pipe-active');
fs.writeFileSync(paneFile, "Error: Cannot find module '/deleted/hook.js'\n");
const tmux = path.join(fakeBin, 'tmux');
fs.writeFileSync(tmux, `#!/bin/sh
case "$1" in
  has-session) exit 0 ;;
  display-message) if [ "$5" = '#{pane_pipe}' ]; then if [ -f "$TEST_PIPE_MARKER.$4" ]; then echo 1; else echo 0; fi; else printf '%s\\n' "$TEST_WORKTREE"; fi ;;
  capture-pane) cat "$TEST_PANE_FILE" ;;
  pipe-pane) previous=''; target=''; for part in "$@"; do if [ "$previous" = '-t' ]; then target="$part"; fi; previous="$part"; done; if [ "$2" = '-t' ]; then rm -f "$TEST_PIPE_MARKER.$target"; else touch "$TEST_PIPE_MARKER.$target"; if [ "$target" = "$TEST_INJECT_ON_PIPE" ]; then printf 'Error: Cannot find module /race/hook.js\\n' >> "$TEST_PANE_FILE"; fi; fi ;;
  list-sessions) exit 0 ;;
esac
`);
fs.chmodSync(tmux, 0o755);
const gh = path.join(fakeBin, 'gh');
const uatMarkers = ['## Engineering Acceptance Contract', '## Machine-Executable UAT', '### Issue-derived user role', '### Synthetic test data and starting state', '### Steps', '### Expected outcomes', '### Forbidden outcomes', '### Correctness and compliance checks', '### Evidence to capture', 'issue-566-acceptance'];
fs.writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ state: 'OPEN', body: uatMarkers.join('\n') })}'\n`);
fs.chmodSync(gh, 0o755);
const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../integrations/openclaw/execution-harness/harness.mjs');
const streamFilter = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/pane-error-stream.mjs');
assert.equal(execFileSync('node', [streamFilter], { input: "secret=not-an-error\nError: Cannot find module '/deleted/hook.js'\n", encoding: 'utf8' }), 'hook_module_not_found\n', 'stream retains only bounded error markers');
assert.equal(execFileSync('node', [streamFilter], { input: "A prior Error: Cannot find module is only prose\n\x1b[31mError: Cannot find module '/deleted/hook.js'\x1b[0m\nold prompt\r\x1b[2KError: Cannot find module '/deleted/hook.js'\n", encoding: 'utf8' }), 'hook_module_not_found\nhook_module_not_found\n', 'colored and cursor-repainted terminal errors become bounded markers without accepting prose');
assert.equal(execFileSync('node', [streamFilter], { input: "old prompt\x1b[1E\x1b[2KError: Cannot find module '/deleted/hook.js'", encoding: 'utf8' }), 'hook_module_not_found\n', 'CSI next-line moves create a visual boundary without a newline');
assert.equal(execFileSync('node', [streamFilter], { input: "old prompt\x9b1E\x9b2KError: Cannot find module '/deleted/hook.js'", encoding: 'utf8' }), 'hook_module_not_found\n', 'eight-bit CSI next-line moves create the same boundary');
assert.equal(execFileSync('node', [streamFilter], { input: Buffer.concat([Buffer.from('old prompt'), Buffer.from([0x9b]), Buffer.from("1EError: Cannot find module '/deleted/hook.js'")]), encoding: 'utf8' }), 'hook_module_not_found\n', 'raw 8-bit CSI bytes survive terminal parsing');
assert.equal(execFileSync('node', [streamFilter], { input: "Error: Cannot find module first\x1b[1EError: Cannot find module second", encoding: 'utf8' }), 'hook_module_not_found\nhook_module_not_found\n', 'CSI visual boundaries reset marker deduplication without CR or LF');
assert.equal(execFileSync('node', [streamFilter], { input: "old prompt\rError: Cannot find module '/deleted/hook.js'", encoding: 'utf8' }), 'hook_module_not_found\n', 'CR-only repaint is detected before a newline');
assert.equal(execFileSync('node', [streamFilter], { input: 'Error: Cannot find module x\bX', encoding: 'utf8' }), 'hook_module_not_found\n', 'backspace repaint stays deduplicated within one visual segment');
assert.equal(execFileSync('node', [streamFilter], { input: 'Error: Cannot find module\b\ble', encoding: 'utf8' }), 'hook_module_not_found\n', 'backspacing through the match does not emit a second same-line marker');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[0KError: Cannot find module x', encoding: 'utf8' }), '', 'erase-to-end does not remove a visible prefix');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[1KError: Cannot find module x', encoding: 'utf8' }), 'hook_module_not_found\n', 'erase-to-beginning removes the visible prefix');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[2KError: Cannot find module x', encoding: 'utf8' }), 'hook_module_not_found\n', 'erase-entire-line clears the visual prefix');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[5GError: Cannot find module x', encoding: 'utf8' }), '', 'column-five movement leaves a visible prefix');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[1;5HError: Cannot find module x', encoding: 'utf8' }), '', 'same-row column-five movement leaves a visible prefix');
assert.equal(execFileSync('node', [streamFilter], { input: 'old prompt\x1b[2;5HError: Cannot find module x', encoding: 'utf8' }), 'hook_module_not_found\n', 'moving to a different visual row starts fresh classification');
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
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, TEST_WORKTREE: root, TEST_PANE_FILE: paneFile, TEST_PIPE_MARKER: pipeMarker };
const write = (value) => fs.writeFileSync(stateFile, JSON.stringify(value));
const run = (at) => JSON.parse(execFileSync('node', [harness, 'watch', '--apply', '--auto-recover', '--state', stateFile, '--skip-github', '--skip-staging', '--at', at], { encoding: 'utf8', env, cwd: root }));
const command = (...args) => JSON.parse(execFileSync('node', [harness, ...args, '--state', path.relative(root, stateFile), '--at', '2026-09-28T19:12:00Z'], { encoding: 'utf8', env, cwd: root }));
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

  fs.renameSync(paneFile, `${paneFile}.unavailable`);
  assert.throws(() => command('transition', '--issue', '566', '--to', 'implementing', '--evidence', 'Attempted rearm without pane capture.'), /Command failed/, 'rearm fails closed if the pane cannot be baselined');
  fs.renameSync(`${paneFile}.unavailable`, paneFile);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).lanes[0].dispatch.errorHold !== null, true);

  command('transition', '--issue', '566', '--to', 'implementing', '--evidence', 'Operator repaired the hook and explicitly rearmed the same pane.', '--heartbeat-due', '2099-01-01T00:00:00Z');
  stored = JSON.parse(fs.readFileSync(stateFile));
  const streamFile = stored.lanes[0].dispatch.paneStream.path;
  assert.equal(fs.existsSync(streamFile), true);
  assert.equal(run('2026-09-28T19:12:01Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'old scrollback must not retrigger after rearm');
  fs.appendFileSync(paneFile, 'Execution continuing normally\n');
  fs.appendFileSync(streamFile, 'Execution continuing normally\n');
  assert.equal(run('2026-09-28T19:12:02Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'new healthy output does not revive historical error');
  fs.writeFileSync(paneFile, "Error: Cannot find module '/deleted/hook.js'\nExecution continuing normally (repainted)\n");
  assert.equal(run('2026-09-28T19:12:02Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'prompt repaint does not revive historical error');
  fs.appendFileSync(paneFile, "Error: Cannot find module '/deleted/hook.js'\n");
  fs.appendFileSync(streamFile, 'hook_module_not_found\n');
  assert.equal(run('2026-09-28T19:12:03Z').findings.some((entry) => entry.kind === 'development_lane_error'), true, 'a fresh identical error still holds the lane');
  stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(stored.events.filter((entry) => entry.kind === 'development_lane_error').length, 2);

  command('attach-development', '--issue', '566', '--tmux-session', 'fake', '--tmux-pane', 'fake:0.0', '--evidence', 'Operator reattached the repaired pane.', '--heartbeat-due', '2099-01-01T00:00:00Z');
  assert.equal(run('2026-09-28T19:12:04Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'reattach acknowledges existing scrollback');
  fs.appendFileSync(streamFile, 'hook_module_not_found\n');
  assert.equal(run('2026-09-28T19:12:05Z').findings.some((entry) => entry.kind === 'development_lane_error'), true, 'stream detects a fresh identical error even when bounded pane capture is unchanged');
  fs.renameSync(paneFile, `${paneFile}.unavailable`);
  assert.throws(() => command('attach-development', '--issue', '566', '--tmux-session', 'fake', '--tmux-pane', 'fake:0.0', '--evidence', 'Attempted reattach without capture.', '--heartbeat-due', '2099-01-01T00:00:00Z'), /Command failed/, 'reattach also fails closed without pane capture');
  fs.renameSync(`${paneFile}.unavailable`, paneFile);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).lanes[0].dispatch.errorHold !== null, true);
  command('attach-development', '--issue', '566', '--tmux-session', 'fake', '--tmux-pane', 'fake:1.0', '--evidence', 'Operator moved the sole lane to a new pane.', '--heartbeat-due', '2099-01-01T00:00:00Z');
  stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(stored.lanes[0].dispatch.paneStream.pane, 'fake:1.0');
  assert.notEqual(stored.lanes[0].dispatch.paneStream.path, streamFile);
  assert.equal(fs.existsSync(`${pipeMarker}.fake:0.0`), false, 'old pane pipe is closed on switch');
  assert.equal(fs.existsSync(`${pipeMarker}.fake:1.0`), true, 'new pane pipe is active');
  assert.equal(run('2026-09-28T19:12:06Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'new pane does not inherit stale output monitor');
  fs.appendFileSync(stored.lanes[0].dispatch.paneStream.path, 'hook_module_not_found\n');
  assert.equal(run('2026-09-28T19:12:07Z').findings.some((entry) => entry.kind === 'development_lane_error'), true, 'fresh new-pane error still holds');

  write({ ...fixture, lanes: [{ ...lane, phase: 'identified', dispatch: { ...lane.dispatch, status: 'ready' } }] });
  command('attach-development', '--issue', '566', '--tmux-session', 'fake', '--tmux-pane', 'fake:2.0', '--evidence', 'First attachment of the executor.', '--heartbeat-due', '2099-01-01T00:00:00Z');
  stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(stored.lanes[0].phase, 'stalled', 'first attachment holds an error already visible in the pane');
  assert.equal(stored.lanes[0].dispatch.paneStream.pane, 'fake:2.0', 'first attachment starts a fresh-output monitor');
  assert.equal(stored.events.filter((entry) => entry.kind === 'development_lane_error').length, 1);
  assert.equal(run('2026-09-28T19:12:08Z').findings.some((entry) => entry.kind === 'development_lane_error'), false, 'first-attach hold is durable across repeat watch');
  fs.writeFileSync(paneFile, 'healthy pane before monitor installation\n');
  env.TEST_INJECT_ON_PIPE = 'fake:3.0';
  write({ ...fixture, lanes: [{ ...lane, phase: 'identified', dispatch: { ...lane.dispatch, status: 'ready' } }] });
  command('attach-development', '--issue', '566', '--tmux-session', 'fake', '--tmux-pane', 'fake:3.0', '--evidence', 'First attachment while executor emits an error.', '--heartbeat-due', '2099-01-01T00:00:00Z');
  delete env.TEST_INJECT_ON_PIPE;
  stored = JSON.parse(fs.readFileSync(stateFile));
  assert.equal(stored.lanes[0].phase, 'stalled', 'error between pipe installation and final capture is held');
  assert.equal(stored.events.filter((entry) => entry.kind === 'development_lane_error').length, 1);

  write({ ...fixture, lanes: [{ ...lane, blocker: 'approval required' }] });
  assert.equal(run('2026-09-28T19:12:00Z').findings.some((entry) => entry.kind === 'development_lane_error'), false);
  fs.writeFileSync(paneFile, 'Execution continuing normally\n');
  write(fixture);
  assert.equal(run('2026-09-28T19:13:00Z').findings.some((entry) => entry.kind === 'development_lane_error'), false);
  console.log('live lane error tests: passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
