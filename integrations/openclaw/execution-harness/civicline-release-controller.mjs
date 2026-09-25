#!/usr/bin/env node
/**
 * Deterministic CivicLine nightly release controller.
 *
 * This runner is deliberately fail-closed. It writes an immutable execution
 * record for the current manifest, and exits successfully for a legitimate
 * hold so the scheduler can distinguish a held release from a broken job.
 * It performs no production mutation; promotion is enabled only when a
 * separately versioned deployment adapter is installed and explicitly called.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.env.CIVICLINE_RELEASE_ROOT || "/Users/jasongraham/.openclaw/workspace-cos/ops/execution-harness";
const TRAINS = path.join(ROOT, "release-trains");
const RECORDS = path.join(ROOT, "release-records");

function run(file, args, timeout = 20000) {
  try { return { ok: true, stdout: execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim() }; }
  catch (error) { return { ok: false, error: String(error.stderr || error.message || error).trim().slice(0, 1000) }; }
}
function newestManifest() {
  const files = fs.readdirSync(TRAINS).filter((name) => name.endsWith(".json"))
    .map((name) => path.join(TRAINS, name)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error("no immutable release manifest exists");
  const file = files[0];
  return { file, manifest: JSON.parse(fs.readFileSync(file, "utf8")) };
}
function requiredPassed(manifest) {
  const required = manifest?.required ?? {};
  return required.stagingHealth === "passed" && required.stagingSmoke === "passed" &&
    String(required.stagingUat ?? "").startsWith("passed") && required.independentReview === "passed";
}
function imageTag(manifest) {
  const source = String(manifest?.source?.commit ?? "").slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(source)) throw new Error("manifest source commit is invalid");
  return `release-${source}`;
}
function productionState(manifest) {
  const app = manifest?.production?.app;
  const group = manifest?.production?.resourceGroup;
  if (!app || !group) return { ok: false, error: "manifest lacks production app/resourceGroup" };
  return run("az", ["containerapp", "show", "-n", app, "-g", group, "--query", "{image:properties.template.containers[0].image,revision:properties.latestReadyRevisionName,mode:properties.configuration.activeRevisionsMode}", "-o", "json"], 30000);
}
function promote(manifest, record) {
  const prod = productionState(manifest);
  if (!prod.ok) throw new Error(prod.error);
  const before = JSON.parse(prod.stdout);
  const tag = imageTag(manifest);
  const sourceImage = `${manifest.artifact.image.split(":")[0]}@${manifest.artifact.digest}`;
  const targetImage = `acrdrakesbranchvaprod.azurecr.io/clerk-suite:${tag}`;
  record.promotionStarted = true;
  const imported = run("az", ["acr", "import", "-n", "acrdrakesbranchvaprod", "--source", sourceImage, "--image", `clerk-suite:${tag}`, "--force"], 180000);
  if (!imported.ok) throw new Error(`production image import failed: ${imported.error}`);
  const updated = run("az", ["containerapp", "update", "-n", manifest.production.app, "-g", manifest.production.resourceGroup, "--image", targetImage, "--revision-suffix", String(manifest.source.commit).slice(0, 10)], 180000);
  if (!updated.ok) {
    run("az", ["containerapp", "update", "-n", manifest.production.app, "-g", manifest.production.resourceGroup, "--image", before.image, "--revision-suffix", `rollback${Date.now().toString().slice(-6)}`], 180000);
    throw new Error(`production update failed and rollback was requested: ${updated.error}`);
  }
  const smoke = run("node", ["/Users/jasongraham/.openclaw/workspace-cos/portfolio-control-pilot/bin/civicline-production-smoke.mjs"], 180000);
  if (!smoke.ok) {
    const rollback = run("az", ["containerapp", "update", "-n", manifest.production.app, "-g", manifest.production.resourceGroup, "--image", before.image, "--revision-suffix", `rollback${Date.now().toString().slice(-6)}`], 180000);
    record.rollback = { requested: true, ok: rollback.ok, detail: rollback.ok ? rollback.stdout : rollback.error };
    throw new Error(`production smoke failed; rollback requested: ${smoke.error}`);
  }
  return { before, targetImage, smoke: smoke.stdout, observationDueAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}
function observePendingPromotions() {
  if (!fs.existsSync(RECORDS)) return [];
  const results = [];
  for (const name of fs.readdirSync(RECORDS).filter((item) => item.endsWith(".json"))) {
    const file = path.join(RECORDS, name);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (record.outcome !== "promoted-awaiting-60-minute-observation") continue;
    if (!record.promotion?.observationDueAt || Date.now() < Date.parse(record.promotion.observationDueAt)) continue;
    const smoke = run("node", ["/Users/jasongraham/.openclaw/workspace-cos/portfolio-control-pilot/bin/civicline-production-smoke.mjs"], 180000);
    record.healthObservation = { at: new Date().toISOString(), smoke };
    if (smoke.ok) record.outcome = "release-complete";
    else {
      const manifest = JSON.parse(fs.readFileSync(path.join(TRAINS, record.manifest), "utf8"));
      const rollback = run("az", ["containerapp", "update", "-n", manifest.production.app, "-g", manifest.production.resourceGroup, "--image", record.promotion.before.image, "--revision-suffix", `rollback${Date.now().toString().slice(-6)}`], 180000);
      record.rollback = { requested: true, ok: rollback.ok, detail: rollback.ok ? rollback.stdout : rollback.error };
      record.outcome = "rolled-back-after-health-observation";
      record.reasons = [...(record.reasons ?? []), "60-minute production health observation failed"];
      record.productionMutation = true;
    }
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    results.push({ record: file, outcome: record.outcome, productionMutation: Boolean(record.productionMutation) });
  }
  return results;
}
function main() {
  if (process.argv.includes("--observe")) {
    const observed = observePendingPromotions();
    if (observed.length) {
      const summary = observed.map((item) => `${path.basename(item.record)}: ${item.outcome}`).join("; ");
      run("openclaw", ["message", "send", "--channel", "signal", "--account", "default", "--target", "uuid:7c7da792-adaf-4f0f-9e2d-f15302a31482", "--message", `CivicLine release health observation completed: ${summary}`], 30000);
    }
    process.stdout.write(`${JSON.stringify({ observed })}\n`);
    return;
  }
  const at = new Date().toISOString();
  const { file, manifest } = newestManifest();
  const source = manifest?.source?.commit;
  const digest = manifest?.artifact?.digest;
  const staging = manifest?.staging;
  const rollbackAnchor = manifest?.production?.rollbackAnchor;
  // A release train is immutable once its source commit and artifact digest
  // have been recorded.  `main` is intentionally allowed to advance while
  // that exact artifact completes its staging and review gates, so never use
  // the moving branch tip as a promotion precondition.
  const revision = staging?.app && staging?.resourceGroup && staging?.revision
    ? run("az", ["containerapp", "revision", "show", "-n", staging.app, "-g", staging.resourceGroup, "--revision", staging.revision, "--query", "{state:properties.runningState,health:properties.healthState,image:properties.template.containers[0].image}", "-o", "json"], 30000)
    : { ok: false, error: "manifest lacks staging app/resourceGroup/revision" };
  const smoke = run("curl", ["--connect-timeout", "5", "--max-time", "12", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", "https://staging-civicline.surava.com/clerk/"], 15000);
  const mutate = process.argv.includes("--promote");
  const reasons = [];
  if (!source || !digest || !rollbackAnchor) reasons.push("manifest is missing immutable source, artifact digest, or rollback anchor");
  if (!revision.ok) reasons.push("staging revision could not be verified");
  else { try { const value = JSON.parse(revision.stdout); if (value.health !== "Healthy" || !String(value.state).includes("Running")) reasons.push("staging revision is not healthy and running"); if (!digest || !String(value.image ?? "").endsWith(`@${digest}`)) reasons.push("staging revision image does not match the candidate digest"); } catch { reasons.push("staging revision returned invalid JSON"); } }
  if (!smoke.ok || smoke.stdout !== "200") reasons.push("staging smoke did not return HTTP 200");
  if (!requiredPassed(manifest)) reasons.push("manifest has not recorded every required staging and independent-review gate as passed");
  let promotionClaim = null;
  if (!reasons.length && mutate) {
    const claims = path.join(RECORDS, "claims");
    fs.mkdirSync(claims, { recursive: true });
    const claimPath = path.join(claims, `${path.basename(file)}.claim`);
    try {
      const descriptor = fs.openSync(claimPath, "wx", 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify({ manifest: path.basename(file), digest, claimedAt: at, pid: process.pid })}\n`); }
      finally { fs.closeSync(descriptor); }
      promotionClaim = claimPath;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      reasons.push("promotion already claimed for this immutable manifest");
    }
  }
  const record = {
    schemaVersion: 1, at, controller: "civicline-release-controller/v1", manifest: path.basename(file),
    sourceCommit: source ?? null, artifactDigest: digest ?? null, rollbackAnchor: rollbackAnchor ?? null,
    checks: { stagingRevision: revision, stagingSmoke: smoke },
    outcome: reasons.length ? "held" : (mutate ? "promotion-pending" : "ready-for-promotion"),
    reasons,
    productionMutation: false,
    promotionClaim
  };
  if (!reasons.length && mutate) {
    try { record.promotion = promote(manifest, record); record.outcome = "promoted-awaiting-60-minute-observation"; record.productionMutation = true; }
    catch (error) {
      record.outcome = "promotion-failed-or-rolled-back";
      record.reasons.push(error.message);
      record.productionMutation = Boolean(record.promotionStarted);
      if (!record.promotionStarted && promotionClaim) {
        fs.unlinkSync(promotionClaim);
        record.promotionClaim = null;
      }
    }
  }
  fs.mkdirSync(RECORDS, { recursive: true });
  const output = path.join(RECORDS, `civicline-${at.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outcome: record.outcome, reasons: record.reasons, record: output, productionMutation: record.productionMutation })}\n`);
}
main();
