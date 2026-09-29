import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { observeCompletionLane, reconcileCompletionLanes } from "../integrations/openclaw/execution-harness/completion-watch.mjs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "live-idle-eval-"));
const socket = `coding-eval-${process.pid}`;
const at = "2026-09-29T17:00:00Z";
function tmux(...args) { return execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 5000 }); }
function launch(name, output) {
  const file = path.join(temp, `${name}.mjs`);
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(output)}); setInterval(() => {}, 1000);\n`);
  tmux("new-session", "-d", "-x", "160", "-y", "40", "-s", name, `${process.execPath} ${file}`);
}
function observe(lane) {
  return observeCompletionLane(lane, {
    capture: (name) => tmux("capture-pane", "-p", "-t", `=${name}:`, "-S", "-80"),
    listSessions: () => tmux("list-sessions", "-F", "#{session_name}"),
  });
}
const stopped = `Node.js v26.5.0\ncode: 'MODULE_NOT_FOUND'\n✻ Cooked for 15m 30s · done 2:58 PM\n────────────\n❯ Add the acceptance gate\n────────────\n[PONYTAIL]\n⏵⏵ auto mode on\n`;
const active = `Handled Error: expected fixture\n✻ Cooked for 15m 30s · done 2:58 PM\n❯ old prompt\n[Building current test…]\n`;
const lane = (id, issue, reviewRequired) => ({ id, issue, owner: "claude", sessionName: id,
  worktree: temp, completionPredicate: "exact-head review", deadlineAt: "2026-09-30T00:00:00Z",
  state: "executing", retry: { attempts: 0, maxAttempts: 1 }, reviewRequired,
  headSha: "a".repeat(40), nextAction: { argv: ["/bin/echo", "review"] },
  lastCommand: { status: "error", evidenceRef: `${id}-failure`, at } });

try {
  launch("civicline-eval", stopped); launch("tems-eval", stopped); launch("healthy-eval", active);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (tmux("capture-pane", "-p", "-t", "=tems-eval:").includes("auto mode on")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const civicline = lane("civicline-eval", 2712, true);
  const tems = lane("tems-eval", 566, false);
  tems.lastCommand.status = "rejected";
  assert.equal(observe(civicline).pane, "idle_prompt");
  assert.equal(observe(tems).pane, "idle_prompt");
  assert.equal(observe(lane("healthy-eval", 999, false)).pane, "executing");
  const state = { completionLanes: [civicline, tems] };
  let dispatches = 0;
  const options = { at, apply: true, observe, registrationLoader: () => null,
    authorizeDispatch: (_lane, reserve, launchAction) => { reserve(); return launchAction(); },
    dispatch: () => { dispatches++; return { pid: 999999 }; }, save: () => {} };
  const findings = reconcileCompletionLanes(state, options);
  assert.equal(findings.length, 2, "both real panes require a terminal decision in one pass");
  assert.equal(findings[0].kind, "completion_independent_review_action_unregistered");
  assert.equal(state.completionLanes[0].state, "blocked");
  assert.equal(findings[1].kind, "completion_command_rejected");
  assert.equal(dispatches, 1, "only the authorized TEMS action is dispatched once");
  reconcileCompletionLanes(state, { ...options, observe: (item) => ({ ...observe(item), lastCommand: item.lastCommand }) });
  assert.equal(dispatches, 1, "repeat observation must not duplicate launch");
  console.log("live idle-lane eval: 2/2 stopped panes detected; one authorized action, one typed hold, zero duplicates");
} finally {
  try { tmux("kill-server"); } catch { /* no surviving eval server */ }
  fs.rmSync(temp, { recursive: true, force: true });
}
