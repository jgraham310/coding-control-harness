#!/usr/bin/env node
// Consume tmux's fresh output without retaining raw pane text in the state tree.
// A stable marker per explicit error gives the watch path a monotonic byte offset.
import { detectPaneError } from './completion-controller.mjs';

let pending = '';
function accept(line) {
  // pipe-pane receives terminal bytes, not capture-pane's rendered text.
  // Cursor repositioning starts a new visual segment; color/erase/title
  // controls must not hide a start-anchored error from the classifier.
  const rendered = line
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[HfGd]/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (detectPaneError(rendered)) process.stdout.write('hook_module_not_found\n');
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
