/** Deterministic admission for a costly CTO agent turn. No transcript input. */
import crypto from "node:crypto";

const FIELDS = ["phase", "item", "head", "lane", "review", "blocker"];
const PHASES = new Set(["active", "ready", "blocked", "waiting", "completed"]);

export function evaluateCtoCadence(observation, prior = null, { maxNoProgressTurns = 2 } = {}) {
  if (!observation || !PHASES.has(observation.phase) ||
      !FIELDS.every((field) => typeof observation[field] === "string") ||
      !Number.isInteger(observation.progressRevision) || observation.progressRevision < 0 ||
      !Number.isInteger(maxNoProgressTurns) || maxNoProgressTurns < 1) {
    return { fire: false, reason: "invalid_observation", state: prior };
  }
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(FIELDS.map((field) => observation[field]))).digest("hex");
  const sameProgress = prior?.progressRevision === observation.progressRevision;
  const noProgressTurns = sameProgress ? (prior?.noProgressTurns ?? 0) : 0;
  const state = { fingerprint, progressRevision: observation.progressRevision, noProgressTurns };
  if (observation.phase !== "active" && observation.phase !== "ready") return { fire: false, reason: "not_actionable", state };
  if (prior?.fingerprint === fingerprint) return { fire: false, reason: "unchanged", state };
  if (noProgressTurns >= maxNoProgressTurns) return { fire: false, reason: "no_progress_budget_exhausted", state };
  return { fire: true, reason: "material_change", state: { ...state, noProgressTurns: noProgressTurns + 1 } };
}
