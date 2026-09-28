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
let utf8Bytes = [];
let utf8Expected = 0;
let lastBase = '';
let lastBaseWidth = 0;
const paneWidth = Number(process.argv[2] ?? 80);
if (!Number.isInteger(paneWidth) || paneWidth < 1) throw new Error('pane-error-stream requires a positive pane width');
function boundary() { segment = ''; matched = false; lastBase = ''; lastBaseWidth = 0; }
function glyphWidth(char) {
  if (/\p{Mark}/u.test(char)) return 0;
  if (/[\u1100-\u115f\u2329-\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Emoji_Presentation}/u.test(char)) return 2;
  return 1;
}
function append(char) {
  let width = glyphWidth(char);
  if (char === '\ufe0f' && lastBaseWidth === 1 && /\p{Emoji}/u.test(lastBase)) { width = 1; lastBaseWidth = 2; }
  if (char === '\ufe0e' && lastBaseWidth === 2 && /\p{Emoji}/u.test(lastBase)) { width = -1; lastBaseWidth = 1; }
  if (width && (column > paneWidth || (width > 1 && column + width - 1 > paneWidth))) { row++; column = 1; boundary(); }
  if (segment.length >= 4096) return;
  segment += char;
  column = Math.max(1, column + width);
  if (!/\p{Mark}/u.test(char)) { lastBase = char; lastBaseWidth = width; }
  if (!matched && detectPaneError(segment)) {
    process.stdout.write('hook_module_not_found\n');
    matched = true;
  }
}
process.stdin.on('data', (chunk) => {
  for (const byte of chunk) {
    if (mode === 'text' && utf8Expected) {
      if (byte >= 0x80 && byte <= 0xbf) {
        utf8Bytes.push(byte);
        if (utf8Bytes.length === utf8Expected) {
          const char = Buffer.from(utf8Bytes).toString('utf8');
          if (char === '\u009b') { mode = 'csi'; csi = ''; }
          else append(char);
          utf8Bytes = [];
          utf8Expected = 0;
        }
        continue;
      }
      append('\ufffd');
      utf8Bytes = [];
      utf8Expected = 0;
    }
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
        if ('ABCDEFGHfd'.includes(final)) column = Math.min(column, paneWidth);
        if (final === 'E' || final === 'F') {
          row = Math.max(1, row + (final === 'E' ? 1 : -1) * positive(params[0]));
          column = 1;
          boundary();
        } else if (final === 'A' || final === 'B') {
          row = Math.max(1, row + (final === 'B' ? 1 : -1) * positive(params[0]));
        } else if (final === 'G') {
          column = Math.min(paneWidth, positive(params[0]));
          if (column === 1) boundary();
        } else if (final === 'D' || final === 'C') {
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
    if (byte >= 0xc2 && byte <= 0xf4) { utf8Bytes = [byte]; utf8Expected = byte <= 0xdf ? 2 : byte <= 0xef ? 3 : 4; continue; }
    if (byte >= 0x80) { append('\ufffd'); continue; }
    if (byte >= 0x20 && byte <= 0x7e) append(String.fromCharCode(byte));
  }
});
