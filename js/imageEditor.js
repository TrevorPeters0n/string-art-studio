/* Source image: circular framing (pan / zoom / rotate / mirror),
   tonal adjustments, and conversion into the solver's target buffer. */

import { clamp, hexToRgb01, luma } from './util.js';

const DEFAULT_FRAME = { ox: 0, oy: 0, zoom: 1, rot: 0, flip: false };
const DEFAULT_ADJ = {
  brightness: 0, contrast: 0, gamma: 1,
  sharpen: 0, vignette: 0, invert: false, color: false,
};

export class ImageEditor {
  constructor() {
    this.img = null;
    this.frame = { ...DEFAULT_FRAME };
    this.adj = { ...DEFAULT_ADJ };
    this.bgHex = '#ffffff';
    this._c = document.createElement('canvas');
    this._x = this._c.getContext('2d', { willReadFrequently: true });
  }

  get ready() { return !!this.img; }

  setImage(img) {
    this.img = img;
    this.frame = { ...DEFAULT_FRAME };
  }

  resetFrame() { this.frame = { ...DEFAULT_FRAME }; }
  resetAdjustments() { this.adj = { ...DEFAULT_ADJ }; }

  /* ── the one place pixels get made ───────────────────────────
     Returns ImageData (size x size): framed, adjusted, circle-masked. */
  render(size) {
    if (!this.img) return null;
    const c = this._c, x = this._x;
    if (c.width !== size || c.height !== size) { c.width = size; c.height = size; }

    const bg = hexToRgb01(this.bgHex).map((v) => Math.round(v * 255));
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    x.fillRect(0, 0, size, size);

    const f = this.frame;
    const iw = this.img.width, ih = this.img.height;
    // zoom 1 == the image's short side exactly fills the circle
    const s = (f.zoom * size) / Math.min(iw, ih);
    x.save();
    x.translate(size / 2 + f.ox * size, size / 2 + f.oy * size);
    x.rotate((f.rot * Math.PI) / 180);
    x.scale(f.flip ? -1 : 1, 1);
    x.imageSmoothingQuality = 'high';
    x.drawImage(this.img, (-iw * s) / 2, (-ih * s) / 2, iw * s, ih * s);
    x.restore();

    const data = x.getImageData(0, 0, size, size);
    applyAdjustments(data, this.adj, bg);
    maskCircle(data, bg, this.adj.vignette);
    return data;
  }

  /** Draw the framed result into a visible canvas. */
  paint(canvas, size) {
    const data = this.render(size);
    if (!data) return;
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size; canvas.height = size;
    }
    canvas.getContext('2d').putImageData(data, 0, 0);
  }

  /** Float32 target for the worker. channels: 1 (luma) or 3 (rgb), values 0..1. */
  buildTarget(size, channels) {
    const data = this.render(size);
    if (!data) return null;
    const px = data.data, n = size * size;
    const out = new Float32Array(n * channels);
    if (channels === 1) {
      for (let p = 0; p < n; p++) {
        out[p] = luma(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]) / 255;
      }
    } else {
      for (let p = 0; p < n; p++) {
        out[p * 3] = px[p * 4] / 255;
        out[p * 3 + 1] = px[p * 4 + 1] / 255;
        out[p * 3 + 2] = px[p * 4 + 2] / 255;
      }
    }
    return out;
  }

  /** Stretch the histogram of the framed image; writes brightness/contrast. */
  autoLevels(size = 320) {
    const data = this.render(size);
    if (!data) return;
    const px = data.data;
    const hist = new Uint32Array(256);
    let total = 0;
    const c = (size - 1) / 2, r2 = c * c;
    for (let y = 0; y < size; y++) {
      for (let xp = 0; xp < size; xp++) {
        const dx = xp - c, dy = y - c;
        if (dx * dx + dy * dy > r2) continue;
        const i = (y * size + xp) * 4;
        hist[Math.round(luma(px[i], px[i + 1], px[i + 2]))]++;
        total++;
      }
    }
    if (!total) return;
    const cut = total * 0.005;
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } }
    if (hi - lo < 8) return;

    // undo the adjustments already baked into the measurement
    const fCur = contrastFactor(this.adj.contrast * 2.55);
    const fWant = (255 / (hi - lo)) * fCur;
    const bWant = fWant * (128 - remap(lo, this.adj)) - 128;

    this.adj.contrast = clamp(Math.round(invContrast(fWant) / 2.55), -100, 100);
    this.adj.brightness = clamp(Math.round(bWant / 2.55), -100, 100);
  }
}

