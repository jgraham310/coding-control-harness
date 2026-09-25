import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gateOutboundMessage, receiptContext } from "../../src/promise-ledger/policy.mjs";
import { currentUserMessage, isFactualRecapQuestion, parseTurnCompletion, parseTurnIntent, parseVerdict, subscriptionModel } from "../../src/promise-ledger/semantic-review.mjs";
import { acknowledgeCompletionDelivery, acknowledgeTelegramDelivery, claimPendingDelivery, hasPendingDelivery, recordCompletion } from "../../src/promise-ledger/completion-delivery-store.mjs";

const ordinary = { actionable: false, terminal_state: "non_operational", receipt_ids: [] };

function withLedger(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "promise-ledger-gate-"));
  const ledgerPath = path.join(directory, "ledger.json");
  fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, promises: [{ id: "proof-1", status: "active", deliverable: "Create the controller", successPredicate: "Controller exists", lastUpdateEvidence: "controller packet dispatched" }] }));
  try { callback(ledgerPath); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("blocks commitment text without a record marker", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "I will send an update later." }, { ledgerPath, agentId: "cos", semanticVerdict: ordinary });
  assert.equal(result.block, true);
}));

test("permits a commitment only with an active record and strips its marker", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "I will send an update. [[promise-ledger:proof-1]]" }, { ledgerPath, agentId: "cos", semanticVerdict: ordinary });
  assert.equal(result.allow, true);
  assert.equal(result.params.message, "I will send an update.");
}));

test("blocks a marker that cites no active record", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "I will send an update. [[promise-ledger:missing]]" }, { ledgerPath, agentId: "cos", semanticVerdict: ordinary });
  assert.equal(result.block, true);
}));

test("does not gate ordinary non-commitment messages", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "The tests passed." }, { ledgerPath, agentId: "cos", semanticVerdict: ordinary });
  assert.equal(result.allow, true);
}));

test("permits an advisory opinion without an execution receipt", () => withLedger((ledgerPath) => {
  const message = "My recommendation is to use a hybrid memory layer: durable facts plus retrieval. The tradeoff is extra operational complexity.";
  const result = gateOutboundMessage({ action: "send", message }, { ledgerPath, agentId: "cos", semanticVerdict: ordinary });
  assert.equal(result.allow, true);
  assert.equal(result.params.message, message);
}));

test("blocks a semantic solution unless its exact execution receipt has observed progress", () => withLedger((ledgerPath) => {
  const message = "The best remedy is to create the controller. [[execution-receipt:proof-1]]";
  const result = gateOutboundMessage({ action: "send", message }, { ledgerPath, agentId: "cos", semanticVerdict: { actionable: true, terminal_state: "non_operational", receipt_ids: ["proof-1"] } });
  assert.equal(result.allow, true);
  assert.equal(result.params.message, "The best remedy is to create the controller.");
}));

test("blocks a semantic solution with no matching execution receipt", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "We should create the controller." }, { ledgerPath, agentId: "cos", semanticVerdict: { actionable: true, terminal_state: "non_operational", receipt_ids: [] } });
  assert.equal(result.block, true);
}));

test("blocks an unsupported operational blocker", () => withLedger((ledgerPath) => {
  const result = gateOutboundMessage({ action: "send", message: "The work is blocked while the dependency is repaired." }, { ledgerPath, agentId: "cos", semanticVerdict: { actionable: false, terminal_state: "active_closure", receipt_ids: [] } });
  assert.equal(result.block, true);
}));

test("permits an active closure only with observed execution evidence", () => withLedger((ledgerPath) => {
  const message = "The dependency is being repaired. [[execution-receipt:proof-1]]";
  const result = gateOutboundMessage({ action: "send", message }, { ledgerPath, agentId: "cos", semanticVerdict: { actionable: false, terminal_state: "active_closure", receipt_ids: ["proof-1"] } });
  assert.equal(result.allow, true);
}));

