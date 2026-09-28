#!/usr/bin/env node
// Consume tmux's fresh output without retaining raw pane text in the state tree.
// A stable marker per explicit error gives the watch path a monotonic byte offset.
import { detectPaneError } from './completion-controller.mjs';

let pending = '';
function accept(line) {
  if (detectPaneError(line)) process.stdout.write('hook_module_not_found\n');
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) !== -1) {
    accept(pending.slice(0, end).slice(0, 4096));
    pending = pending.slice(end + 1);
  }
  if (pending.length > 4096) pending = '';
});
process.stdin.on('end', () => { if (pending) accept(pending.slice(0, 4096)); });
