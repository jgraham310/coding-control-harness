#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "civicline-release-controller-"));
const bin = path.join(root, "bin");
fs.mkdirSync(path.join(root, "release-trains"), { recursive: true });
fs.mkdirSync(bin);
const source = "f35749a9f055fd03f41bfc58d30f495e1f6b06b4";
const manifest = {
  source: { branch: "main", commit: source },
  artifact: { image: "example.test/clerk-suite:release", digest: "sha256:02b3f13dfe816dbf922e605367340d242d7c5e7a82a718a5b2587b909a5c6c79" },
  staging: { app: "staging", resourceGroup: "rg", revision: "staging--candidate" },
  production: { app: "production", resourceGroup: "rg", rollbackAnchor: "production--0001" },
  required: { stagingHealth: "passed", stagingSmoke: "passed", stagingUat: "passed: exact artifact", independentReview: "passed" }
};
fs.writeFileSync(path.join(root, "release-trains", "candidate.json"), `${JSON.stringify(manifest)}\n`);
fs.writeFileSync(path.join(bin, "az"), `#!/bin/sh\nprintf '%s\\n' '{"state":"Running","health":"Healthy","image":"example.test/clerk-suite@${manifest.artifact.digest}"}'\n`);
fs.writeFileSync(path.join(bin, "curl"), "#!/bin/sh\nprintf '200'\n");
// If the controller still reads main, this stub leaves evidence and fails.
fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ntouch '${path.join(root, "gh-was-called")}'\nexit 1\n`);
for (const name of ["az", "curl", "gh"]) fs.chmodSync(path.join(bin, name), 0o755);

const controller = path.join(path.dirname(fileURLToPath(import.meta.url)), "civicline-release-controller.mjs");
try {
  const stdout = execFileSync("node", [controller], {
    encoding: "utf8",
    env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` }
  });
  const result = JSON.parse(stdout);
  assert.equal(result.outcome, "ready-for-promotion");
  assert.deepEqual(result.reasons, []);
  assert.equal(fs.existsSync(path.join(root, "gh-was-called")), false);
  fs.writeFileSync(path.join(bin, "az"), "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"Running\",\"health\":\"Healthy\",\"image\":\"example.test/clerk-suite@sha256:wrong\"}'\n");
  const mismatch = JSON.parse(execFileSync("node", [controller], { encoding: "utf8", env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` } }));
  assert.equal(mismatch.outcome, "held");
  assert.equal(mismatch.reasons.includes("staging revision image does not match the candidate digest"), true);
  fs.writeFileSync(path.join(bin, "az"), `#!/bin/sh\nprintf '%s\\n' '{"state":"Running","health":"Healthy","image":"example.test/clerk-suite@${manifest.artifact.digest}"}'\n`);
  execFileSync("node", [controller, "--promote"], { encoding: "utf8", env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` } });
  const repeated = JSON.parse(execFileSync("node", [controller, "--promote"], { encoding: "utf8", env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` } }));
  assert.equal(repeated.outcome, "held");
  assert.equal(repeated.reasons.includes("promotion already claimed for this immutable manifest"), true);
  assert.equal(repeated.productionMutation, false);
  const retryManifest = path.join(root, "release-trains", "candidate-retry.json");
  fs.writeFileSync(retryManifest, `${JSON.stringify(manifest)}\n`);
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(retryManifest, future, future);
  fs.writeFileSync(path.join(bin, "az"), `#!/bin/sh\nif [ "$1" = "containerapp" ] && [ "$2" = "show" ]; then exit 1; fi\nprintf '%s\\n' '{"state":"Running","health":"Healthy","image":"example.test/clerk-suite@${manifest.artifact.digest}"}'\n`);
  const preMutation = JSON.parse(execFileSync("node", [controller, "--promote"], { encoding: "utf8", env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` } }));
  assert.equal(preMutation.outcome, "promotion-failed-or-rolled-back");
  assert.equal(preMutation.productionMutation, false);
  const retry = JSON.parse(execFileSync("node", [controller, "--promote"], { encoding: "utf8", env: { ...process.env, CIVICLINE_RELEASE_ROOT: root, PATH: `${bin}:${process.env.PATH}` } }));
  assert.equal(retry.outcome, "promotion-failed-or-rolled-back", "pre-mutation failure remains retryable");
  assert.equal(retry.reasons.includes("promotion already claimed for this immutable manifest"), false);
  console.log("civicline release controller immutable-candidate test: passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