test("loads an explicitly cited durable execution receipt by exact id", () => withLedger((ledgerPath) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-receipts-"));
  try {
    fs.writeFileSync(path.join(directory, "done-1.json"), JSON.stringify({
      receiptId: "done-1",
      recordedAt: "2026-09-11T21:48:48Z",
      scope: "Implement the requested change",
      verification: { ci: "passed" },
    }));
    const receipts = receiptContext(ledgerPath, directory, ["done-1", "missing"]);
    const durable = receipts.find((record) => record.id === "done-1");
    assert.equal(durable.status, "recorded");
    assert.equal(durable.evidence.verification.ci, "passed");
    assert.equal(receipts.some((record) => record.id === "missing"), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test("accepts an actionable completion backed by a durable execution receipt", () => withLedger((ledgerPath) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "execution-receipts-gate-"));
  try {
    fs.writeFileSync(path.join(directory, "done-2.json"), JSON.stringify({
      receiptId: "done-2",
      recordedAt: "2026-09-11T21:48:48Z",
      scope: "Implement the requested change",
    }));
    const message = "The requested change is merged. [[execution-receipt:done-2]]";
    const result = gateOutboundMessage({ action: "send", message }, {
      ledgerPath,
      executionReceiptPath: directory,
      agentId: "cos",
      semanticVerdict: { actionable: true, terminal_state: "completed", receipt_ids: ["done-2"] },
    });
    assert.equal(result.allow, true);
    assert.equal(result.params.message, "The requested change is merged.");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}));

test("semantic verdict parsing rejects narrative output", () => {
  assert.deepEqual(parseVerdict('{"actionable":true,"terminal_state":"active_closure","receipt_ids":["proof-1"]}'), { actionable: true, terminal_state: "active_closure", receipt_ids: ["proof-1"] });
  assert.throws(() => parseVerdict("This requires a fix."));
});

test("semantic review is pinned to the Codex subscription", () => {
  assert.equal(subscriptionModel("codex/gpt-5.5"), "gpt-5.5");
  assert.throws(() => subscriptionModel("google/gemini-2.5-flash-lite"));
});

test("turn intent parsing accepts a clear directive classification", () => {
  assert.deepEqual(parseTurnIntent('{"execution_required":true,"jason_only":false}'), { execution_required: true, jason_only: false });
  assert.throws(() => parseTurnIntent('{"execution_required":"yes","jason_only":false}'));
});

test("factual recap questions bypass execution control", () => {
  assert.equal(isFactualRecapQuestion("The five-minute cron job seemed to come back on after the Langfuse implementation. Were those two related?"), true);
  assert.equal(isFactualRecapQuestion("What caused the supervisor to resume?"), true);
  assert.equal(isFactualRecapQuestion("Can you re-enable the five-minute supervisor?"), false);
  assert.equal(isFactualRecapQuestion("Were the two related? Please fix the cron."), false);
});

test("OpenClaw context envelopes do not hide factual recap questions", () => {
  const wrapped = `Conversation info: ⟦openclaw:ctx⟧
\`\`\`json
{"chat_id":"redacted"}
\`\`\`

Reply target of current user message: ⟦openclaw:ctx⟧
\`\`\`json
{"message_id":"redacted"}
\`\`\`

Why is the execution verifier unavailable?`;
  assert.equal(currentUserMessage(wrapped), "Why is the execution verifier unavailable?");
  assert.equal(isFactualRecapQuestion(wrapped), true);
});

test("OpenClaw context envelopes do not hide operational directives", () => {
  const wrapped = `Conversation info: ⟦openclaw:ctx⟧
\`\`\`json
{"chat_id":"redacted"}
\`\`\`

Fix the execution verifier`;
  assert.equal(currentUserMessage(wrapped), "Fix the execution verifier");
  assert.equal(isFactualRecapQuestion(wrapped), false);
});

test("turn completion parsing requires a terminal execution state", () => {
  assert.deepEqual(parseTurnCompletion('{"satisfied":true,"terminal_state":"completed","receipt_ids":["proof-1"]}'), { satisfied: true, terminal_state: "completed", receipt_ids: ["proof-1"] });
  assert.throws(() => parseTurnCompletion('{"satisfied":true,"terminal_state":"non_operational","receipt_ids":[]}'));
});

test("completion delivery survives a restart and is settled by one Telegram receipt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "completion-delivery-"));
  const statePath = path.join(directory, "delivery.json");
  try {
    recordCompletion({ statePath, runId: "run-1", sessionKey: "agent:cos:webchat:direct", content: "Temporal is installed.", now: 1 });
    const claimed = claimPendingDelivery({ statePath, now: 2 });
    assert.equal(claimed.id, "run-1");
    assert.equal(hasPendingDelivery({ statePath, now: 90_003 }), true, "a pre-send crash reopens the claim");
    const retry = claimPendingDelivery({ statePath, now: 90_004 });
    acknowledgeTelegramDelivery({ statePath, content: retry.content, messageId: "tg-1", now: 90_005 });
    assert.equal(hasPendingDelivery({ statePath, now: 90_006 }), false);
    assert.equal(claimPendingDelivery({ statePath, now: 90_007 }), null, "receipt prevents duplicate delivery");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a direct delivery receipt settles only the claimed completion record", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "completion-delivery-id-"));
  const statePath = path.join(directory, "delivery.json");
  try {
    recordCompletion({ statePath, runId: "run-1", content: "same content", now: 1 });
    recordCompletion({ statePath, runId: "run-2", content: "same content", now: 2 });
    const claimed = claimPendingDelivery({ statePath, now: 3 });
    assert.equal(acknowledgeCompletionDelivery({ statePath, id: claimed.id, messageId: "tg-1", now: 4 }), true);
    const second = claimPendingDelivery({ statePath, now: 5 });
    assert.equal(second.id, "run-2");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("recovery delivery suppresses a procedural placeholder instead of sending it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "completion-delivery-outcome-only-"));
  const statePath = path.join(directory, "delivery.json");
  try {
    recordCompletion({ statePath, runId: "run-placeholder", content: "No Jason-only authority is required.", now: 1 });
    const worker = path.resolve("/Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/completion-delivery.mjs");
    const result = spawnSync(process.execPath, [worker, "deliver"], {
      env: { ...process.env, COMPLETION_DELIVERY_STATE: statePath },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      delivered: false,
      id: "run-placeholder",
      reason: "suppressed-procedural-placeholder",
    });
    assert.equal(hasPendingDelivery({ statePath, now: 2 }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
