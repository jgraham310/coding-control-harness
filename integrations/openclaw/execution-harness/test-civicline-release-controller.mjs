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
fs.writeFileSync(path.join(bin, "az"), "#!/bin/sh\nprintf '%s\\n' '{\"state\":\"Running\",\"health\":\"Healthy\"}'\n");
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
  console.log("civicline release controller immutable-candidate test: passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
