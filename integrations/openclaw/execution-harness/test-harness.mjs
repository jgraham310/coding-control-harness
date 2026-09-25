#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(dir, "harness.mjs");
const verificationNames = ["typecheck_lint", "build", "targeted_tests", "full_suite", "staging_health", "staging_smoke", "staging_uat"];
const prePrGates = ["typecheck_lint", "build", "targeted_tests"];
const headArtifact = `git:${"a".repeat(40)}`;
// realpath: macOS /var is a symlink to /private/var, which tmux reports.
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-harness-")));
const state = path.join(temp, "state.json");
// Synthetic fixture: repository tests never ingest the operator's live ledger.
const fixture = {
  schemaVersion: 2,
  portfolio: { repositories: [
    { id: "civicline", repository: "jgraham310/local-government" },
    { id: "astellen", repository: "jgraham310/astellen" },
    { id: "tems", repository: "jgraham310/tems" },
    { id: "coding-control", repository: "jgraham310/coding-control-harness" }
  ] },
  releasePolicy: { productionPromotion: "nightly_0200_et_or_explicit_critical_incident_override", productionRequirements: ["eligible_merged_prs", "required_ci_green", "codex_zero_actionable_findings", "artifact_lineage_verified", "staging_smoke_on_exact_artifact", "rollback_anchor", "no_active_release_hold"], incidentOverrides: [] },
  events: [],
  lanes: [{
    id: "civicline-2540", issue: 2540, repository: "jgraham310/local-government", title: "Synthetic readiness packet",
    phase: "implementing", active: true, adapter: "development", owner: "test", priority: "P1",
    branch: "feat/synthetic", worktree: "/tmp/synthetic", pullRequest: null,
    stagingDeployment: { provider: "azure-container-apps", app: "synthetic", resourceGroup: "synthetic", revision: "synthetic--0001", artifact: "sha256:test" },
    successPredicate: "Synthetic readiness works.", nextAction: "Run synthetic verification.",
    heartbeatDueAt: "2026-08-15T14:00:00-04:00", nextActionDueAt: "2026-08-15T14:00:00-04:00",
    lastEvidence: { at: "2026-08-15T12:00:00-04:00", detail: "Fixture initialized." }, blocker: null,
    review: { status: "unreviewed", head: null, evidence: null, dueAt: null, updatedAt: null },
    verifications: verificationNames.map((name) => ({ name, required: name === "full_suite" || name === "staging_uat", status: name === "full_suite" ? "running" : "skipped", updatedAt: "2026-08-15T12:00:00-04:00", command: null, evidence: null, artifact: null, dueAt: name === "full_suite" ? "2026-08-15T14:00:00Z" : null, journey: null }))
  }]
};
fs.writeFileSync(state, `${JSON.stringify(fixture, null, 2)}\n`);
function run(...args) { return JSON.parse(execFileSync("node", [harness, ...args, "--state", state, "--skip-github", "--skip-staging"], { encoding: "utf8" })); }

