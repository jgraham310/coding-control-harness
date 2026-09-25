// Headless trigger for promise-ledger resolvers. A model turn starts only when
// a promised update or completion deadline is due.
const result = await tools.call("exec", {
  command: "node /Users/jasongraham/.openclaw/repos/coding-control-harness-execution-placement/integrations/openclaw/execution-harness/promise-ledger.mjs watch --apply --state /Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/promise-ledger.json"
});
const raw = String(result?.result?.details?.aggregated ?? result?.result?.content ?? "").trim();
let observation;
try {
  observation = JSON.parse(raw);
} catch (error) {
  json({ fire: true, message: `Promise-ledger trigger could not parse controller output: ${error.message}`, state: { parseFailure: raw.slice(0, 500) } });
}
if (observation) {
  const pending = observation.pendingEvents.map((event) => event.id).sort();
  json({ fire: pending.length > 0 && JSON.stringify(pending) !== trigger.state?.fingerprint, message: pending.length ? `Promise ledger requires update: ${pending.join(", ")}` : undefined, state: { fingerprint: JSON.stringify(pending) } });
}
