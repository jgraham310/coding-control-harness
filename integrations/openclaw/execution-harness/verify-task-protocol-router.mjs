#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const pluginPath = "/Users/jasongraham/.openclaw/plugins/task-protocol-router";
const testPath = `${pluginPath}/test.mjs`;
const classifierTestPath = new URL("./task-classifier.test.mjs", import.meta.url).pathname;

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (!existsSync(pluginPath) || !existsSync(testPath)) throw new Error("Task Protocol Router plugin files are missing.");
run("node", [testPath]);
run("node", [classifierTestPath]);
const config = JSON.parse(run("openclaw", ["config", "get", "plugins.entries.task-protocol-router", "--json"]));
if (!config.enabled || config.config?.agentId !== "cos" || !config.hooks?.allowPromptInjection || !config.hooks?.allowConversationAccess) {
  throw new Error("Task Protocol Router plugin configuration is incomplete.");
}
const plugins = run("openclaw", ["plugins", "list", "--json"]);
if (!plugins.includes("task-protocol-router")) throw new Error("Task Protocol Router is not discovered by OpenClaw.");
console.log("Task Protocol Router is active: pre-model classification, fail-closed fallback, and prompt protocol injection verified.");