const initial = run("status");
assert.equal(initial.lanes[0].phase, "implementing");
const migrated = run("migrate-workstates", "--at", "2026-08-15T12:45:00-04:00");
assert.deepEqual(migrated.migrated, [{ laneId: "civicline-2540", workStateId: "lane:civicline-2540" }]);
const migratedRuntime = JSON.parse(fs.readFileSync(`${state}.work-state.json`, "utf8"));
assert.equal(migratedRuntime.records["lane:civicline-2540"].phase, "active");
assert.equal(run("status").lanes[0].workStateId, "lane:civicline-2540");
const scopeMismatch = run("watch", "--at", "2026-08-15T12:46:00-04:00");
assert.equal(scopeMismatch.findings.filter((finding) => finding.kind === "portfolio_scope_mismatch").length, 3);
run("register-lane", "--id", "astellen-reconcile", "--repository", "jgraham310/astellen", "--title", "Reconcile Astellen", "--objective", "Astellen has a recorded delivery packet.", "--next-action", "Inspect live evidence and select the next packet.", "--due", "2026-08-15T14:00:00-04:00", "--at", "2026-08-15T12:46:30-04:00");
run("register-lane", "--id", "tems-reconcile", "--repository", "jgraham310/tems", "--title", "Reconcile TEMS", "--objective", "TEMS has a recorded delivery packet.", "--next-action", "Inspect live evidence and select the next packet.", "--due", "2026-08-15T14:00:00-04:00", "--at", "2026-08-15T12:46:31-04:00");
run("register-lane", "--id", "coding-control-reconcile", "--repository", "jgraham310/coding-control-harness", "--title", "Reconcile coding control", "--objective", "Coding-control harness has a recorded delivery packet.", "--next-action", "Inspect live evidence and select the next packet.", "--due", "2026-08-15T14:00:00-04:00", "--at", "2026-08-15T12:46:32-04:00");
const evidencedReport = run("operational-report", "--lanes", "civicline-2540,astellen-reconcile,tems-reconcile,coding-control-reconcile", "--summary", "All portfolio lanes are registered with evidence and continuation deadlines.", "--at", "2026-08-15T12:46:33-04:00");
assert.equal(evidencedReport.report.lanes.length, 4);
const overdue = run("watch", "--apply", "--at", "2026-08-15T12:47:00-04:00");
assert.equal(overdue.findings.some((finding) => finding.kind === "verification_overdue"), true);
assert.equal(run("status").lanes[0].phase, "stalled");
const resumed = run("transition", "--issue", "2540", "--to", "implementing", "--evidence", "worktree /tmp/lg-2540 exists at SHA abc123", "--heartbeat-due", "2026-08-15T13:15:00-04:00", "--at", "2026-08-15T13:00:00-04:00");
assert.equal(resumed.lane.phase, "implementing");
const reviewHold = run("record-review", "--issue", "2540", "--status", "actionable", "--head", "git:abc123", "--evidence", "required readiness check can be bypassed by a stale live plan", "--next-action", "correct the condition and add a regression test", "--due", "2026-08-15T13:01:00-04:00", "--at", "2026-08-15T13:00:00-04:00");
assert.equal(reviewHold.lane.phase, "review-blocked");
const reviewWatch = run("watch", "--apply", "--at", "2026-08-15T13:02:00-04:00");
assert.equal(reviewWatch.findings.some((finding) => finding.kind === "review_remediation_overdue"), true);
assert.equal(run("status").lanes[0].phase, "stalled");
run("transition", "--issue", "2540", "--to", "implementing", "--evidence", "review blocker dispatched for correction", "--heartbeat-due", "2026-08-15T13:20:00-04:00", "--at", "2026-08-15T13:03:00-04:00");
const overdueVerification = run("verify", "--issue", "2540", "--gate", "build", "--status", "running", "--command", "npm run build", "--evidence", "build started", "--artifact", "sha256:test", "--due", "2026-08-15T13:01:00-04:00", "--at", "2026-08-15T13:00:00-04:00");
assert.equal(overdueVerification.verification.status, "running");
const verificationWatch = run("watch", "--apply", "--at", "2026-08-15T13:02:00-04:00");
assert.equal(verificationWatch.findings.some((finding) => finding.kind === "verification_overdue" && finding.gate === "build"), true);
assert.equal(run("status").lanes[0].phase, "stalled");
run("transition", "--issue", "2540", "--to", "implementing", "--evidence", "build timeout inspected and lane resumed", "--heartbeat-due", "2026-08-15T13:20:00-04:00", "--at", "2026-08-15T13:03:00-04:00");
for (const name of ["typecheck_lint", "build", "targeted_tests", "full_suite", "staging_health", "staging_smoke"]) {
  const artifact = ["typecheck_lint", "build", "targeted_tests", "full_suite"].includes(name) ? "git:test" : "sha256:test";
  const result = run("verify", "--issue", "2540", "--gate", name, "--status", "passed", "--command", `verify ${name}`, "--evidence", `${name} passed`, "--artifact", artifact, "--at", "2026-08-15T13:04:00-04:00");
  assert.equal(result.verification.status, "passed");
}
const uatJourney = JSON.stringify({ schemaVersion: 2, persona: "staging clerk", roleRationale: "The issue changes the clerk readiness workflow.", startingState: "incomplete staging tenant", syntheticData: "disposable staging tenant and clerk account", actions: ["sign in", "open readiness"], expectedOutcome: "readiness page", forbiddenOutcomes: ["live workspace", "browser errors"], complianceChecks: ["required readiness controls remain enforced"], observedOutcome: "readiness page rendered", evidenceArtifacts: ["screenshot", "browser trace"], browserErrors: [] });
const uat = run("verify", "--issue", "2540", "--gate", "staging_uat", "--status", "passed", "--command", "playwright staging UAT", "--evidence", "journey completed without browser errors", "--artifact", "sha256:test", "--journey", uatJourney, "--at", "2026-08-15T13:04:00-04:00");
assert.equal(uat.verification.status, "passed");
const candidate = { artifact: "sha256:test", sourceArtifact: "git:test", artifact_lineage_verified: true, eligible_merged_prs: true, required_ci_green: true, codex_zero_actionable_findings: true, staging_smoke_on_exact_artifact: true, rollback_anchor: true, no_active_release_hold: true };
const gate = run("release-gate", "--issue", "2540", "--candidate", JSON.stringify(candidate));
assert.equal(gate.eligible, true);
const immediateDenied = run("release-gate", "--issue", "2540", "--mode", "immediate", "--candidate", JSON.stringify(candidate));
assert.equal(immediateDenied.eligible, false);
assert.equal(immediateDenied.missing.includes("active_explicit_critical_incident_authorization"), true);
run("authorize-immediate-release", "--issue", "2540", "--artifact", "sha256:test", "--authorization", "Jason explicitly authorized an immediate critical-incident release", "--expires-at", "2026-08-16T18:00:00-04:00", "--at", "2026-08-15T13:05:00-04:00");
const immediateAllowed = run("release-gate", "--issue", "2540", "--mode", "immediate", "--candidate", JSON.stringify(candidate), "--at", "2026-08-15T13:05:30-04:00");
assert.equal(immediateAllowed.eligible, true);
assert.equal(immediateAllowed.window, "explicit critical-incident override");
// A failed staging revision is a hard blocker even if traffic remains safely
// served by the prior revision. It must become a pending material event.
const stagingFailure = JSON.stringify({ properties: { runningState: "ActivationFailed", healthState: "Unhealthy" } });
const staged = JSON.parse(execFileSync("node", [harness, "watch", "--state", state, "--skip-github", "--apply", "--staging-report", stagingFailure, "--at", "2026-08-15T13:05:00-04:00"], { encoding: "utf8" }));
assert.equal(staged.findings.some((finding) => finding.kind === "staging_activation_failed"), true);
assert.equal(run("status").lanes[0].phase, "blocked");

