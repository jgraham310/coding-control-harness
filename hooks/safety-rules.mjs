#!/usr/bin/env node
/**
 * PreToolUse hook. Evaluates the user-authored safety rules in state.json
 * against the tool call the agent is about to make, and denies with the
 * recorded reason.
 *
 * This is the enforcement point the control plane otherwise lacks: the agent
 * cannot decline to call it. It only ever denies or stays silent — it never
 * returns "allow", because that would suppress the permission prompts the user
 * configured for themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateSafetyRules } from '../src/control-plane.mjs';

// One string per tool for commandPattern to match against, so a rule can guard
// a path or a URL as easily as a shell command.
// ponytail: known keys plus a JSON fallback; add a key when a tool's payload
// stops matching a pattern you wrote.
const SUBJECT_KEYS = {
  Bash: 'command', BashOutput: 'command',
  Edit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path', Read: 'file_path',
  WebFetch: 'url', WebSearch: 'query',
};

export function subjectFor(toolName, toolInput = {}) {
  const value = toolInput[SUBJECT_KEYS[toolName]];
  return typeof value === 'string' ? value : JSON.stringify(toolInput ?? {});
}

function deny(reason, ruleId) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ruleId ? `Safety rule ${ruleId}: ${reason}` : reason,
    },
  })}\n`);
  process.exit(0);
}

function recordDenial(dir, entry) {
  try {
    fs.appendFileSync(path.join(dir, 'denials.jsonl'), `${JSON.stringify(entry)}\n`);
  } catch { /* a denial must still land even if the log cannot be written */ }
}

export function decide(payload, cwd) {
  const dir = process.env.CODING_CONTROL_DIR || path.join(cwd, 'ops', 'coding-control');
  const statePath = path.join(dir, 'state.json');
  // No state file means no rules were configured here, not that rules failed.
  if (!fs.existsSync(statePath)) return { allowed: true };

  let rules;
  try {
    rules = JSON.parse(fs.readFileSync(statePath, 'utf8')).safetyRules || [];
  } catch (error) {
    return { allowed: false, reason: `safety rules are unreadable (${error.message}); refusing to run unguarded.` };
  }

  const action = { tool: payload.tool_name, command: subjectFor(payload.tool_name, payload.tool_input) };
  let verdict;
  try {
    verdict = evaluateSafetyRules(rules, action);
  } catch (error) {
    return { allowed: false, reason: `a safety rule failed to evaluate (${error.message}); refusing to run unguarded.` };
  }
  if (verdict.allowed) return verdict;

  recordDenial(dir, {
    at: new Date().toISOString(), ruleId: verdict.ruleId, reason: verdict.reason,
    tool: action.tool, subject: action.command.slice(0, 500), sessionId: payload.session_id,
  });
  return verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    deny('the hook received unparseable input; refusing to run unguarded.');
  }
  const verdict = decide(payload, payload.cwd || process.cwd());
  // Silence is the only "allow". Returning permissionDecision:"allow" here
  // would skip the user's own permission prompts for every tool call.
  if (!verdict.allowed) deny(verdict.reason, verdict.ruleId);
  process.exit(0);
}
