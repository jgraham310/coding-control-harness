#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateRuntime, workStateContext } from "./work-state.mjs";

const runtime = JSON.parse(fs.readFileSync(new URL("./work-state.json", import.meta.url), "utf8"));
validateRuntime(runtime);

for (const [agentId, workStateId] of [["civicline-cto", "cto:civicline"], ["tems-cto", "cto:tems"]]) {
  const root = `/Users/jasongraham/.openclaw/workspace-${agentId}`;
  const charter = JSON.parse(fs.readFileSync(`${root}/CHARTER.json`, "utf8"));
  const guidance = fs.readFileSync(`${root}/AGENTS.md`, "utf8");
  assert.equal(charter.schemaVersion, 2);
  assert.equal(charter.durableExecution.required, true);
  assert.equal(charter.durableExecution.workStateId, workStateId);
  const canonicalRuntime = "/Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/work-state.json";
  const expectedRuntime = agentId === "tems-cto"
    ? "/Users/jasongraham/.openclaw/workspace-tems-cto/.runtime/work-state.json"
    : canonicalRuntime;
  assert.equal(charter.durableExecution.runtime, expectedRuntime);
  if (agentId === "tems-cto") {
    const mirrored = JSON.parse(fs.readFileSync(expectedRuntime, "utf8"));
    assert.deepEqual(mirrored.records[workStateId], runtime.records[workStateId]);
    for (const evidenceRef of mirrored.records[workStateId].evidenceRefs) {
      assert.deepEqual(mirrored.evidence[evidenceRef], runtime.evidence[evidenceRef]);
    }
  } else {
    assert.equal(fs.realpathSync(charter.durableExecution.runtime), canonicalRuntime);
  }
  assert.deepEqual(charter.durableExecution.transitionControls, ["expected_version", "idempotency_key", "immutable_evidence"]);
  assert.match(guidance, /Do not\nreconstruct operational state from a transcript/);
  const context = workStateContext(runtime, workStateId);
  assert.equal(context.workState.owner, agentId);
  assert.equal(context.pendingActions.length, 0);
}

console.log("cto WorkState contract tests: passed");