// Terminal delivery is not an idle state. The development adapter must turn a
// completed source packet into a separately supervised successor, then turn an
// actionable review on that successor into a concrete remediation packet.
const terminalFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const source = terminalFixture.lanes[0];
source.phase = "merged";
source.active = true;
source.blocker = null;
source.review = { status: "clear", head: "git:test", evidence: "review clear", dueAt: null, updatedAt: "2026-08-15T13:06:00-04:00" };
source.development = {
  successor: {
    id: "test-successor", issue: 9001, title: "Successor packet", objective: "Implement the next bounded delivery slice.",
    branch: "feat/test-successor", worktree: "test-successor", gatesFile: "GATES.md", verificationCommand: "node --test",
    nextAction: "Start the bounded implementation packet and record its first evidence.", due: "2026-08-15T14:00:00-04:00"
  }
};
fs.writeFileSync(state, `${JSON.stringify(terminalFixture, null, 2)}\n`);
const successorWatch = run("watch", "--apply", "--at", "2026-08-15T13:07:00-04:00");
assert.equal(successorWatch.findings.some((finding) => finding.kind === "development_successor_dispatched"), true);
let adapterState = run("status");
const successor = adapterState.lanes.find((item) => item.id === "test-successor");
assert.equal(successor.dispatch.status, "ready");
assert.deepEqual(successor.verifications.filter((gate) => prePrGates.includes(gate.name)).map((gate) => gate.required), [true, true, true]);
assert.equal(successor.verifications.every((gate) => gate.required), true, "generated packets retain every pre-production gate");
assert.equal(successor.gatesFile, "GATES.md");
assert.equal(successor.executionContract.validation[0], "node --test");
assert.equal(successor.dispatch.command.includes("Do not weaken, skip, or narrow tests"), true);
assert.equal(successor.workStateId, "lane:test-successor");
const workStateRuntime = JSON.parse(fs.readFileSync(`${state}.work-state.json`, "utf8"));
assert.equal(workStateRuntime.records[successor.workStateId].objective, "Implement the next bounded delivery slice.");
const contractCheck = run("record-contract-check", "--lane", "test-successor", "--validation", "node --test", "--status", "passed", "--evidence", "focused contract suite passed", "--artifact", "git:test-successor", "--at", "2026-08-15T13:07:30-04:00");
assert.equal(contractCheck.contractCheck.status, "passed");
const workStateHandoff = run("handoff-development", "--lane", "test-successor").handoff;
assert.equal(workStateHandoff.goal, "Implement the next bounded delivery slice.");
assert.equal(workStateHandoff.workState.id, "lane:test-successor");

