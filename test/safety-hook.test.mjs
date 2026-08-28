import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { subjectFor } from '../hooks/safety-rules.mjs';

const HOOK = fileURLToPath(new URL('../hooks/safety-rules.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-control-hook-'));

const run = (payload, cwd = dir) => {
  const out = execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', cwd, env: { ...process.env, CODING_CONTROL_DIR: dir } });
  return out.trim() ? JSON.parse(out) : null;
};
const bash = (command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 's1' });

assert.equal(subjectFor('Bash', { command: 'rm -rf /' }), 'rm -rf /');
assert.equal(subjectFor('Write', { file_path: '/etc/hosts', content: 'x' }), '/etc/hosts');
assert.equal(subjectFor('WebFetch', { url: 'https://example.com' }), 'https://example.com');
assert.equal(subjectFor('Unknown', { a: 1 }), '{"a":1}');

// No state file: nothing is configured here, so the hook stays out of the way.
assert.equal(run(bash('git status')), null);

const write = (state) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
write({
  schema: 'coding_control_state/v1', workItems: [], safetyRules: [
    { id: 'no-force-push', tool: 'Bash', commandPattern: 'git push .*--force', reason: 'Force pushes require explicit review.' },
    { id: 'no-prod-writes', tool: 'Write', commandPattern: '^/etc/', reason: 'Production config is not agent-writable.' },
    { id: 'retired', tool: 'Bash', commandPattern: 'ls', reason: 'Disabled rule must not fire.', enabled: false },
  ],
});

assert.equal(run(bash('git status')), null, 'unmatched commands pass through untouched');
assert.equal(run(bash('ls -la')), null, 'disabled rules do not fire');

const denied = run(bash('git push --force origin main'));
assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
assert.match(denied.hookSpecificOutput.permissionDecisionReason, /no-force-push: Force pushes require explicit review\./);
assert.ok(!JSON.stringify(denied).includes('allow'), 'the hook never returns an allow decision');

const path_denied = run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/etc/hosts', content: 'x' }, cwd: dir });
assert.match(path_denied.hookSpecificOutput.permissionDecisionReason, /no-prod-writes/);

// The denial is durable, so the next brief can surface it.
const denials = fs.readFileSync(path.join(dir, 'denials.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
assert.equal(denials.length, 2);
assert.deepEqual(denials.map((entry) => entry.ruleId), ['no-force-push', 'no-prod-writes']);
assert.equal(denials[0].subject, 'git push --force origin main');

// Fail closed: a corrupt rule file must not silently disable the rails.
fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
assert.match(run(bash('git status')).hookSpecificOutput.permissionDecisionReason, /unreadable.*refusing to run unguarded/);
write({ schema: 'coding_control_state/v1', workItems: [], safetyRules: [{ id: 'bad', commandPattern: '([', reason: 'x' }] });
assert.match(run(bash('git status')).hookSpecificOutput.permissionDecisionReason, /failed to evaluate.*refusing to run unguarded/);

fs.rmSync(dir, { recursive: true, force: true });
console.log('safety hook tests: passed');
