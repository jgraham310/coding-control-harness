// OpenClaw headless cron trigger. It uses no model tokens: the only work is a
// deterministic state check. An agent turn starts only for a new material
// event or an overdue lane that needs an action.
const result = await tools.call("exec", {
  command: "node /Users/jasongraham/.openclaw/repos/coding-control-harness-execution-placement/integrations/openclaw/execution-harness/harness.mjs watch --apply --auto-recover --state /Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/execution-state.json --work-state /Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness/work-state.json"
});
const raw = String(result?.result?.details?.aggregated ?? result?.result?.content ?? "").trim();
let observation;
try {
  observation = JSON.parse(raw);
} catch (error) {
  json({
    fire: true,
    message: `Execution-harness trigger could not parse controller output: ${error.message}`,
    state: { parseFailure: raw.slice(0, 500) }
  });
}

if (observation) {
  const pending = observation.pendingEvents.map((event) => event.id).sort();
  const overdue = observation.findings.map((finding) => `${finding.issue}:${finding.kind}`).sort();
  const fingerprint = JSON.stringify({ pending, overdue });
  json({
    fire: pending.length > 0 && fingerprint !== trigger.state?.fingerprint,
    message: pending.length > 0 ? `Execution harness requires action: ${fingerprint}` : undefined,
    state: { fingerprint }
  });
}