// The contract is a gate, not metadata: even with ordinary pre-PR checks
// recorded, a packet cannot reach PR-open until its exact declared validation
// is evidenced against an artifact.
const enforcementFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const enforcementSource = enforcementFixture.lanes.find((item) => item.id === "test-successor");
enforcementFixture.lanes.push({ ...enforcementSource, id: "test-contract-enforcement", issue: 9004, title: "Contract enforcement", phase: "tests-running", dispatch: null, contractChecks: enforcementSource.executionContract.validation.map((validation) => ({ validation, status: "pending", evidence: null, artifact: null, updatedAt: null })), verifications: enforcementSource.verifications.map((gate) => prePrGates.includes(gate.name) ? ({ ...gate, required: true, status: "passed", command: `verify ${gate.name}`, evidence: `${gate.name} passed`, artifact: headArtifact }) : gate) });
fs.writeFileSync(state, `${JSON.stringify(enforcementFixture, null, 2)}\n`);
assert.throws(() => run("transition", "--lane", "test-contract-enforcement", "--to", "pr-open", "--head", headArtifact, "--evidence", "ordinary gates passed", "--at", "2026-08-15T13:07:40-04:00"), /execution-contract validation is incomplete/);
run("record-contract-check", "--lane", "test-contract-enforcement", "--validation", "node --test", "--status", "passed", "--evidence", "contract suite passed", "--artifact", headArtifact, "--at", "2026-08-15T13:07:41-04:00");
assert.equal(run("transition", "--lane", "test-contract-enforcement", "--to", "pr-open", "--head", headArtifact, "--evidence", "all contract and ordinary gates passed", "--at", "2026-08-15T13:07:42-04:00").lane.phase, "pr-open");
assert.throws(() => run("transition", "--lane", "test-contract-enforcement", "--to", "pr-open", "--head", `git:${"b".repeat(40)}`, "--evidence", "stale gates", "--at", "2026-08-15T13:07:42-04:00"), /Illegal transition/);
const missingPrePr = JSON.parse(fs.readFileSync(state, "utf8"));
const enforcement = missingPrePr.lanes.find((item) => item.id === "test-contract-enforcement");
missingPrePr.lanes.push({ ...enforcement, id: "test-missing-prepr", issue: 9005, phase: "tests-running", verifications: enforcement.verifications.map((gate) => gate.name === "targeted_tests" ? { ...gate, status: "skipped" } : gate) });
fs.writeFileSync(state, `${JSON.stringify(missingPrePr, null, 2)}\n`);
assert.throws(() => run("transition", "--lane", "test-missing-prepr", "--to", "pr-open", "--head", headArtifact, "--evidence", "attempted without targeted tests", "--at", "2026-08-15T13:07:43-04:00"), /required verification gates not passed: targeted_tests/);
missingPrePr.lanes.push({ ...enforcement, id: "test-stale-head", issue: 9006, phase: "tests-running" });
missingPrePr.lanes.push({ ...enforcement, id: "test-stale-contract", issue: 9007, phase: "tests-running", contractChecks: enforcement.contractChecks.map((check) => ({ ...check, artifact: `git:${"b".repeat(40)}` })) });
fs.writeFileSync(state, `${JSON.stringify(missingPrePr, null, 2)}\n`);
assert.throws(() => run("transition", "--lane", "test-stale-head", "--to", "pr-open", "--head", `git:${"b".repeat(40)}`, "--evidence", "different candidate head", "--at", "2026-08-15T13:07:44-04:00"), /required verification gates not passed/);
assert.throws(() => run("transition", "--lane", "test-stale-contract", "--to", "pr-open", "--head", headArtifact, "--evidence", "stale contract check", "--at", "2026-08-15T13:07:45-04:00"), /execution-contract validation is incomplete for the exact head/);
assert.equal(adapterState.lanes[0].active, false);

const remediationFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const successorRecord = remediationFixture.lanes.find((item) => item.id === "test-successor");
successorRecord.development = {
  remediation: {
    id: "test-remediation", issue: 9002, title: "Review remediation", objective: "Correct the verified review finding and prove the regression is fixed.",
    branch: "fix/test-remediation", worktree: "test-remediation", gatesFile: "GATES.md", verificationCommand: "node --test",
    nextAction: "Implement the correction, run its verification command, and package the repaired PR.", due: "2026-08-15T14:00:00-04:00"
  }
};
fs.writeFileSync(state, `${JSON.stringify(remediationFixture, null, 2)}\n`);
const dispatched = run("record-review", "--lane", "test-successor", "--status", "actionable", "--head", "git:test-successor", "--evidence", "verified regression in successor", "--next-action", "correct regression", "--due", "2026-08-15T13:20:00-04:00", "--at", "2026-08-15T13:08:00-04:00");
assert.equal(dispatched.dispatched[0].id, "test-remediation");
adapterState = run("status");
assert.equal(adapterState.lanes.find((item) => item.id === "test-remediation").dispatch.status, "ready");
assert.equal(adapterState.lanes.find((item) => item.id === "test-successor").active, false);

// An attached lane is valid only while its literal tmux session/pane evidence
// remains true. A vanished session must not leave a fictional live executor.
const dispatchFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const remediation = dispatchFixture.lanes.find((item) => item.id === "test-remediation");
remediation.dispatch = { ...remediation.dispatch, status: "attached", session: "execution-harness-missing-session", pane: "execution-harness-missing-session:0.0", worktree: "/tmp/execution-harness-missing", attachedAt: "2026-08-15T13:09:00-04:00" };
fs.writeFileSync(state, `${JSON.stringify(dispatchFixture, null, 2)}\n`);
const invalidDispatch = run("watch", "--apply", "--at", "2026-08-15T13:10:00-04:00");
assert.equal(invalidDispatch.findings.some((finding) => finding.kind === "development_dispatch_invalid"), true);
adapterState = run("status");
assert.equal(adapterState.lanes.find((item) => item.id === "test-remediation").dispatch.status, "invalidated");
assert.equal(adapterState.lanes.find((item) => item.id === "test-remediation").phase, "stalled");

// Recovery is an actual executor-loss proof, not a mocked field update. A
// recoverable packet must create a fresh tmux lane, reattach only after literal
// cwd verification, and carry the state-derived handoff into recovery metadata.
const recoveryFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const recoveryWorktree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "execution-harness-recovery-worktree-")));
const recoverySession = `execution-harness-recovery-${process.pid}`;
recoveryFixture.lanes.push({
  id: "test-recovery", issue: 9003, repository: "jgraham310/local-government", priority: "P1", title: "Recovery packet",
  phase: "implementing", active: true, adapter: "development", owner: "Claude Code", branch: "fix/test-recovery", worktree: recoveryWorktree,
  tmuxSession: recoverySession, pullRequest: null, successPredicate: "Resume safely after executor loss.", nextAction: "Continue the bounded packet.",
  nextActionDueAt: "2026-08-15T14:00:00-04:00", heartbeatDueAt: "2026-08-15T14:00:00-04:00", lastEvidence: { at: "2026-08-15T13:11:00-04:00", detail: "Executor loss was observed." }, blocker: "development_dispatch_invalid", verifications: verificationNames.map((name) => ({ name, required: false, status: "skipped", updatedAt: "2026-08-15T13:11:00-04:00", command: null, evidence: "Not applicable.", artifact: null, dueAt: null, journey: null })), review: { status: "unreviewed", head: null, evidence: null, dueAt: null, updatedAt: null },
  executionContract: { objective: "Resume safely after executor loss.", constraints: ["No unrelated changes."], validation: ["node --test"], stopCondition: "Recovery evidence is recorded.", checkpointCadence: "PT5M" }, contractChecks: [{ validation: "node --test", status: "pending", evidence: null, artifact: null, updatedAt: null }],
  dispatch: { status: "invalidated", transport: "tmux", executor: "test", command: "sleep 30", autoRecover: true, session: recoverySession, pane: `${recoverySession}:0.0`, worktree: recoveryWorktree, invalidatedAt: "2026-08-15T13:11:00-04:00", invalidatedReason: "simulated executor loss" }
});
fs.writeFileSync(state, `${JSON.stringify(recoveryFixture, null, 2)}\n`);
try {
  const recovered = JSON.parse(execFileSync("node", [harness, "recover-development", "--lane", "test-recovery", "--state", state, "--at", "2026-08-15T13:12:00-04:00"], { encoding: "utf8" }));
  assert.equal(recovered.lane.dispatch.status, "attached");
  assert.equal(recovered.lane.dispatch.recoveryCount, 1);
  assert.equal(recovered.lane.dispatch.handoff.currentState.phase, "implementing");
  assert.equal(recovered.lane.dispatch.worktree, recoveryWorktree);
} finally {
  try { execFileSync("tmux", ["kill-session", "-t", recoverySession], { stdio: "ignore" }); } catch {}
}
console.log("development adapter transition tests: passed");

