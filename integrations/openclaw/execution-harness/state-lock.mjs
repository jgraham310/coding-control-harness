import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Cross-process, fail-closed lock for the full read/modify/write transaction.
export function acquireStateLock(file) {
  const lockDir = `${file}.lockdir`;
  const ownerFile = path.join(lockDir, "owner.json");
  const token = crypto.randomUUID();
  try { fs.mkdirSync(lockDir); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")); }
    catch {
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age < 60_000) throw new Error(`State is busy: ${file}`);
      owner = { pid: -1 };
    }
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); throw new Error(`State is busy: ${file}`); }
      catch (signalError) { if (signalError.code !== "ESRCH") throw signalError; }
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    fs.mkdirSync(lockDir);
  }
  fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { mode: 0o600 });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (owner.pid === process.pid && owner.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {}
    process.removeListener("exit", release);
  };
  process.once("exit", release);
  return release;
}
