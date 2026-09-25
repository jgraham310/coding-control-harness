import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./task-completion-notify.mjs", import.meta.url));
const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-completion-notify-"));
fs.writeFileSync(path.join(taskDir, "GATES.md"), "- [x] All prior gates verified.\n");
const statePath = path.join(taskDir, "completion-notification.json");
for (const state of ["send_started", "uncertain"]) {
  fs.writeFileSync(statePath, `${JSON.stringify({ schema: "task_completion_notification/v1", state })}\n`);
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, TASK_COMPLETION_DIR: taskDir, PATH: "/usr/bin:/bin" } });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).state, "uncertain");
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).state, state, "guard must not rearm the send");
}
console.log("task completion uncertain-send guard: passed");