/* remap a measured level back through the current brightness/contrast */
function remap(v, adj) {
  const f = contrastFactor(adj.contrast * 2.55);
  return (v - 128) / (f || 1) + 128 - adj.brightness * 2.55;
}
const contrastFactor = (c) => (259 * (c + 255)) / (255 * (259 - c));
const invContrast = (f) => clamp((66045 * (f - 1)) / (259 + 255 * f), -254, 254);

/* ── pixel pipeline ─────────────────────────────────────────── */
function applyAdjustments(data, adj, bg) {
  const px = data.data, n = data.width * data.height;

  if (adj.sharpen > 0) unsharp(data, adj.sharpen);

  const f = contrastFactor(adj.contrast * 2.55);
  const b = adj.brightness * 2.55;
  const invG = 1 / adj.gamma;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let o = (v - 128) * f + 128 + b;
    o = 255 * Math.pow(clamp(o, 0, 255) / 255, invG);
    lut[v] = adj.invert ? 255 - o : o;
  }

  if (adj.color) {
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]];
    }
  } else {
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      const g = lut[Math.round(luma(px[i], px[i + 1], px[i + 2]))];
      px[i] = g; px[i + 1] = g; px[i + 2] = g;
    }
  }
}

/** Unsharp mask via two separable box blurs (a cheap Gaussian). */
function unsharp(data, amount) {
  const { width: W, height: H } = data;
  const px = data.data, n = W * H;
  const src = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    src[p * 3] = px[p * 4]; src[p * 3 + 1] = px[p * 4 + 1]; src[p * 3 + 2] = px[p * 4 + 2];
  }
  const r = Math.max(1, Math.round(W / 220));
  const blur = boxBlur(boxBlur(src, W, H, r), W, H, r);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) {
      const i = p * 3 + c;
      px[p * 4 + c] = clamp(src[i] + amount * (src[i] - blur[i]), 0, 255);
    }
  }
}

function boxBlur(src, W, H, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const win = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[(y * W + clamp(k, 0, W - 1)) * 3 + c];
      for (let x = 0; x < W; x++) {
        tmp[(y * W + x) * 3 + c] = sum / win;
        sum += src[(y * W + clamp(x + r + 1, 0, W - 1)) * 3 + c]
             - src[(y * W + clamp(x - r, 0, W - 1)) * 3 + c];
      }
    }
  }
  for (let x = 0; x < W; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(clamp(k, 0, H - 1) * W + x) * 3 + c];
      for (let y = 0; y < H; y++) {
        out[(y * W + x) * 3 + c] = sum / win;
        sum += tmp[(clamp(y + r + 1, 0, H - 1) * W + x) * 3 + c]
             - tmp[(clamp(y - r, 0, H - 1) * W + x) * 3 + c];
      }
    }
  }
  return out;
}

/** Everything outside the nail circle becomes board colour; optional soft edge. */
function maskCircle(data, bg, vignette) {
  const { width: W, height: H } = data;
  const px = data.data;
  const c = (W - 1) / 2;
  const inner = 1 - clamp(vignette, 0, 0.95);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      const i = (y * W + x) * 4;
      if (r >= 1) {
        px[i] = bg[0]; px[i + 1] = bg[1]; px[i + 2] = bg[2]; px[i + 3] = 255;
      } else if (vignette > 0 && r > inner) {
        let t = (r - inner) / (1 - inner);
        t = t * t * (3 - 2 * t);
        px[i] += (bg[0] - px[i]) * t;
        px[i + 1] += (bg[1] - px[i + 1]) * t;
        px[i + 2] += (bg[2] - px[i + 2]) * t;
      }
    }
  }
}

/* ── framing interaction ────────────────────────────────────── */
export function attachFrameControls(canvas, editor, onChange) {
  let dragging = false, lastX = 0, lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (!editor.ready) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-drag');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    editor.frame.ox += (e.clientX - lastX) / rect.width;
    editor.frame.oy += (e.clientY - lastY) / rect.height;
    lastX = e.clientX; lastY = e.clientY;
    onChange();
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-drag');
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    if (!editor.ready) return;
    e.preventDefault();
    editor.frame.zoom = clamp(editor.frame.zoom * Math.exp(-e.deltaY * 0.0012), 0.4, 4);
    onChange(true);
  }, { passive: false });
}
