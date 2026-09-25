#!/usr/bin/env node
/**
 * Durable control plane for execution lanes.
 *
 * This program never performs a production deployment. It records observable
 * evidence, enforces legal state transitions, and turns missed deadlines into
 * durable, deduplicated escalation events for the watchdog to handle.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handoffRecord } from "./deterministic-engine.mjs";
import { emptyRuntime, registerWorkState, validateRuntime, workStateContext } from "./work-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultState = process.env.EXECUTION_HARNESS_STATE || path.join(here, "execution-state.json");
const phases = ["identified", "implementing", "tests-running", "pr-open", "ci-green", "review-blocked", "reviewed", "merged", "staged", "production-verified", "completed", "stalled", "blocked", "archived"];
const reviewStatuses = ["unreviewed", "actionable", "overdue", "clear"];
const verificationNames = ["typecheck_lint", "build", "targeted_tests", "full_suite", "staging_health", "staging_smoke", "staging_uat"];
const verificationStatuses = ["pending", "running", "passed", "failed", "skipped"];
const prePrGates = ["typecheck_lint", "build", "targeted_tests"];
const preProductionGates = ["typecheck_lint", "build", "targeted_tests", "full_suite", "staging_health", "staging_smoke", "staging_uat"];
const sourceGates = ["typecheck_lint", "build", "targeted_tests", "full_suite"];
const runtimeGates = ["staging_health", "staging_smoke", "staging_uat"];
const transitions = new Map([
  ["identified", new Set(["implementing", "blocked"])],
  ["implementing", new Set(["tests-running", "pr-open", "stalled", "blocked"])],
  ["tests-running", new Set(["pr-open", "stalled", "blocked"])],
  ["pr-open", new Set(["ci-green", "stalled", "blocked"])],
  ["ci-green", new Set(["review-blocked", "reviewed", "stalled", "blocked"])],
  ["review-blocked", new Set(["implementing", "pr-open", "stalled", "blocked"])],
  ["reviewed", new Set(["merged", "stalled", "blocked"])],
  ["merged", new Set(["staged", "stalled", "blocked"])],
  ["staged", new Set(["production-verified", "blocked"])],
  ["production-verified", new Set(["completed", "blocked"])],
  ["stalled", new Set(["implementing", "tests-running", "pr-open", "blocked"])],
  ["blocked", new Set(["identified", "implementing", "tests-running", "pr-open", "staged", "stalled"])]
]);

function fail(message) { console.error(message); process.exit(2); }
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fail(`Missing value for ${name}`));
}
function now() { return arg("--at", new Date().toISOString()); }
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Unable to read state ${file}: ${error.message}`); }
}
function normalize(state) {
  state.releasePolicy ??= {};
  state.releasePolicy.incidentOverrides ??= [];
  state.portfolio ??= { repositories: [] };
  for (const lane of state?.lanes ?? []) {
    lane.review ??= { status: "unreviewed", head: null, evidence: null, dueAt: null, updatedAt: null };
    lane.adapter ??= "development";
    lane.dispatch ??= null;
  }
  return state;
}
function validate(state) {
  if (state?.schemaVersion !== 2 || !Array.isArray(state.lanes) || !Array.isArray(state.events)) fail("Invalid execution-state.json schema.");
  if (!Array.isArray(state.portfolio?.repositories) || state.portfolio.repositories.length === 0) fail("Execution state must declare the managed portfolio repositories.");
  const managedRepositories = new Set();
  for (const repository of state.portfolio.repositories) {
    if (!repository?.id || !repository?.repository || managedRepositories.has(repository.repository)) fail("Invalid or duplicate managed portfolio repository.");
    managedRepositories.add(repository.repository);
  }
  for (const lane of state.lanes) {
    if (!lane.id || (lane.issue !== null && !Number.isInteger(lane.issue)) || !managedRepositories.has(lane.repository) || !phases.includes(lane.phase)) fail(`Invalid lane: ${JSON.stringify(lane)}`);
    if (lane.active && lane.phase === "completed") fail(`Completed lane ${lane.id} cannot remain active.`);
    if (lane.adapter !== "development") fail(`Unsupported adapter for lane ${lane.id}: ${lane.adapter}`);
    if (!lane.successPredicate || !lane.nextAction) fail(`Lane ${lane.id} is missing a success predicate or next action.`);
    if (!lane.review || !reviewStatuses.includes(lane.review.status)) fail(`Lane ${lane.id} has invalid review state.`);
    if (lane.review.status === "actionable" && (!lane.review.head || !lane.review.evidence || !lane.review.dueAt)) fail(`Actionable review in ${lane.id} requires head, evidence, and a remediation deadline.`);
    if (!Array.isArray(lane.verifications)) fail(`Lane ${lane.id} is missing verification state.`);
    for (const gate of lane.verifications) {
      if (!verificationNames.includes(gate.name) || !verificationStatuses.includes(gate.status)) fail(`Invalid verification gate in ${lane.id}.`);
      if (gate.status === "passed" && (!gate.artifact || !gate.command || !gate.evidence)) fail(`Passed gate ${gate.name} in ${lane.id} needs artifact, command, and evidence.`);
      // Historical records remain readable, but every newly submitted pass is
      // checked against the standing v2 contract below.
      if (gate.name === "staging_uat" && gate.status === "passed") validateJourney(gate.journey, lane.id, { allowLegacyRecord: true });
    }
  }
  return state;
}
function developmentTemplate(item, kind) {
  const template = item.development?.[kind];
  if (!template) return null;
  for (const key of ["id", "title", "objective", "branch", "worktree", "gatesFile", "verificationCommand", "nextAction", "due"]) {
    if (typeof template[key] !== "string" || !template[key].trim()) fail(`Development ${kind} template for ${item.id} is missing ${key}.`);
  }
  iso(template.due, `development ${kind} due`);
  if (template.issue !== null && template.issue !== undefined && !Number.isInteger(template.issue)) fail(`Development ${kind} template for ${item.id} has invalid issue.`);
  if (template.constraints !== undefined && (!Array.isArray(template.constraints) || !template.constraints.every((item) => typeof item === "string" && item.trim()))) fail(`Development ${kind} template for ${item.id} has invalid constraints.`);
  if (template.stopCondition !== undefined && (typeof template.stopCondition !== "string" || !template.stopCondition.trim())) fail(`Development ${kind} template for ${item.id} has invalid stopCondition.`);
  return template;
}
function developmentDispatch(state, source, kind, at, evidence) {
  const template = developmentTemplate(source, kind);
  if (!template) return null;
  if (state.lanes.some((item) => item.id === template.id)) return state.lanes.find((item) => item.id === template.id);
  const executionContract = {
    objective: template.objective,
    constraints: template.constraints ?? ["Do not change unrelated code or add dependencies without recorded approval.", "Do not weaken, skip, or narrow tests or acceptance criteria to claim success.", "Do not add speculative features or configuration; introduce an abstraction only when the packet identifies a concrete reuse case.", "Every changed line must trace to this packet; call out unrelated cleanup rather than including it silently."],
    validation: template.validation ?? [template.verificationCommand],
    stopCondition: template.stopCondition ?? template.objective,
    checkpointCadence: template.checkpointCadence ?? "Record evidence before the heartbeat deadline."
  };
  const dispatchPrompt = [
    `Objective: ${executionContract.objective}`,
    `Constraints: ${executionContract.constraints.join(" ")}`,
    "Before changing code, inspect the GitHub issue's Machine-Executable UAT section. If it is absent or incomplete, add the issue-derived role, synthetic data/starting state, steps, expected and forbidden outcomes, correctness/compliance checks, and evidence fields with gh issue edit. Do not start implementation until that contract is complete.",
    "For staging UAT, use only disposable synthetic data. Exercise the role named by the issue, not an arbitrary admin role. Record browser errors, compliance checks, and evidence artifacts. If synthetic data cannot faithfully exercise the workflow, record the concrete limitation and hold the gate; never use customer data.",
    `Validate: ${executionContract.validation.join("; ")}`,
    "Document: update concise, targeted documentation for material behavior changes.",
    "Checkpoints: record brief evidence after each material checkpoint.",
    `Stop when: ${executionContract.stopCondition}, or when a Jason-only decision is required.`,
    `Next action: ${template.nextAction}`
  ].join("\n");
  const packet = {
    id: template.id,
    issue: template.issue ?? null,
    repository: source.repository,
    priority: template.priority ?? source.priority ?? "P1",
    title: template.title,
    phase: "identified",
    active: true,
    adapter: "development",
    owner: "Claude Code",
    branch: template.branch,
    worktree: template.worktree,
    tmuxSession: template.tmuxSession ?? template.id,
    pullRequest: null,
    successPredicate: template.objective,
    nextAction: template.nextAction,
    nextActionDueAt: template.due,
    heartbeatDueAt: template.due,
    lastEvidence: { at, detail: evidence },
    blocker: null,
    parentLaneId: source.id,
    gatesFile: template.gatesFile,
    verificationCommand: template.verificationCommand,
    executionContract,
    dispatch: {
      status: "ready",
      transport: "tmux",
      executor: "Claude Code",
      command: `claude -p ${JSON.stringify(dispatchPrompt)} --dangerously-skip-permissions`,
      basePrompt: dispatchPrompt,
      autoRecover: true,
      createdAt: at
    },
    // A dispatched development packet is a product issue. Its UAT gate is
    // mandatory from creation; the issue-derived contract determines how it is
    // executed, not whether it can be waived.
    verifications: verificationNames.map((name) => ({ name, required: name === "staging_uat", status: "skipped", updatedAt: at, command: null, evidence: "Not applicable until an implementation packet is selected.", artifact: null, dueAt: null, journey: null })),
    review: { status: "unreviewed", head: null, evidence: null, dueAt: null, updatedAt: null }
  };
  ensureWorkState(packet, at);
  state.lanes.push(packet);
  event(state, { at, laneId: packet.id, kind: "development_dispatch_ready", evidence: `${evidence} Dispatch: ${packet.dispatch.command}` });
  return packet;
}
function contractChecks(item) {
  if (!item.executionContract) return [];
  item.contractChecks ??= item.executionContract.validation.map((validation) => ({ validation, status: "pending", evidence: null, artifact: null, updatedAt: null }));
  return item.contractChecks;
}
function contractSatisfied(item) {
  return !item.executionContract || contractChecks(item).every((check) => check.status === "passed" && check.evidence && check.artifact);
}
function contractPrompt(contract, nextAction) {
  return [
    `Objective: ${contract.objective}`,
    `Constraints: ${contract.constraints.join(" ")}`,
    `Validate: ${contract.validation.join("; ")}`,
    "Document: update concise, targeted documentation for material behavior changes.",
    "Checkpoints: record brief evidence after each material checkpoint.",
    `Stop when: ${contract.stopCondition}, or when a Jason-only decision is required.`,
    `Next action: ${nextAction}`
  ].join("\n");
}
function upgradeDevelopmentContract(item, at) {
  if (item.adapter !== "development") fail(`Lane ${item.id} is not a development packet.`);
  if (item.executionContract) fail(`Lane ${item.id} already has an execution contract.`);
  if (!item.verificationCommand) fail(`Lane ${item.id} has no deterministic verification command to migrate.`);
  const executionContract = {
    objective: item.successPredicate,
    constraints: ["Do not change unrelated code or add dependencies without recorded approval.", "Do not weaken, skip, or narrow tests or acceptance criteria to claim success.", "Do not add speculative features or configuration; introduce an abstraction only when the packet identifies a concrete reuse case.", "Every changed line must trace to this packet; call out unrelated cleanup rather than including it silently."],
    validation: [item.verificationCommand],
    stopCondition: item.successPredicate,
    checkpointCadence: "Record evidence before the heartbeat deadline."
  };
  item.executionContract = executionContract;
  contractChecks(item);
  if (item.dispatch && ["identified", "implementing", "tests-running", "pr-open", "review-blocked", "stalled"].includes(item.phase)) {
    const basePrompt = contractPrompt(executionContract, item.nextAction);
    item.dispatch = { ...item.dispatch, basePrompt, autoRecover: true, upgradedAt: at };
  }
  item.lastEvidence = { at, detail: `Development packet migrated to an enforced execution contract with deterministic validation: ${item.verificationCommand}` };
  event(state, { at, laneId: item.id, kind: "development_contract_upgraded", evidence: item.lastEvidence.detail });
  return item;
}
function workStatePath() {
  return arg("--work-state", process.env.EXECUTION_HARNESS_WORK_STATE || (stateFile === defaultState ? path.join(here, "work-state.json") : `${stateFile}.work-state.json`));
}
function durableWorkStateContext(item) {
  const file = workStatePath();
  let runtime;
  try { runtime = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null; }
  catch (error) { fail(`Unable to read WorkState runtime for ${item.id}: ${error.message}`); }
  if (!runtime) fail(`Lane ${item.id} declares WorkState ${item.workStateId}, but the durable runtime is absent.`);
  try { validateRuntime(runtime); return workStateContext(runtime, item.workStateId); }
  catch (error) { fail(`Invalid WorkState for ${item.id}: ${error.message}`); }
}
function ensureWorkState(item, at) {
  const file = workStatePath();
  let runtime;
  try { runtime = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : emptyRuntime(); validateRuntime(runtime); }
  catch (error) { fail(`Unable to initialize WorkState for ${item.id}: ${error.message}`); }
  const id = item.workStateId ?? `lane:${item.id}`;
  if (!runtime.records[id]) {
    const phase = ["stalled", "blocked"].includes(item.phase) ? "blocked" :
      ["completed", "archived", "production-verified"].includes(item.phase) ? "completed" :
      ["ci-green", "reviewed", "merged", "staged"].includes(item.phase) ? "verified" :
      ["implementing", "tests-running", "pr-open", "review-blocked"].includes(item.phase) ? "active" : "identified";
    registerWorkState(runtime, {
      id, objective: item.executionContract?.objective ?? item.successPredicate,
      acceptanceTests: item.executionContract?.validation ?? [item.successPredicate],
      authorityBoundary: { allowedActions: ["inspect", "observe", "draft", "internal_update", "retry_safe"] },
      phase, nextAction: item.nextAction, owner: item.owner,
      dependencies: [], blockers: item.blocker ? [item.blocker] : [], facts: item.lastEvidence?.detail ? [item.lastEvidence.detail] : [], decisions: [], evidenceRefs: [],
      retryPolicy: { maxAttempts: 3 }, deadline: item.heartbeatDueAt ?? item.nextActionDueAt ?? null,
    }, at);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(runtime, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  }
  item.workStateId = id;
  return id;
}
function recoveryCommand(item) {
  const durable = item.workStateId ? durableWorkStateContext(item) : null;
  const handoff = durable ?? handoffRecord(item);
  const basePrompt = item.dispatch?.basePrompt;
  if (!basePrompt) return { command: item.dispatch?.command, handoff };
  const heading = durable ? "Recovery context (canonical WorkState plus latest evidence; do not reconstruct state from transcript):" : "Recovery handoff (authoritative state; verify it against the worktree before acting):";
  const prompt = `${basePrompt}\n\n${heading}\n${JSON.stringify(handoff)}`;
  return { command: `claude -p ${JSON.stringify(prompt)} --dangerously-skip-permissions`, handoff };
}
function recoverDevelopment(item, at) {
  if (!item.dispatch?.autoRecover || item.dispatch.status !== "invalidated") fail(`Lane ${item.id} is not eligible for automatic recovery.`);
  if (!["identified", "implementing", "tests-running", "pr-open", "review-blocked", "stalled"].includes(item.phase)) fail(`Lane ${item.id} is terminal or not safely recoverable.`);
  const worktree = expectedWorktree(item);
  if (!fs.statSync(worktree, { throwIfNoEntry: false })?.isDirectory()) fail(`Recovery worktree is missing: ${worktree}`);
  const session = item.dispatch.session ?? item.tmuxSession ?? item.id;
  try { execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" }); fail(`Recovery session already exists: ${session}`); } catch (error) { if (error?.status === undefined) throw error; }
  const recovery = recoveryCommand(item);
  if (!recovery.command) fail(`Lane ${item.id} has no recoverable dispatch command.`);
  execFileSync("tmux", ["new-session", "-d", "-s", session, "-c", worktree, recovery.command], { stdio: "ignore" });
  const pane = `${session}:0.0`;
  const observed = tmuxPaneState(session, pane);
  if (!observed.ok || observed.cwd !== worktree) {
    try { execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" }); } catch {}
    fail(`Recovery dispatch failed literal pane/worktree verification for ${item.id}.`);
  }
  item.dispatch = { ...item.dispatch, status: "attached", session, pane, worktree, command: recovery.command, recoveryAt: at, recoveryCount: (item.dispatch.recoveryCount ?? 0) + 1, handoff: recovery.handoff };
  item.phase = item.phase === "stalled" ? "implementing" : item.phase;
  item.blocker = null;
  item.lastEvidence = { at, detail: `Automatic recovery attached ${session}:${pane} in ${worktree} using the durable handoff record.` };
  item.nextAction = "Executor resumed from the recorded recovery handoff; observe the literal pane and record its next material evidence.";
  event(state, { at, laneId: item.id, kind: "development_recovered", evidence: item.lastEvidence.detail });
  return item;
}
function retireSource(item, at, evidence) {
  item.active = false;
  item.heartbeatDueAt = null;
  item.nextActionDueAt = null;
  item.lastEvidence = { at, detail: evidence };
}
function save(file, state) {
  state.updatedAt = new Date().toISOString();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}
function lane(state) {
  const id = arg("--lane");
  const issueArg = arg("--issue");
  if (!id && issueArg === null) fail("Specify --lane or --issue.");
  const issue = issueArg === null ? null : Number(issueArg);
  const found = id ? state.lanes.find((item) => item.id === id) : state.lanes.find((item) => item.issue === issue);
  if (!found) fail(id ? `No lane named ${id}.` : `No lane for issue #${issue}.`);
  return found;
}
function event(state, item) {
  const id = `${item.laneId}:${item.kind}:${item.at}`;
  if (!state.events.some((existing) => existing.id === id)) state.events.push({ id, notification: "pending", ...item });
}
function iso(value, name) {
  if (Number.isNaN(Date.parse(value))) fail(`${name} must be an ISO timestamp.`);
  return value;
}
function expectedWorktree(item) { return path.resolve(process.cwd(), item.worktree); }
function tmuxPaneState(session, pane) {
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore", timeout: 5000 });
    const target = pane || `${session}:0.0`;
    const cwd = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{pane_current_path}"], { encoding: "utf8", timeout: 5000 }).trim();
    if (!cwd) return { ok: false, reason: `tmux pane ${target} did not report a working directory` };
    return { ok: true, target, cwd: path.resolve(cwd) };
  } catch (error) {
    return { ok: false, reason: `tmux session/pane is not live: ${session}${pane ? ` (${pane})` : ""}` };
  }
}
function dispatchHealth(item) {
  if (!item.dispatch || item.dispatch.status !== "attached") return null;
  if (process.argv.includes("--skip-tmux")) return null;
  const observed = tmuxPaneState(item.dispatch.session, item.dispatch.pane);
  if (!observed.ok) return observed.reason;
  if (!item.dispatch.worktree) return "attached dispatch has no recorded literal pane/worktree evidence";
  if (observed.cwd !== item.dispatch.worktree) return `tmux pane cwd mismatch: expected ${item.dispatch.worktree}, observed ${observed.cwd}`;
  return null;
}
// Nothing retired a finished lane's tmux executor, so sessions piled up until
// the host ran out of swap (37 idle sessions, 2026-09-24). Any session idle past
// the threshold is reaped unless an active lane still owns it; dispatchHealth
// already supervises those.
function idleTmuxSessions(state, timestamp, idleHours) {
  let listing;
  try { listing = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}\t#{session_activity}"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return []; } // No tmux server: nothing to reap.
  const owned = new Set(state.lanes.filter((item) => item.active).flatMap((item) => [item.dispatch?.session, item.tmuxSession]).filter(Boolean));
  return listing.split("\n").filter(Boolean)
    .map((line) => { const [name, activity] = line.split("\t"); return { name, idleHours: (timestamp - Number(activity) * 1000) / 3_600_000 }; })
    .filter((session) => !owned.has(session.name) && session.idleHours >= idleHours);
}
function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function validateJourney(journey, laneId, { allowLegacyRecord = false } = {}) {
  if (!journey || typeof journey !== "object") fail(`Passed staging_uat in ${laneId} needs a journey record.`);
  if (allowLegacyRecord && journey.schemaVersion === undefined) {
    for (const key of ["persona", "startingState", "expectedOutcome", "observedOutcome"]) if (typeof journey[key] !== "string" || !journey[key].trim()) fail(`Legacy UAT journey in ${laneId} is missing ${key}.`);
    for (const key of ["actions", "forbiddenOutcomes", "browserErrors"]) if (!Array.isArray(journey[key])) fail(`Legacy UAT journey in ${laneId} is missing ${key}.`);
    return;
  }
  if (journey.schemaVersion !== 2) fail(`UAT journey in ${laneId} must use schemaVersion 2.`);
  // Persona is issue-derived: a clerk workflow must not be accepted by
  // exercising it as an administrator merely because that is convenient.
  for (const key of ["persona", "roleRationale", "startingState", "syntheticData", "expectedOutcome", "observedOutcome"]) if (typeof journey[key] !== "string" || !journey[key].trim()) fail(`UAT journey in ${laneId} is missing ${key}.`);
  for (const key of ["actions", "forbiddenOutcomes", "complianceChecks", "evidenceArtifacts", "browserErrors"]) if (!Array.isArray(journey[key])) fail(`UAT journey in ${laneId} is missing ${key}.`);
  if (journey.actions.length === 0 || journey.forbiddenOutcomes.length === 0) fail(`UAT journey in ${laneId} needs actions and forbidden outcomes.`);
  if (journey.complianceChecks.length === 0 || journey.evidenceArtifacts.length === 0) fail(`UAT journey in ${laneId} needs compliance checks and captured evidence.`);
}
function machineUatIssueCheck(item) {
  if (item.issue === null) return { ok: true, skipped: "portfolio lane" };
  let issue;
  try {
    issue = JSON.parse(execFileSync("gh", ["issue", "view", String(item.issue), "--repo", item.repository, "--json", "body,state"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }));
  } catch (error) {
    return { ok: false, reason: `could not verify GitHub issue UAT contract: ${String(error.stderr || error.message || error).slice(0, 300)}` };
  }
  if (issue.state !== "OPEN") return { ok: false, reason: `issue #${item.issue} is not open` };
  const body = String(issue.body || "");
  const required = ["## Engineering Acceptance Contract", "## Machine-Executable UAT", "### Issue-derived user role", "### Synthetic test data and starting state", "### Steps", "### Expected outcomes", "### Forbidden outcomes", "### Correctness and compliance checks", "### Evidence to capture"];
  const missing = required.filter((marker) => !body.includes(marker));
  if (missing.length) return { ok: false, reason: `issue #${item.issue} lacks engineering acceptance sections: ${missing.join(", ")}` };
  if (!new RegExp(`\\bissue-${item.issue}-acceptance\\b`).test(body)) return { ok: false, reason: `issue #${item.issue} lacks a named issue-${item.issue}-acceptance deterministic test target` };
  return { ok: true };
}
function gateFor(item, name) {
  const found = item.verifications.find((candidate) => candidate.name === name);
  if (!found) fail(`Lane #${item.issue} has no ${name} verification gate.`);
  return found;
}
function requiredGates(item, names) {
  return names.filter((name) => gateFor(item, name).required);
}
function missingPassedGates(item, names, artifact = null) {
  return requiredGates(item, names).filter((name) => {
    const gate = gateFor(item, name);
    return gate.status !== "passed" || (artifact !== null && gate.artifact !== artifact);
  });
}
function missingProductionGates(item, runtimeArtifact, sourceArtifact) {
  const missing = [];
  if (!sourceArtifact) missing.push("source_artifact");
  else missing.push(...missingPassedGates(item, sourceGates.filter((name) => name !== "build"), sourceArtifact));
  // Older lanes recorded build evidence against the source SHA; release-train
  // lanes record it against the immutable image digest. Accept either binding
  // while every runtime gate remains bound strictly to the image digest.
  const build = gateFor(item, "build");
  if (build.required && (build.status !== "passed" || ![sourceArtifact, runtimeArtifact].includes(build.artifact))) missing.push("build");
  missing.push(...missingPassedGates(item, runtimeGates, runtimeArtifact));
  return missing;
}
function activeIncidentOverride(item, artifact, at = new Date().toISOString()) {
  return [...state.releasePolicy.incidentOverrides].reverse().find((override) =>
    override.issue === item.issue &&
    override.artifact === artifact &&
    override.status === "active" &&
    Date.parse(override.expiresAt) > Date.parse(at)
  ) ?? null;
}
function githubIssue(item) {
  if (item.issue === null) return null;
  try {
    return JSON.parse(execFileSync("gh", ["issue", "view", String(item.issue), "--repo", item.repository, "--json", "state,closedAt"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }));
  } catch (error) {
    return { error: String(error.stderr || error.message || error) };
  }
}
function portfolioFindings(state, at, apply) {
  const findings = [];
  for (const repository of state.portfolio.repositories) {
    const registered = state.lanes.some((item) => item.repository === repository.repository);
    if (registered) continue;
    const evidence = `portfolio_scope_mismatch: ${repository.id} (${repository.repository}) has no registered lane.`;
    findings.push({ repository: repository.repository, kind: "portfolio_scope_mismatch", evidence, nextAction: `Register and reconcile ${repository.id} before any portfolio-wide operational report.` });
    if (apply) event(state, { at, laneId: `portfolio-${repository.id}`, kind: "portfolio_scope_mismatch", evidence });
  }
  return findings;
}
function stagingRevision(item) {
  const deployment = item.stagingDeployment;
  if (!deployment || deployment.provider !== "azure-container-apps") return null;
  const injected = arg("--staging-report");
  if (injected) {
    try { return JSON.parse(injected); }
    catch { return { error: "invalid --staging-report JSON" }; }
  }
  try {
    return JSON.parse(execFileSync("az", ["containerapp", "revision", "show", "--name", deployment.app, "--resource-group", deployment.resourceGroup, "--revision", deployment.revision, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }));
  } catch (error) {
    return { error: String(error.stderr || error.message || error) };
  }
}
function currentMainCommit(repository) {
  try {
    const output = execFileSync("git", ["ls-remote", `https://github.com/${repository}.git`, "refs/heads/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
    return output.split(/\s+/)[0] || null;
  } catch (error) {
    return null;
  }
}
function manifestCandidate(item, manifest) {
  if (!manifest?.source?.commit || !manifest?.artifact?.digest) fail("release manifest must include source.commit and artifact.digest.");
  const sourceArtifact = `git:${manifest.source.commit}`;
  const artifact = manifest.artifact.digest;
  const exactPassed = (names, expected) => names.every((name) => {
    const gate = gateFor(item, name);
    return gate.status === "passed" && gate.artifact === expected;
  });
  const currentMain = currentMainCommit(item.repository);
  return {
    artifact,
    sourceArtifact,
    eligible_merged_prs: currentMain === manifest.source.commit,
    required_ci_green: manifest.source.ciStatus === "success" && exactPassed(["typecheck_lint", "targeted_tests", "full_suite"], sourceArtifact),
    codex_zero_actionable_findings: item.review.status === "clear" && item.review.head === sourceArtifact,
    artifact_lineage_verified: exactPassed(["build"], artifact),
    staging_smoke_on_exact_artifact: exactPassed(runtimeGates, artifact),
    rollback_anchor: Boolean(manifest.production?.rollbackAnchor),
    no_active_release_hold: item.phase === "staged" && item.blocker === null,
    manifest_source_is_current_main: currentMain === manifest.source.commit,
    manifestId: manifest.id ?? null
  };
}

const command = process.argv[2];
const stateFile = arg("--state", defaultState);
const state = validate(normalize(load(stateFile)));

if (command === "status") {
  print({ updatedAt: state.updatedAt, portfolio: state.portfolio, releasePolicy: state.releasePolicy, lanes: state.lanes, pendingEvents: state.events.filter((e) => e.notification === "pending") });
} else if (command === "register-lane") {
  const id = arg("--id");
  const repository = arg("--repository");
  const title = arg("--title");
  const objective = arg("--objective");
  const nextAction = arg("--next-action");
  const due = arg("--due");
  if (!id || !repository || !title || !objective || !nextAction || !due) fail("register-lane requires --id, --repository, --title, --objective, --next-action, and --due.");
  if (!state.portfolio.repositories.some((item) => item.repository === repository)) fail(`${repository} is not in the managed portfolio.`);
  if (state.lanes.some((item) => item.id === id)) fail(`Lane ${id} already exists.`);
  iso(due, "--due");
  const at = now();
  const item = {
    id, issue: null, repository, priority: "P1", title, phase: "identified", owner: "Portfolio controller", branch: null, worktree: null,
    pullRequest: null, active: true, successPredicate: objective, nextAction, nextActionDueAt: due, heartbeatDueAt: due,
    lastEvidence: { at, detail: `Lane registered for portfolio reconciliation: ${objective}` }, blocker: null,
    verifications: verificationNames.map((name) => ({ name, required: false, status: "skipped", updatedAt: at, command: null, evidence: "Not applicable until an implementation packet is selected.", artifact: null, dueAt: null, journey: null })),
    review: { status: "unreviewed", head: null, evidence: null, dueAt: null, updatedAt: null }
  };
  ensureWorkState(item, at);
  state.lanes.push(item);
  event(state, { at, laneId: item.id, kind: "lane_registered", evidence: item.lastEvidence.detail });
  save(stateFile, state);
  print({ lane: item, event: state.events.at(-1) });
} else if (command === "migrate-workstates") {
  const at = now();
  const migrated = [];
  for (const item of state.lanes.filter((candidate) => candidate.active && !candidate.workStateId)) {
    const workStateId = ensureWorkState(item, at);
    migrated.push({ laneId: item.id, workStateId });
    event(state, { at, laneId: item.id, kind: "workstate_migrated", evidence: `Existing active lane migrated to canonical WorkState ${workStateId}.` });
  }
  save(stateFile, state);
  print({ migrated, count: migrated.length });
} else if (command === "operational-report") {
  const ids = arg("--lanes", "").split(",").filter(Boolean);
  const summary = arg("--summary");
  if (!summary.trim() || ids.length === 0) fail("operational-report requires --lanes and --summary.");
  const requested = ids.map((id) => state.lanes.find((item) => item.id === id));
  if (requested.some((item) => !item)) fail("operational-report references an unregistered lane.");
  const missingPortfolio = portfolioFindings(state, now(), false);
  if (missingPortfolio.length) fail(`Cannot issue a portfolio operational report: ${missingPortfolio.map((finding) => finding.repository).join(", ")} lack registered lanes.`);
  for (const item of requested) {
    if (!item.lastEvidence?.detail || !item.lastEvidence?.at) fail(`Cannot report ${item.id} without recorded evidence.`);
    // "stalled" joins the exemption because a stalled lane deliberately carries
    // no live deadline (see the watch stall branch). Without this, disarming the
    // deadline would make operational-report fail() — i.e. process.exit — on
    // exactly the lanes most worth reporting on.
    if (item.active && !item.heartbeatDueAt && !item.nextActionDueAt && !["production-verified", "blocked", "stalled"].includes(item.phase)) fail(`Cannot report ${item.id}: no continuation deadline is recorded.`);
  }
  const at = now();
  const evidence = `Operational report backed by lanes ${ids.join(", ")}: ${summary}`;
  event(state, { at, laneId: "portfolio", kind: "operational_report_evidenced", evidence });
  save(stateFile, state);
  print({ report: { at, lanes: ids, summary, evidence }, event: state.events.at(-1) });
} else if (command === "transition") {
  const item = lane(state);
  const to = arg("--to");
  const evidence = arg("--evidence");
  const deadline = arg("--heartbeat-due");
  if (!phases.includes(to) || !transitions.get(item.phase)?.has(to)) fail(`Illegal transition ${item.phase} -> ${to} for #${item.issue}.`);
  if (!evidence.trim()) fail("A transition requires observable evidence.");
  if (deadline) iso(deadline, "--heartbeat-due");
  if (to === "pr-open") {
    const missing = missingPassedGates(item, prePrGates);
    if (missing.length) fail(`Cannot open PR for #${item.issue}; required verification gates not passed: ${missing.join(", ")}.`);
    if (!contractSatisfied(item)) fail(`Cannot open PR for #${item.issue}; execution-contract validation is incomplete.`);
  }
  if (to === "production-verified") {
    const artifact = arg("--artifact");
    const sourceArtifact = arg("--source-artifact");
    if (!artifact) fail("production-verified requires --artifact.");
    if (!sourceArtifact) fail("production-verified requires --source-artifact.");
    const missing = missingProductionGates(item, artifact, sourceArtifact);
    if (missing.length) fail(`Cannot mark #${item.issue} production verified; exact-artifact verification missing: ${missing.join(", ")}.`);
  }
  const at = now();
  item.phase = to;
  item.lastEvidence = { at, detail: evidence };
  item.heartbeatDueAt = deadline ?? null;
  item.blocker = to === "blocked" ? evidence : null;
  event(state, { at, laneId: item.id, kind: `phase_${to}`, evidence });
  save(stateFile, state);
  print({ lane: item, event: state.events.at(-1) });
} else if (command === "observe") {
  const item = lane(state);
  const evidence = arg("--evidence");
  const deadline = arg("--heartbeat-due");
  if (!evidence.trim() || !deadline) fail("observe requires --evidence and --heartbeat-due.");
  iso(deadline, "--heartbeat-due");
  const at = now();
  item.lastEvidence = { at, detail: evidence };
  item.heartbeatDueAt = deadline;
  event(state, { at, laneId: item.id, kind: "evidence_observed", evidence });
  save(stateFile, state);
  print({ lane: item, event: state.events.at(-1) });
} else if (command === "record-review") {
  const item = lane(state);
  const status = arg("--status");
  const head = arg("--head");
  const evidence = arg("--evidence");
  const nextAction = arg("--next-action");
  const due = arg("--due");
  if (!reviewStatuses.includes(status) || status === "unreviewed") fail("record-review status must be actionable or clear.");
  if (!head.trim() || !evidence.trim() || !nextAction.trim()) fail("record-review requires head, evidence, and next action.");
  if (status === "actionable") iso(due, "--due");
  const at = now();
  item.review = { status, head, evidence, dueAt: status === "actionable" ? due : null, updatedAt: at };
  item.lastEvidence = { at, detail: evidence };
  item.nextAction = nextAction;
  item.heartbeatDueAt = status === "actionable" ? due : item.heartbeatDueAt;
  if (status === "actionable") {
    item.phase = "review-blocked";
    item.blocker = `actionable_review:${evidence}`;
    const packet = developmentDispatch(state, item, "remediation", at, `Actionable review on ${item.id}: ${evidence}`);
    if (packet) retireSource(item, at, `Remediation packet ${packet.id} was dispatched from actionable review evidence.`);
  } else if (item.phase === "review-blocked") {
    item.phase = "reviewed";
    item.blocker = null;
  }
  event(state, { at, laneId: item.id, kind: `review_${status}`, evidence });
  save(stateFile, state);
  print({ lane: item, dispatched: state.lanes.filter((candidate) => candidate.parentLaneId === item.id), event: state.events.at(-1) });
} else if (command === "dispatch-development") {
  const item = lane(state);
  const kind = arg("--kind");
  if (!["successor", "remediation"].includes(kind)) fail("dispatch-development requires --kind successor or remediation.");
  const at = now();
  const packet = developmentDispatch(state, item, kind, at, `${kind} packet explicitly dispatched from ${item.id}.`);
  if (!packet) fail(`Lane ${item.id} has no development ${kind} template.`);
  retireSource(item, at, `${kind} packet ${packet.id} dispatched.`);
  save(stateFile, state);
  print({ source: item, packet, event: state.events.at(-1) });
} else if (command === "attach-development") {
  const item = lane(state);
  const session = arg("--tmux-session");
  const evidence = arg("--evidence");
  const deadline = arg("--heartbeat-due");
  const pane = arg("--tmux-pane", `${session}:0.0`);
  if (!item.dispatch || !["ready", "attached"].includes(item.dispatch.status)) fail(`Lane ${item.id} is not awaiting development dispatch.`);
  if (!session.trim() || !evidence.trim() || !deadline) fail("attach-development requires --tmux-session, --evidence, and --heartbeat-due.");
  const uatContract = machineUatIssueCheck(item);
  if (!uatContract.ok) fail(`Cannot start Claude for ${item.id}: ${uatContract.reason}. Add the standing UAT template to the GitHub issue first.`);
  iso(deadline, "--heartbeat-due");
  const observed = tmuxPaneState(session, pane);
  if (!observed.ok) fail(`${observed.reason}; create a fresh isolated lane instead of attaching stale state.`);
  const worktree = expectedWorktree(item);
  if (observed.cwd !== worktree) fail(`tmux pane cwd mismatch for ${item.id}: expected ${worktree}, observed ${observed.cwd}. Do not attach a different lane.`);
  const at = now();
  item.tmuxSession = session;
  item.dispatch = { ...item.dispatch, status: "attached", session, pane: observed.target, worktree, attachedAt: at };
  item.phase = "implementing";
  item.heartbeatDueAt = deadline;
  item.nextActionDueAt = deadline;
  item.lastEvidence = { at, detail: evidence };
  event(state, { at, laneId: item.id, kind: "development_dispatch_attached", evidence });
  save(stateFile, state);
  print({ lane: item, event: state.events.at(-1) });
} else if (command === "authorize-immediate-release") {
  const item = lane(state);
  const artifact = arg("--artifact");
  const authorization = arg("--authorization");
  const expiresAt = arg("--expires-at");
  const at = now();
  if (!artifact.trim() || !authorization.trim()) fail("authorize-immediate-release requires --artifact and --authorization.");
  iso(expiresAt, "--expires-at");
  if (Date.parse(expiresAt) <= Date.parse(at)) fail("--expires-at must be in the future.");
  const override = { issue: item.issue, artifact, authorization, authorizedAt: at, expiresAt, status: "active" };
  state.releasePolicy.incidentOverrides = state.releasePolicy.incidentOverrides.filter((candidate) =>
    !(candidate.issue === item.issue && candidate.status === "active")
  );
  state.releasePolicy.incidentOverrides.push(override);
  item.nextAction = `Run the exact-artifact release gate immediately for ${artifact}; promote only if every required gate and rollback anchor pass.`;
  item.nextActionDueAt = expiresAt;
  event(state, { at, laneId: item.id, kind: "immediate_release_authorized", evidence: authorization });
  save(stateFile, state);
  print({ lane: item, override, event: state.events.at(-1) });
} else if (command === "verify") {
  const item = lane(state);
  const name = arg("--gate");
  const status = arg("--status");
  const commandEvidence = arg("--command", "");
  const evidence = arg("--evidence", "");
  const artifact = arg("--artifact", "");
  const deadline = arg("--due");
  const journeyRaw = arg("--journey");
  const requiredRaw = arg("--required");
  if (!verificationNames.includes(name)) fail(`Unknown verification gate: ${name}.`);
  if (!verificationStatuses.includes(status)) fail(`Unknown verification status: ${status}.`);
  if (deadline) iso(deadline, "--due");
  if (["passed", "failed"].includes(status) && (!commandEvidence.trim() || !evidence.trim() || !artifact.trim())) fail("Passed or failed verification requires --command, --evidence, and --artifact.");
  if (status === "running" && !deadline) fail("A running verification requires --due.");
  let journey = null;
  if (journeyRaw) {
    try { journey = JSON.parse(journeyRaw); }
    catch { fail("--journey must be valid JSON."); }
  }
  if (name === "staging_uat" && status === "passed") validateJourney(journey, item.id);
  const gate = gateFor(item, name);
  const at = now();
  Object.assign(gate, { status, updatedAt: at, command: commandEvidence || null, evidence: evidence || null, artifact: artifact || null, dueAt: status === "running" ? deadline : null, journey });
  if (requiredRaw !== null) {
    if (!['true', 'false'].includes(requiredRaw)) fail("--required must be true or false.");
    if (name === "staging_uat" && requiredRaw === "false") fail("staging_uat is mandatory for every product issue and cannot be waived.");
    gate.required = requiredRaw === 'true';
  }
  if (status === "failed") {
    item.phase = "blocked";
    item.blocker = `verification_failed:${name}: ${evidence}`;
    event(state, { at, laneId: item.id, kind: "verification_failed", evidence: item.blocker });
  } else {
    event(state, { at, laneId: item.id, kind: `verification_${status}`, evidence: `${name}: ${evidence || "state recorded"}` });
  }
  save(stateFile, state);
  print({ lane: item, verification: gate, event: state.events.at(-1) });
} else if (command === "record-contract-check") {
  const item = lane(state);
  const validation = arg("--validation");
  const status = arg("--status");
  const evidence = arg("--evidence");
  const artifact = arg("--artifact");
  if (!item.executionContract) fail(`Lane ${item.id} has no execution contract.`);
  if (!['passed', 'failed'].includes(status) || !evidence.trim() || !artifact.trim()) fail("record-contract-check requires --status passed|failed, --evidence, and --artifact.");
  const check = contractChecks(item).find((candidate) => candidate.validation === validation);
  if (!check) fail(`Validation is not in the execution contract for ${item.id}.`);
  const at = now();
  Object.assign(check, { status, evidence, artifact, updatedAt: at });
  item.lastEvidence = { at, detail: `Execution-contract validation ${status}: ${validation}; ${evidence}` };
  event(state, { at, laneId: item.id, kind: `execution_contract_${status}`, evidence: item.lastEvidence.detail });
  save(stateFile, state);
  print({ lane: item, contractCheck: check, event: state.events.at(-1) });
} else if (command === "handoff-development") {
  const item = lane(state);
  print({ laneId: item.id, handoff: item.workStateId ? durableWorkStateContext(item) : handoffRecord(item) });
} else if (command === "upgrade-development-contract") {
  const item = lane(state);
  const at = now();
  const upgraded = upgradeDevelopmentContract(item, at);
  save(stateFile, state);
  print({ lane: upgraded, event: state.events.at(-1) });
} else if (command === "recover-development") {
  const item = lane(state);
  const at = now();
  const recovered = recoverDevelopment(item, at);
  save(stateFile, state);
  print({ lane: recovered, event: state.events.at(-1) });
} else if (command === "watch") {
  const at = now();
  const timestamp = Date.parse(at);
  const findings = portfolioFindings(state, at, process.argv.includes("--apply"));
  for (const item of state.lanes.filter((candidate) => candidate.active)) {
    const unhealthyDispatch = dispatchHealth(item);
    if (unhealthyDispatch) {
      const evidence = `development_dispatch_invalid:${unhealthyDispatch}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "development_dispatch_invalid", evidence, nextAction: "Create or attach the correct isolated tmux lane, then record literal pane/worktree evidence." });
      if (process.argv.includes("--apply")) {
        item.phase = "stalled";
        item.blocker = evidence;
        item.nextAction = "Create or attach the correct isolated tmux lane, then record literal pane/worktree evidence.";
        item.dispatch = { ...item.dispatch, status: "invalidated", invalidatedAt: at, invalidatedReason: unhealthyDispatch };
        event(state, { at, laneId: item.id, kind: "development_dispatch_invalid", evidence });
        if (process.argv.includes("--auto-recover") && item.dispatch.autoRecover && ["identified", "implementing", "tests-running", "pr-open", "review-blocked", "stalled"].includes(item.phase)) {
          try { recoverDevelopment(item, at); }
          catch (error) { event(state, { at, laneId: item.id, kind: "development_recovery_failed", evidence: String(error.message || error) }); }
        }
      }
      continue;
    }
    // The development adapter owns the terminal handoff. A known successor or
    // remediation cannot remain a sentence in nextAction after the triggering
    // evidence exists; it becomes a concrete, separately supervised packet.
    if (item.review.status === "actionable") {
      const template = developmentTemplate(item, "remediation");
      if (template) {
        const packet = process.argv.includes("--apply") ? developmentDispatch(state, item, "remediation", at, `Actionable review requires remediation: ${item.review.evidence}`) : { id: template.id, nextAction: template.nextAction };
        const evidence = `development_remediation_${process.argv.includes("--apply") ? "dispatched" : "ready"}:${packet.id}; source=${item.id}; reviewed_head=${item.review.head}`;
        findings.push({ issue: item.issue, phase: item.phase, kind: "development_remediation_dispatched", evidence, nextAction: packet.nextAction });
        if (process.argv.includes("--apply")) retireSource(item, at, evidence);
        continue;
      }
    }
    if (["merged", "production-verified", "completed"].includes(item.phase)) {
      const template = developmentTemplate(item, "successor");
      if (template) {
        const packet = process.argv.includes("--apply") ? developmentDispatch(state, item, "successor", at, `Terminal delivery evidence requires successor packet from ${item.id}.`) : { id: template.id, nextAction: template.nextAction };
        const evidence = `development_successor_${process.argv.includes("--apply") ? "dispatched" : "ready"}:${packet.id}; source=${item.id}; phase=${item.phase}`;
        findings.push({ issue: item.issue, phase: item.phase, kind: "development_successor_dispatched", evidence, nextAction: packet.nextAction });
        if (process.argv.includes("--apply")) retireSource(item, at, evidence);
        continue;
      }
    }
    // GitHub is an independent source of delivery truth.  A webhook or a
    // separate controller may merge/close work without touching this state
    // file; reconcile that fact before evaluating local deadlines.
    const remote = process.argv.includes("--skip-github") ? null : githubIssue(item);
    if (remote?.error) {
      const evidence = `github_reconciliation_failed:#${item.issue}: ${remote.error.slice(0, 300)}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "github_reconciliation_failed", evidence, nextAction: item.nextAction });
      if (process.argv.includes("--apply")) event(state, { at, laneId: item.id, kind: "github_reconciliation_failed", evidence });
    } else if (remote?.state === "CLOSED" && item.phase !== "merged" && item.phase !== "staged" && item.phase !== "production-verified") {
      const evidence = `GitHub issue #${item.issue} is closed${remote.closedAt ? ` at ${remote.closedAt}` : ""}; reconcile its merged delivery state before any release decision.`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "github_issue_closed", evidence, nextAction: "Record the merge commit, CI/review evidence, and the next authorized release-gate action." });
      if (process.argv.includes("--apply")) {
        item.phase = "merged";
        item.blocker = null;
        item.heartbeatDueAt = null;
        item.lastEvidence = { at, detail: evidence };
        item.nextAction = "Record the merge commit, CI/review evidence, and the next authorized release-gate action.";
        event(state, { at, laneId: item.id, kind: "github_issue_closed", evidence });
      }
      continue;
    }
    // A successful image build and a Container Apps deployment request are not
    // delivery evidence. Reconcile the requested revision itself so activation
    // failures cannot remain invisible behind traffic on an older revision.
    const staged = process.argv.includes("--skip-staging") ? null : stagingRevision(item);
    if (staged?.error) {
      const evidence = `staging_reconciliation_failed:#${item.issue}: ${staged.error.slice(0, 300)}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "staging_reconciliation_failed", evidence, nextAction: item.nextAction });
      if (process.argv.includes("--apply")) event(state, { at, laneId: item.id, kind: "staging_reconciliation_failed", evidence });
    } else if (staged && (staged.properties?.runningState === "ActivationFailed" || staged.properties?.healthState === "Unhealthy")) {
      const evidence = `staging_activation_failed: revision=${item.stagingDeployment.revision}; running=${staged.properties?.runningState ?? "unknown"}; health=${staged.properties?.healthState ?? "unknown"}; artifact=${item.stagingDeployment.artifact}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "staging_activation_failed", evidence, nextAction: "Inspect revision startup logs, remediate the exact image/source defect, and redeploy a new immutable artifact before rerunning staging gates." });
      if (process.argv.includes("--apply")) {
        item.phase = "blocked";
        item.blocker = evidence;
        item.nextAction = "Inspect revision startup logs, remediate the exact image/source defect, and redeploy a new immutable artifact before rerunning staging gates.";
        item.heartbeatDueAt = null;
        event(state, { at, laneId: item.id, kind: "staging_activation_failed", evidence });
      }
      continue;
    }
    if (item.review.status === "actionable" && Date.parse(item.review.dueAt) <= timestamp) {
      const evidence = `review_remediation_overdue: head=${item.review.head}; ${item.review.evidence}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "review_remediation_overdue", dueAt: item.review.dueAt, evidence, nextAction: item.nextAction });
      if (process.argv.includes("--apply")) {
        item.phase = "stalled";
        item.blocker = evidence;
        item.nextAction = `Immediately implement and verify the actionable review correction: ${item.nextAction}`;
        item.review.status = "overdue";
        item.review.dueAt = null;
        event(state, { at, laneId: item.id, kind: "review_remediation_overdue", evidence });
      }
    }
    for (const gate of item.verifications.filter((candidate) => candidate.status === "running" && candidate.dueAt && Date.parse(candidate.dueAt) <= timestamp)) {
      const evidence = `verification_overdue:${gate.name}; last recorded command: ${gate.command ?? "none"}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "verification_overdue", gate: gate.name, dueAt: gate.dueAt, evidence, nextAction: item.nextAction });
      if (process.argv.includes("--apply")) {
        item.phase = "stalled";
        item.blocker = evidence;
        item.nextAction = `Immediately inspect ${gate.name}, record its result or remediate the failure: ${item.nextAction}`;
        gate.dueAt = null;
        event(state, { at, laneId: item.id, kind: "verification_overdue", evidence });
      }
    }
    const stagedArtifact = item.stagingDeployment?.artifact;
    const sourceArtifact = item.releaseCandidate?.sourceArtifact;
    const override = item.phase === "staged" && stagedArtifact ? activeIncidentOverride(item, stagedArtifact, at) : null;
    if (override && missingProductionGates(item, stagedArtifact, sourceArtifact).length === 0 && item.immediateReleaseReadyFor !== stagedArtifact) {
      const evidence = `Immediate critical-incident release is authorized for exact artifact ${stagedArtifact}; all required pre-production gates are recorded as passed. Authorization: ${override.authorization}`;
      findings.push({ issue: item.issue, phase: item.phase, kind: "immediate_release_ready", evidence, nextAction: `Promote ${stagedArtifact} now, run production smoke, and record the rollback anchor and production verification.` });
      if (process.argv.includes("--apply")) {
        item.immediateReleaseReadyFor = stagedArtifact;
        item.nextAction = `Promote ${stagedArtifact} now, run production smoke, and record the rollback anchor and production verification.`;
        item.nextActionDueAt = override.expiresAt;
        event(state, { at, laneId: item.id, kind: "immediate_release_ready", evidence });
      }
    }
    const due = item.heartbeatDueAt ?? item.nextActionDueAt;
    if (!due || Date.parse(due) > timestamp || ["production-verified", "blocked"].includes(item.phase)) continue;
    const kind = item.heartbeatDueAt ? "heartbeat_missed" : "next_action_overdue";
    const evidence = item.lastEvidence?.detail ?? "No branch, commit, test, or PR evidence recorded.";
    findings.push({ issue: item.issue, phase: item.phase, kind, dueAt: due, evidence, nextAction: item.nextAction });
    if (process.argv.includes("--apply")) {
      item.phase = "stalled";
      item.blocker = `${kind}: ${evidence}`;
      // Prefix once, not once per pass. This field reached 1775 characters and
      // 51 stacked copies of the same sentence on astellen-eeoc-404.
      const urgent = "Immediately inspect and execute: ";
      if (!String(item.nextAction ?? "").startsWith(urgent)) item.nextAction = `${urgent}${item.nextAction}`;
      // Disarm BOTH deadlines. A stall is a one-shot escalation, not a repeating
      // alarm. Leaving nextActionDueAt set re-entered this branch on every watch
      // pass; each pass minted a new event id, which changed the trigger
      // fingerprint in watch-trigger.js, which started a fresh agent turn — every
      // five minutes, indefinitely, on a lane already known to be stalled.
      // Re-arming is now an explicit act (record-*/attach-development/recovery).
      item.heartbeatDueAt = null;
      item.nextActionDueAt = null;
      item.stalledAt = at;
      event(state, { at, laneId: item.id, kind, evidence: item.blocker });
    }
  }
  if (!process.argv.includes("--skip-tmux")) {
    // Findings only, no event: a reaped idle session needs no agent turn.
    for (const session of idleTmuxSessions(state, timestamp, Number(arg("--tmux-idle-hours", "24")))) {
      findings.push({ issue: null, phase: null, kind: "tmux_session_reaped", evidence: `${session.name} idle ${session.idleHours.toFixed(1)}h`, nextAction: null });
      if (process.argv.includes("--apply")) try { execFileSync("tmux", ["kill-session", "-t", `=${session.name}`], { stdio: "ignore", timeout: 5000 }); } catch {}
    }
  }
  if (process.argv.includes("--apply")) save(stateFile, state);
  print({ at, findings, pendingEvents: state.events.filter((e) => e.notification === "pending") });
} else if (command === "ack-events") {
  const eventIds = new Set((arg("--ids", "")).split(",").filter(Boolean));
  if (eventIds.size === 0) fail("ack-events requires --ids id[,id].");
  for (const item of state.events) if (eventIds.has(item.id)) item.notification = "sent";
  save(stateFile, state);
  print({ acknowledged: [...eventIds] });
} else if (command === "release-gate") {
  const manifestFile = arg("--manifest");
  const candidateRaw = arg("--candidate");
  if (!candidateRaw && !manifestFile) fail("release-gate requires --manifest for an active release train or explicit --candidate JSON.");
  let candidate;
  const item = lane(state);
  if (manifestFile) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); }
    catch (error) { fail(`Unable to read release manifest ${manifestFile}: ${error.message}`); }
    candidate = manifestCandidate(item, manifest);
  } else {
    try { candidate = JSON.parse(candidateRaw); }
    catch { fail("release-gate --candidate must be valid JSON."); }
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail("release-gate --candidate must be a JSON object.");
  }
  const required = state.releasePolicy.productionRequirements;
  const missing = required.filter((key) => candidate[key] !== true);
  const artifact = candidate.artifact;
  const sourceArtifact = candidate.sourceArtifact;
  if (!artifact) missing.push("artifact");
  if (candidate.artifact_lineage_verified !== true) missing.push("artifact_lineage_verified");
  const verificationMissing = artifact ? missingProductionGates(item, artifact, sourceArtifact) : preProductionGates;
  const mode = arg("--mode", "nightly");
  if (!["nightly", "immediate"].includes(mode)) fail("--mode must be nightly or immediate.");
  const override = mode === "immediate" && artifact ? activeIncidentOverride(item, artifact, now()) : null;
  if (mode === "immediate" && !override) missing.push("active_explicit_critical_incident_authorization");
  print({ eligible: missing.length === 0 && verificationMissing.length === 0, window: mode === "immediate" ? "explicit critical-incident override" : "02:00 America/New_York", mode, authorization: override ? { authorizedAt: override.authorizedAt, expiresAt: override.expiresAt, evidence: override.authorization } : null, missing, verificationMissing, candidate });
} else {
  fail("Usage: harness.mjs <status|register-lane|operational-report|transition|observe|record-review|dispatch-development|attach-development|recover-development|handoff-development|upgrade-development-contract|authorize-immediate-release|verify|record-contract-check|watch|ack-events|release-gate> [options]");
}
