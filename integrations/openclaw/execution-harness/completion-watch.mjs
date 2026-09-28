/** Live bounded completion-lane recovery. Caller holds the execution-state lock. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyDecision, completionReceipt, reconcileLane, validateLane } from "../../../src/completion-controller.mjs";
import { loadReviewRegistration } from "../../../src/review-registration.mjs";

export function observeCompletionLane(lane, { capture = (name) => execFileSync("tmux", ["capture-pane", "-p", "-t", `=${name}`, "-S", "-80"], { encoding: "utf8", timeout: 5000 }) } = {}) {
  let pane = "executing";
  let error = null;
  try {
    const output = capture(lane.sessionName);
    const last = output.trimEnd().split("\n").slice(-12);
    if (last.some((line) => /(?:^|\s)(?:MODULE_NOT_FOUND|command not found|Permission denied|Error:)/.test(line))) error = last.filter((line) => /(?:^|\s)(?:MODULE_NOT_FOUND|command not found|Permission denied|Error:)/.test(line)).at(-1);
    else if (/^(?:\$|%|>)\s*$/.test(last.at(-1) ?? "")) pane = "idle_prompt";
  } catch { pane = "exited"; }
  return { pane, error, lastCommand: lane.lastCommand ?? null, completedEvidence: lane.completedEvidence === true, blockedReason: lane.blockedReason ?? null };
}

export function reconcileCompletionLanes(state, { at, apply, save, observe = observeCompletionLane, registrationLoader = loadReviewRegistration, authorize = () => false, dispatch = null, logDir = path.join(os.tmpdir(), "coding-control-completion-logs") } = {}) {
  const findings = [];
  for (let index = 0; index < (state.completionLanes ?? []).length; index++) {
    const lane = state.completionLanes[index];
    if (["blocked", "completed", "failed"].includes(lane.state)) continue;
    const observation = observe(lane);
    let registration = null;
    if (lane.reviewRequired && (observation.error || observation.pane === "idle_prompt" || observation.pane === "exited" || ["error", "rejected"].includes(observation.lastCommand?.status))) {
      try { registration = registrationLoader(lane); } catch { /* fail closed */ }
    }
    const decision = authorize(lane)
      ? reconcileLane(lane, observation, { now: at, reviewRegistration: registration })
      : { state: "blocked", action: "hold", reason: "workstate_grant_missing", priority: "immediate" };
    if (decision.action === "heartbeat" || decision.action === "none") continue;
    const receipt = completionReceipt(lane, observation, decision, { now: at });
    findings.push({ issue: lane.issue ?? null, phase: lane.state, kind: `completion_${decision.reason}`, evidence: receipt, nextAction: decision.action });
    if (!apply) continue;
    const next = applyDecision(lane, decision, { now: at });
    state.completionLanes[index] = next;
    // Persist the attempt claim while the caller's cross-process lock is held,
    // before a command can start. A second watcher cannot claim attempt N.
    save(state);
    if (decision.action === "redispatch_registered_action") {
      try {
        const launch = dispatch ?? ((candidate, argv) => {
          fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
          const safeId = candidate.id.replace(/[^A-Za-z0-9_.-]/g, "_");
          const logPath = path.join(logDir, `${safeId}-${candidate.retry.attempts}.log`);
          if (!path.isAbsolute(argv[0])) execFileSync("which", [argv[0]], { stdio: "ignore" });
          else fs.accessSync(argv[0], fs.constants.X_OK);
          const fd = fs.openSync(logPath, "a", 0o600);
          try {
            const child = spawn(argv[0], argv.slice(1), { cwd: candidate.worktree, detached: true, stdio: ["ignore", fd, fd] });
            child.on("error", () => {});
            if (!child.pid) throw new Error("child process did not start");
            child.unref();
            return { pid: child.pid, logPath };
          } finally { fs.closeSync(fd); }
        });
        const launched = launch(next, decision.argv);
        next.lastDispatch = { ...next.lastDispatch, ...launched };
        save(state);
      } catch (error) {
        next.state = "blocked";
        next.blockedReason = `dispatch_failed:${String(error.message ?? error)}`;
        save(state);
      }
    }
  }
  return findings;
}
