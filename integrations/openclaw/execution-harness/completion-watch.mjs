/** Live bounded completion-lane recovery. Caller holds the execution-state lock. */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyDecision, completionReceipt, reconcileLane, validateLane } from "../../../src/completion-controller.mjs";
import { loadReviewRegistration } from "../../../src/review-registration.mjs";

export function observeCompletionLane(lane, {
  capture = (name) => execFileSync("tmux", ["capture-pane", "-p", "-t", `=${name}`, "-S", "-80"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }),
  listSessions = () => execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }),
  processStatus = (pid) => execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }),
} = {}) {
  let pane = "executing";
  let blockedReason = lane.blockedReason ?? null;
  if (lane.lastDispatch?.pid) {
    try {
      const command = processStatus(lane.lastDispatch.pid).trim();
      if (!command || (lane.reviewRequired && (!command.includes("codex") || !command.includes(lane.headSha))))
        blockedReason = "dispatched_process_unverifiable";
      return { pane, lastCommand: null, completedEvidence: false, blockedReason };
    } catch {
      return { pane: "exited", lastCommand: null, completedEvidence: false, blockedReason: "dispatched_process_finished_requires_verification" };
    }
  }
  try {
    const output = capture(lane.sessionName);
    const last = output.trimEnd().split("\n").at(-1) ?? "";
    if (/^(?:\$|%|>)\s*$/.test(last)) pane = "idle_prompt";
  } catch {
    try {
      const sessions = listSessions().trimEnd().split("\n");
      if (!sessions.includes(lane.sessionName)) pane = "exited";
      else blockedReason = "pane_observation_failed";
    } catch { blockedReason = "pane_observation_failed"; }
  }
  return { pane, lastCommand: lane.lastCommand ?? null, completedEvidence: lane.completedEvidence === true, blockedReason };
}

export function reconcileCompletionLanes(state, { at, apply, save, observe = observeCompletionLane, registrationLoader = loadReviewRegistration, authorizeDispatch = () => false, dispatch = null, logDir = path.join(os.tmpdir(), "coding-control-completion-logs") } = {}) {
  const findings = [];
  const finding = (lane, observation, decision) => findings.push({ issue: lane.issue ?? null, phase: lane.state,
    kind: `completion_${decision.reason}`, evidence: completionReceipt(lane, observation, decision, { now: at }), nextAction: decision.action });
  for (let index = 0; index < (state.completionLanes ?? []).length; index++) {
    const lane = state.completionLanes[index];
    if (["blocked", "completed", "failed"].includes(lane.state)) continue;
    const observation = observe(lane);
    if (lane.lastDispatch?.launchStatus === "pending") {
      const uncertain = { state: "blocked", action: "hold", reason: "launch_outcome_uncertain", priority: "immediate" };
      finding(lane, observation, uncertain);
      if (apply) { state.completionLanes[index] = applyDecision(lane, uncertain, { now: at }); save(state); }
      continue;
    }
    let registration = null;
    if (lane.reviewRequired && (observation.error || observation.pane === "idle_prompt" || observation.pane === "exited" || ["error", "rejected"].includes(observation.lastCommand?.status))) {
      try { registration = registrationLoader(lane); } catch { /* fail closed */ }
    }
    const decision = reconcileLane(lane, observation, { now: at, reviewRegistration: registration });
    if (decision.action === "heartbeat" || decision.action === "none") continue;
    if (decision.action !== "redispatch_registered_action") {
      finding(lane, observation, decision);
      if (apply) { state.completionLanes[index] = applyDecision(lane, decision, { now: at }); save(state); }
      continue;
    }
    if (!apply) { finding(lane, observation, decision); continue; }
    try {
      const authorized = authorizeDispatch(lane, () => {
        const next = applyDecision(lane, decision, { now: at });
        next.state = "recovering";
        next.lastDispatch.launchStatus = "pending";
        state.completionLanes[index] = next;
        // The execution-state lock is already held by the caller. Reserve the
        // attempt durably while the WorkState lock is held by authorizeDispatch.
        save(state);
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
        next.state = "executing";
        next.lastDispatch = { ...next.lastDispatch, ...launched, launchStatus: "launched" };
        save(state);
        return true;
      });
      if (!authorized) {
        const denied = { state: "blocked", action: "hold", reason: "workstate_grant_missing", priority: "immediate" };
        finding(lane, observation, denied);
        state.completionLanes[index] = applyDecision(lane, denied, { now: at });
        save(state);
      } else finding(lane, observation, decision);
    } catch (error) {
      const uncertain = { state: "blocked", action: "hold", reason: "launch_outcome_uncertain", priority: "immediate" };
      finding(lane, observation, uncertain);
      state.completionLanes[index] = applyDecision(state.completionLanes[index], uncertain, { now: at });
      state.completionLanes[index].launchError = String(error.message ?? error).slice(0, 300);
      save(state);
    }
  }
  return findings;
}