// Idle tmux sessions are reaped unless an active lane owns them. A private tmux
// server (TMUX_TMPDIR) keeps this from ever touching the operator's sessions.
const tmuxEnv = { ...process.env, TMUX_TMPDIR: temp };
const tmux = (...args) => execFileSync("tmux", args, { env: tmuxEnv, encoding: "utf8" });
tmux("new-session", "-d", "-s", "reap-me", "sleep 600");
tmux("new-session", "-d", "-s", recoverySession, "sleep 600");
try {
  const later = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const reaped = JSON.parse(execFileSync("node", [harness, "watch", "--apply", "--state", state, "--skip-github", "--skip-staging", "--at", later], { env: tmuxEnv, encoding: "utf8" }));
  assert.deepEqual(reaped.findings.filter((finding) => finding.kind === "tmux_session_reaped").map((finding) => finding.evidence.split(" ")[0]), ["reap-me"]);
  assert.deepEqual(tmux("list-sessions", "-F", "#{session_name}").trim().split("\n"), [recoverySession]);
} finally {
  try { tmux("kill-server"); } catch {}
}
console.log("tmux reaper tests: passed");
console.log("execution-harness tests: passed");

// A closed issue without merge evidence cannot produce a merged lane or dispatch.
const closedState = path.join(temp, "closed-issue.json");
fs.writeFileSync(closedState, `${JSON.stringify(fixture, null, 2)}\n`);
const fakeBin = path.join(temp, "fake-bin");
fs.mkdirSync(fakeBin);
const fakeGh = path.join(fakeBin, "gh");
fs.writeFileSync(fakeGh, "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"CLOSED\",\"closedAt\":\"2026-08-15T13:00:00Z\"}'\n");
fs.chmodSync(fakeGh, 0o755);
const closed = JSON.parse(execFileSync("node", [harness, "watch", "--apply", "--state", closedState, "--skip-staging", "--skip-tmux", "--at", "2026-08-15T13:05:00-04:00"], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, encoding: "utf8" }));
assert.equal(closed.findings.some((finding) => finding.kind === "github_issue_closed_unverified"), true);
assert.equal(JSON.parse(fs.readFileSync(closedState, "utf8")).lanes[0].phase, "blocked");

