/* Shared helpers: nail geometry, colour, formatting, file output. */

/* ── geometry ───────────────────────────────────────────────── */
/** Nail centre in normalised [0,1] board coordinates.
 *  Must stay identical to nailXY() in stringart.worker.js. */
export function nailXY(i, n, offsetRad) {
  const a = offsetRad + (2 * Math.PI * i) / n;
  return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
}

export function nailTable(n, offsetRad) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = nailXY(i, n, offsetRad);
  return out;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ── colour ─────────────────────────────────────────────────── */
export function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return [v[0] / 255, v[1] / 255, v[2] / 255];
}

export function rgb01ToHex(rgb) {
  return '#' + rgb.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

/** Rec. 709 luma — matches the grayscale conversion used for the target. */
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export const isGrey = (hex) => {
  const [r, g, b] = hexToRgb01(hex);
  return Math.abs(r - g) < 0.012 && Math.abs(g - b) < 0.012;
};

/* ── units & formatting ─────────────────────────────────────── */
export const UNIT_MM = { mm: 1, cm: 10, in: 25.4 };

/** Board length in mm from the user's diameter + unit. */
export const toMM = (value, unit) => value * (UNIT_MM[unit] || 1);

export function fmtLength(mm) {
  if (!isFinite(mm) || mm <= 0) return '—';
  if (mm < 1000) return mm.toFixed(0) + ' mm';
  if (mm < 1e6) return (mm / 1000).toFixed(mm < 1e4 ? 2 : 1) + ' m';
  return (mm / 1e6).toFixed(2) + ' km';
}

export function fmtDuration(sec) {
  if (!isFinite(sec) || sec <= 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h >= 1) return h + ' h ' + String(m).padStart(2, '0') + ' m';
  if (sec >= 60) return Math.round(sec / 60) + ' min';
  return Math.round(sec) + ' s';
}

export const fmtBytes = (b) =>
  b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(0) + ' MB';

export const fmtNum = (n) => n.toLocaleString();

/* ── DOM / output ───────────────────────────────────────────── */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Save a blob, preferring a real "Save As" dialog.
 *
 *  The File System Access API gives a native picker and remembers the last
 *  folder per `id`, which is what makes the app-window build feel like a
 *  desktop app rather than a browser. Falls back to a plain download where
 *  it is unavailable (Firefox) or refused.
 *
 *  Returns the saved name, or null if the user cancelled. */
export async function saveBlob(blob, filename, { id = 'stringart', types } = {}) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        id,
        startIn: 'documents',
        types,
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return handle.name;
    } catch (err) {
      if (err && err.name === 'AbortError') return null;   // user cancelled
      // anything else (blocked, unsupported option) → fall through
    }
  }
  download(blob, filename);
  return filename;
}

/** File-type filters for the save dialog. */
export const FILE_TYPES = {
  png: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }],
  svg: [{ description: 'SVG vector image', accept: { 'image/svg+xml': ['.svg'] } }],
  txt: [{ description: 'Text file', accept: { 'text/plain': ['.txt'] } }],
  csv: [{ description: 'CSV spreadsheet', accept: { 'text/csv': ['.csv'] } }],
  json: [{ description: 'String Art project', accept: { 'application/json': ['.json'] } }],
};

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Run `fn` on the next frame — or on a short timer if frames are not being
 *  produced (a backgrounded tab pauses rAF, which would otherwise leave the
 *  preview stale until the user comes back). Runs exactly once. */
export function scheduleFrame(fn) {
  let done = false;
  const run = () => { if (done) return; done = true; fn(); };
  requestAnimationFrame(run);
  setTimeout(run, 80);
}

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
