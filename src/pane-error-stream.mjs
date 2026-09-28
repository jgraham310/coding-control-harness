#!/usr/bin/env node
// Filter fresh tmux bytes to a monotonic stream of bounded error markers.
// Raw pane output is never written to the durable state directory.
import { detectPaneError } from './completion-controller.mjs';

let segment = '';
let matched = false;
let mode = 'text';
let csi = '';
function boundary() { segment = ''; matched = false; }
function append(byte) {
  if (segment.length >= 4096) return;
  segment += String.fromCharCode(byte);
  if (!matched && detectPaneError(segment)) {
    process.stdout.write('hook_module_not_found\n');
    matched = true;
  }
}
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (mode === 'osc') {
      if (byte === 0x07) mode = 'text';
      else if (byte === 0x1b) mode = 'osc-esc';
      continue;
    }
    if (mode === 'osc-esc') {
      mode = byte === 0x5c ? 'text' : 'osc';
      continue;
    }
    if (mode === 'esc') {
      mode = byte === 0x5b ? 'csi' : byte === 0x5d ? 'osc' : 'text';
      csi = '';
      continue;
    }
    if (mode === 'csi') {
      if (byte >= 0x40 && byte <= 0x7e) {
        const final = String.fromCharCode(byte);
        if ('HfGdEF'.includes(final) || (final === 'K' && /^[02]?$/.test(csi))) boundary();
        mode = 'text';
      } else if (csi.length < 32) csi += String.fromCharCode(byte);
      else mode = 'text';
      continue;
    }
    if (byte === 0x1b) { mode = 'esc'; continue; }
    if (byte === 0x9b) { mode = 'csi'; csi = ''; continue; }
    if (byte === 0x0d || byte === 0x0a) { boundary(); continue; }
    if (byte === 0x08) { segment = segment.slice(0, -1); matched = false; continue; }
    if (byte >= 0x20 && byte <= 0x7e) append(byte);
  }
});
