import assert from "node:assert/strict";
import { evaluateCtoCadence } from "../src/cto-cadence-gate.mjs";

// Redacted operational trace: 23 half-hour cycles, one unchanged blocked item.
const measuredTokens = [575526, 345631, 490920, 477598, 310638, 827147, 592943, 470898,
  481403, 444492, 336968, 756717, 434423, 492552, 386515, 345624, 454871, 434743,
  533815, 416577, 526612, 281119, 390988];
assert.equal(measuredTokens.length, 23);
const measuredBaseline = measuredTokens.reduce((sum, tokens) => sum + tokens, 0);
assert.equal(measuredBaseline, 10_808_720);
const held = { phase: "blocked", item: "issue-2712", head: "2bb4952", lane: "idle-module-error",
  review: "registered-not-run", blocker: "harness-uninstalled", progressRevision: 0 };
let prior = null;
let modelTurns = 0;
let admittedTokens = 0;
for (const tokens of measuredTokens) {
  const decision = evaluateCtoCadence(held, prior);
  if (decision.fire) { modelTurns++; admittedTokens += tokens; }
  prior = decision.state;
}
assert.equal(modelTurns, 0, "unchanged blocked replay must spend no model turns");
assert.equal(admittedTokens, 0, "the measured trace's 10,808,720 tokens are avoidable under this replay");
assert.equal(evaluateCtoCadence({ ...held, lane: "new-prompt", phase: "active", progressRevision: 1 }, prior).fire, true);
const first = evaluateCtoCadence({ ...held, phase: "active", progressRevision: 1 }, prior);
assert.equal(first.fire, true);
assert.equal(evaluateCtoCadence({ ...held, phase: "active", progressRevision: 1 }, first.state).reason, "unchanged");
const second = evaluateCtoCadence({ ...held, phase: "active", head: "changed", progressRevision: 1 }, first.state);
assert.equal(second.fire, true, "one material change may consume the second bounded turn");
assert.equal(evaluateCtoCadence({ ...held, phase: "active", head: "changed-again", progressRevision: 1 }, second.state).reason,
  "no_progress_budget_exhausted");
assert.equal(evaluateCtoCadence({ ...held, phase: "active", head: "changed-again", progressRevision: 2 }, second.state).fire, true,
  "verified progress resets the bounded budget");
assert.equal(evaluateCtoCadence({ ...held, blocker: undefined }, prior).reason, "invalid_observation");
console.log("CTO no-progress cadence eval: 23/23 blocked ticks suppressed; bounded changed-state turns: passed");
