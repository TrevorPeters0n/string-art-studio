/* Canvas rendering of the thread path — incremental while solving,
   and full redraws for the preview, the guide map and PNG export. */

import { nailTable } from './util.js';

/** Thread width that matches the solver's model: the solver lays a 1-px line
 *  on a `workRes`-wide board, so at render width D the same physical thread
 *  is D / workRes pixels across. */
export const threadWidth = (renderSize, workRes) =>
  Math.max(0.45, renderSize / Math.max(workRes, 1));

export class StringArtRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = null;
    this.layer = null;
    this.at = 0;
  }

  reset(opts) {
    this.opts = opts;
    const { size, bg } = opts;
    if (this.canvas.width !== size || this.canvas.height !== size) {
      this.canvas.width = size; this.canvas.height = size;
    }
    this.pts = nailTable(opts.nails, opts.offsetRad).map((p) => ({
      x: p.x * (size - 1), y: p.y * (size - 1),
    }));
    const c = this.ctx;
    // A canvas hands back the same context every time, so state survives from
    // any previous run. Without this the board colour would be filled at the
    // last layer's thread opacity and the result would come out translucent.
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, size, size);
    c.fillStyle = bg;
    c.beginPath(); c.arc((size - 1) / 2, (size - 1) / 2, size / 2, 0, Math.PI * 2); c.fill();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = threadWidth(size, opts.workRes);
    this.layer = null;
  }

  beginLayer(hex, alpha, startNail) {
    const c = this.ctx;
    c.strokeStyle = hex;
    c.globalAlpha = Math.min(1, alpha);
    this.layer = { hex, alpha };
    this.at = startNail;
  }

  /** Draw a run of nails continuing from the current position.
   *
   *  Each chord is stroked on its own. Batching them into one path would
   *  composite the whole polyline in a single pass, so crossings would not
   *  darken — and accumulated darkness at crossings is the entire effect
   *  string art depends on. */
  addSegments(nails) {
    if (!this.pts || !nails.length) return;
    const c = this.ctx, P = this.pts;
    let a = P[this.at];
    if (!a) return;
    for (const n of nails) {
      const b = P[n];
      if (!b) continue;
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      a = b;
      this.at = n;
    }
  }

  finish() { this.ctx.globalAlpha = 1; }
}

/** Full redraw of a finished result into any canvas at any size. */
export function renderResult(canvas, layers, opts) {
  const r = new StringArtRenderer(canvas);
  r.reset(opts);
  for (const L of layers) {
    if (L.path.length < 2) continue;
    r.beginLayer(L.color, L.alpha, L.path[0]);
    r.addSegments(L.path.slice(1));
  }
  r.finish();
  return canvas;
}

/** Nail dots + periodic numbers, drawn on the overlay canvas. */
export function drawNailOverlay(canvas, opts, highlight = null) {
  const { size, nails, offsetRad } = opts;
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size; canvas.height = size;
  }
  const c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, size, size);

  const P = nailTable(nails, offsetRad);
  const R = (size - 1) / 2;
  const dot = Math.max(1, size / 500);
  const every = nails > 300 ? 20 : nails > 140 ? 10 : 5;
  const fontPx = Math.max(7, size / 68);

  c.font = `${fontPx}px ui-monospace, monospace`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  for (let i = 0; i < nails; i++) {
    const x = P[i].x * (size - 1), y = P[i].y * (size - 1);
    const on = highlight && (i === highlight.from || i === highlight.to);
    c.fillStyle = on ? '#d8a24a' : 'rgba(120,120,120,.75)';
    c.beginPath(); c.arc(x, y, on ? dot * 2.6 : dot, 0, Math.PI * 2); c.fill();

    if (i % every === 0 || on) {
      const a = Math.atan2(y - R, x - R);
      c.fillStyle = on ? '#d8a24a' : 'rgba(120,120,120,.9)';
      c.fillText(String(i), R + Math.cos(a) * (R - fontPx * 0.85),
                            R + Math.sin(a) * (R - fontPx * 0.85));
    }
  }
  return c;
}
