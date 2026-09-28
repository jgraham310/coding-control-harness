#!/usr/bin/env node
// Filter fresh tmux bytes to a monotonic stream of bounded error markers.
// Raw pane output is never written to the durable state directory.
import { detectPaneError } from './completion-controller.mjs';

let segment = '';
let matched = false;
let mode = 'text';
let csi = '';
let row = 1;
let column = 1;
const paneWidth = Number(process.argv[2] ?? 80);
if (!Number.isInteger(paneWidth) || paneWidth < 1) throw new Error('pane-error-stream requires a positive pane width');
function boundary() { segment = ''; matched = false; }
function append(byte) {
  if (column > paneWidth) { row++; column = 1; boundary(); }
  if (segment.length >= 4096) return;
  segment += String.fromCharCode(byte);
  column++;
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
        const params = csi.split(';');
        const positive = (value) => Math.max(1, Number(value || 1) || 1);
        if (final === 'E' || final === 'F') {
          row = Math.max(1, row + (final === 'E' ? 1 : -1) * positive(params[0]));
          column = 1;
          boundary();
        } else if (final === 'G') {
          column = Math.min(paneWidth, positive(params[0]));
          if (column === 1) boundary();
        } else if (final === 'D' || final === 'C') {
          // A full-width print leaves autowrap pending at the last visible
          // column; a cursor-control sequence cancels that pending wrap.
          if (column > paneWidth) column = paneWidth;
          column = final === 'D' ? Math.max(1, column - positive(params[0])) : Math.min(paneWidth, column + positive(params[0]));
          if (final === 'D' && column === 1) boundary();
        } else if (final === 'H' || final === 'f') {
          const nextRow = positive(params[0]);
          const nextColumn = Math.min(paneWidth, positive(params[1]));
          if (nextColumn === 1) boundary();
          row = nextRow;
          column = nextColumn;
        } else if (final === 'd') {
          const nextRow = positive(params[0]);
          row = nextRow;
        } else if (final === 'K' && ['1', '2'].includes(csi)) boundary();
        mode = 'text';
      } else if (csi.length < 32) csi += String.fromCharCode(byte);
      else mode = 'text';
      continue;
    }
    if (byte === 0x1b) { mode = 'esc'; continue; }
    if (byte === 0x9b) { mode = 'csi'; csi = ''; continue; }
    if (byte === 0x0d || byte === 0x0a) { if (byte === 0x0a) row++; column = 1; boundary(); continue; }
    if (byte === 0x08) { segment = segment.slice(0, -1); column = Math.max(1, Math.min(column, paneWidth) - 1); continue; }
    if (byte >= 0x20 && byte <= 0x7e) append(byte);
  }
});