const lockState = path.join(temp, "locked.json");
fs.writeFileSync(lockState, `${JSON.stringify(fixture, null, 2)}\n`);
fs.mkdirSync(`${lockState}.lockdir`);
fs.writeFileSync(path.join(`${lockState}.lockdir`, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
assert.throws(() => JSON.parse(execFileSync("node", [harness, "status", "--state", lockState], { encoding: "utf8" })), /State is busy/);
fs.rmSync(`${lockState}.lockdir`, { recursive: true });
fs.mkdirSync(`${lockState}.lockdir`);
fs.writeFileSync(path.join(`${lockState}.lockdir`, "owner.json"), JSON.stringify({ pid: 99999999, token: "stale" }));
assert.equal(JSON.parse(execFileSync("node", [harness, "status", "--state", lockState], { encoding: "utf8" })).lanes.length, 1);
assert.equal(fs.existsSync(`${lockState}.lockdir`), false);
fs.mkdirSync(`${lockState}.work-state.json.lockdir`);
fs.writeFileSync(path.join(`${lockState}.work-state.json.lockdir`, "owner.json"), JSON.stringify({ pid: process.pid, token: "held" }));
assert.throws(() => JSON.parse(execFileSync("node", [harness, "migrate-workstates", "--state", lockState], { encoding: "utf8" })), /State is busy/);
assert.equal(JSON.parse(fs.readFileSync(lockState, "utf8")).lanes[0].workStateId, undefined);
fs.rmSync(`${lockState}.work-state.json.lockdir`, { recursive: true });

const staleState = path.join(temp, "stale-workstate.json");
const staleFixture = JSON.parse(fs.readFileSync(state, "utf8"));
const staleLane = staleFixture.lanes.find((item) => item.id === "test-successor");
staleLane.active = true;
staleLane.phase = "implementing";
staleLane.nextAction = "Changed after the durable WorkState snapshot.";
staleLane.worktree = temp;
staleLane.dispatch = { status: "attached", session: "missing-stale-workstate-session", pane: "missing-stale-workstate-session:0.0", worktree: temp, command: "sleep 1", autoRecover: true };
fs.writeFileSync(staleState, `${JSON.stringify(staleFixture, null, 2)}\n`);
const staleWatch = JSON.parse(execFileSync("node", [harness, "watch", "--apply", "--auto-recover", "--state", staleState, "--work-state", `${state}.work-state.json`, "--skip-github", "--skip-staging", "--at", "2026-08-15T13:15:00-04:00"], { encoding: "utf8" }));
assert.equal(staleWatch.findings.some((finding) => finding.kind === "development_dispatch_invalid"), true);
const staleSaved = JSON.parse(fs.readFileSync(staleState, "utf8"));
assert.equal(staleSaved.lanes.find((item) => item.id === "test-successor").dispatch.status, "invalidated");
assert.equal(staleSaved.events.some((entry) => entry.kind === "development_recovery_failed" && entry.evidence.includes("WorkState is stale")), true);

const terminalState = path.join(temp, "terminal.json");
const terminal = structuredClone(fixture);
terminal.lanes[0].phase = "production-verified";
terminal.lanes[0].active = true;
fs.writeFileSync(terminalState, `${JSON.stringify(terminal, null, 2)}\n`);
JSON.parse(execFileSync("node", [harness, "transition", "--issue", "2540", "--to", "completed", "--evidence", "synthetic production verification complete", "--state", terminalState], { encoding: "utf8" }));
const completed = JSON.parse(execFileSync("node", [harness, "status", "--state", terminalState], { encoding: "utf8" }));
assert.equal(completed.lanes[0].active, false);

const reviewedState = path.join(temp, "reviewed.json");
const reviewed = structuredClone(fixture);
reviewed.lanes[0].phase = "ci-green";
fs.writeFileSync(reviewedState, `${JSON.stringify(reviewed, null, 2)}\n`);
assert.throws(() => execFileSync("node", [harness, "transition", "--issue", "2540", "--to", "reviewed", "--head", headArtifact, "--evidence", "unverified claim", "--state", reviewedState], { encoding: "utf8" }), /clear exact-head review receipt/);
reviewed.lanes[0].review = { status: "clear", head: headArtifact, evidence: "zero actionable findings", dueAt: null, updatedAt: "2026-08-15T13:00:00Z" };
fs.writeFileSync(reviewedState, `${JSON.stringify(reviewed, null, 2)}\n`);
assert.equal(JSON.parse(execFileSync("node", [harness, "transition", "--issue", "2540", "--to", "reviewed", "--head", headArtifact, "--evidence", "exact review clear", "--state", reviewedState], { encoding: "utf8" })).lane.phase, "reviewed");

const mergedState = path.join(temp, "merged-executor.json");
const merged = structuredClone(fixture);
merged.lanes[0].phase = "merged";
merged.lanes[0].dispatch = { status: "attached", session: "missing-merged-executor", pane: "missing-merged-executor:0.0", worktree: temp, command: "sleep 1", autoRecover: true };
fs.writeFileSync(mergedState, `${JSON.stringify(merged, null, 2)}\n`);
execFileSync("node", [harness, "watch", "--apply", "--auto-recover", "--state", mergedState, "--skip-github", "--skip-staging"], { encoding: "utf8" });
assert.equal(JSON.parse(fs.readFileSync(mergedState, "utf8")).events.some((entry) => entry.kind === "development_recovered"), false);
