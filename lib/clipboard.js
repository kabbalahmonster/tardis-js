'use strict';
/**
 * @file lib/clipboard.js — OS clipboard for terminal mode.
 * The GUI uses the browser's clipboard API instead (no OS tools needed).
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');

function pipe(cmd, args, input) {
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
      p.stdin.on('error', () => {});
      p.stdin.end(input);
    } catch { resolve(false); }
  });
}
function run(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, out) => resolve(err ? null : out)));
}
const has = (cmd) => (process.env.PATH || '').split(require('path').delimiter).some((d) => { try { return fs.existsSync(require('path').join(d, cmd)); } catch { return false; } });

/** Copies text; resolves true on success. */
async function copyToClipboard(text) {
  if (process.platform === 'darwin') return pipe('pbcopy', [], text);
  if (process.platform === 'win32') return pipe('clip', [], Buffer.from(text, 'utf16le'));
  if (process.env.WAYLAND_DISPLAY && has('wl-copy') && await pipe('wl-copy', [], text)) return true;
  if (has('xclip') && await pipe('xclip', ['-selection', 'clipboard'], text)) return true;
  if (has('xsel') && await pipe('xsel', ['--clipboard', '--input'], text)) return true;
  return false;
}
/** Reads text from the clipboard, or null. */
async function readClipboard() {
  if (process.platform === 'darwin') return run('pbpaste', []);
  if (process.platform === 'win32') return run('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']);
  for (const [c, a] of [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]]) {
    if (has(c)) { const got = await run(c, a); if (got !== null) return got; }
  }
  return null;
}
module.exports = { copyToClipboard, readClipboard };