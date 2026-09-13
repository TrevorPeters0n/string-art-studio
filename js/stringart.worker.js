/* ─────────────────────────────────────────────────────────────
   String Art Studio — solver worker (classic worker, no imports)

   Greedy chord selection driven by exact squared-error reduction.

   For a candidate chord we compute, per covered pixel:
        d = cur - tgt                     (current signed error)
        u = alpha * coverage * (cur - threadColour)   (what this pass removes)
        gain = d^2 - (d - u)^2 = u * (2d - u)

   Summing `gain` over the chord gives the exact drop in squared error, so
   the score is meaningful for dark-on-light, light-on-dark and colour alike,
   and it self-limits: once a region matches, laying more thread scores <= 0.
   ───────────────────────────────────────────────────────────── */

'use strict';

const INV255 = 1 / 255;

/* ── Xiaolin Wu anti-aliased line ───────────────────────────── */
function wuLine(x0, y0, x1, y1, W, H, sink) {
  const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  let t;
  if (steep) { t = x0; x0 = y0; y0 = t; t = x1; x1 = y1; y1 = t; }
  if (x0 > x1) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }

  const dx = x1 - x0;
  const grad = dx === 0 ? 0 : (y1 - y0) / dx;
  const xs = Math.round(x0), xe = Math.round(x1);
  let inter = y0 + grad * (xs - x0);

  for (let x = xs; x <= xe; x++) {
    const yi = Math.floor(inter);
    const f = inter - yi;
    let px, py;
    if (1 - f > 0.004) {
      px = steep ? yi : x; py = steep ? x : yi;
      if (px >= 0 && px < W && py >= 0 && py < H) sink(py * W + px, 1 - f);
    }
    if (f > 0.004) {
      px = steep ? yi + 1 : x; py = steep ? x : yi + 1;
      if (px >= 0 && px < W && py >= 0 && py < H) sink(py * W + px, f);
    }
    inter += grad;
  }
}

/* ── nail geometry (must match js/geometry.js on the main thread) ── */
function nailXY(i, n, offsetRad) {
  const a = offsetRad + (2 * Math.PI * i) / n;
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a)];
}
function edgeId(i, j, n) {
  if (i > j) { const t = i; i = j; j = t; }
  return (i * (2 * n - i - 1)) / 2 + (j - i - 1);
}
function nailGap(i, j, n) {
  const d = Math.abs(i - j);
  return Math.min(d, n - d);
}

/* ── chord cache ────────────────────────────────────────────── */
let cache = null;   // { sig, nails, size, off, idx, cov, len }

function cacheSignature(nails, size, offsetRad) {
  return nails + '|' + size + '|' + offsetRad.toFixed(6);
}

function estimateCachePixels(nails, size) {
  const edges = (nails * (nails - 1)) / 2;
  return Math.round(edges * 1.15 * size);   // ~1.15 plots per px of diameter
}

function buildCache(nails, size, offsetRad, progress) {
  const sig = cacheSignature(nails, size, offsetRad);
  if (cache && cache.sig === sig) { progress(1); return cache; }
  cache = null;   // release before allocating the replacement

  const edges = (nails * (nails - 1)) / 2;
  const S = size - 1;
  const px = new Float64Array(nails), py = new Float64Array(nails);
  for (let i = 0; i < nails; i++) {
    const p = nailXY(i, nails, offsetRad);
    px[i] = p[0] * S; py[i] = p[1] * S;
  }

  // pass 1 — count plots per chord
  const off = new Uint32Array(edges + 1);
  const len = new Float32Array(edges);
  let n = 0;
  const count = () => { n++; };
  let e = 0;
  for (let i = 0; i < nails; i++) {
    for (let j = i + 1; j < nails; j++, e++) {
      off[e] = n;
      wuLine(px[i], py[i], px[j], py[j], size, size, count);
      len[e] = Math.hypot(px[j] - px[i], py[j] - py[i]);
    }
    if ((i & 15) === 0) progress(0.5 * (e / edges));
  }
  off[edges] = n;

  // pass 2 — fill
  const idx = new Uint32Array(n);
  const cov = new Uint8Array(n);
  let w = 0;
  const fill = (pi, c) => { idx[w] = pi; cov[w] = (c * 255) | 0; w++; };
  e = 0;
  for (let i = 0; i < nails; i++) {
    for (let j = i + 1; j < nails; j++, e++) {
      wuLine(px[i], py[i], px[j], py[j], size, size, fill);
    }
    if ((i & 15) === 0) progress(0.5 + 0.5 * (e / edges));
  }

  cache = { sig, nails, size, off, idx, cov, len, bytes: n * 5 };
  progress(1);
  return cache;
}

/* ── job state ──────────────────────────────────────────────── */
let job = null;

self.onmessage = (ev) => {
  const m = ev.data;
  switch (m.type) {
    case 'start':   startJob(m.cfg); break;
    case 'pause':   if (job) job.paused = true; break;
    case 'resume':  if (job && job.paused) { job.paused = false; job.t0 = performance.now() - job.elapsed; tick(); } break;
    case 'stop':    if (job) job.stopped = true; break;
    case 'dropCache': cache = null; break;
    case 'estimate':
      self.postMessage({ type: 'estimate', bytes: estimateCachePixels(m.nails, m.size) * 5 });
      break;
  }
};

function fail(msg) {
  job = null;
  self.postMessage({ type: 'error', message: msg });
}

function startJob(cfg) {
  job = null;
  const est = estimateCachePixels(cfg.nails, cfg.size) * 5;
  if (est > cfg.memBudget) {
    fail('Chord cache would need about ' + (est / 1048576).toFixed(0) +
         ' MB. Lower the nail count or the working resolution.');
    return;
  }

  let cch;
  try {
    cch = buildCache(cfg.nails, cfg.size, cfg.offsetRad,
      (p) => self.postMessage({ type: 'phase', phase: 'cache', pct: p }));
  } catch (err) {
    fail('Could not build the chord cache: ' + err.message);
    return;
  }

  const C = cfg.channels;
  const npx = cfg.size * cfg.size;
  const cur = new Float32Array(npx * C);
  for (let c = 0; c < C; c++) {
    const b = cfg.bg[c];
    for (let p = 0; p < npx; p++) cur[p * C + c] = b;
  }

  // baseline squared error (board colour vs target)
  let err0 = 0;
  for (let p = 0, L = npx * C; p < L; p++) {
    const d = cur[p] - cfg.target[p];
    err0 += d * d;
  }

  // work-per-step budget decides how coarsely candidates are sampled
  const avgLen = 0.6366 * cfg.size;
  const work = cfg.nails * avgLen * C;
  const stride = Math.max(1, Math.min(4, Math.round(work / 160000)));

  const lenFactor = new Float32Array(cch.len.length);
  for (let i = 0; i < cch.len.length; i++) {
    lenFactor[i] = cfg.lenBias === 0 ? 1 : Math.pow(Math.max(cch.len[i], 1) / avgLen, cfg.lenBias);
  }

  job = {
    cfg, cch, C, cur, stride, lenFactor,
    used: new Uint16Array(cch.len.length),
    err0: err0 || 1,
    err: err0,
    layerIdx: 0,
    placed: 0,
    lineNo: 0,
    threadPx: 0,
    at: cfg.layers.length ? cfg.layers[0].start : 0,
    results: cfg.layers.map((L) => ({ color: L.hex, alpha: L.alpha, path: [L.start] })),
    pending: [],
    totalLines: cfg.layers.reduce((s, L) => s + L.lines, 0),
    paused: false, stopped: false,
    t0: performance.now(), elapsed: 0,
    lastPost: 0,
  };
  self.postMessage({ type: 'phase', phase: 'solve', pct: 0 });
  tick();
}

/* ── main loop, sliced so control messages get through ───────── */
function tick() {
  if (!job || job.paused) return;
  const sliceEnd = performance.now() + 28;

  while (performance.now() < sliceEnd) {
    if (job.stopped) { finish(true); return; }
    if (!step()) { finish(false); return; }
  }
  job.elapsed = performance.now() - job.t0;
  flush(false);
  setTimeout(tick, 0);
}

function step() {
  const J = job, cfg = J.cfg;
  let layer = cfg.layers[J.layerIdx];

  // advance past finished layers
  while (layer && J.lineNo >= layer.lines) {
    flush(true);                  // drain this layer's segments before switching
    J.layerIdx++; J.lineNo = 0;
    layer = cfg.layers[J.layerIdx];
    if (layer) J.at = layer.start;
  }
  if (!layer) return false;

  const best = pickBest(layer);
  if (best.j < 0) {               // nothing left that helps — move on
    J.lineNo = layer.lines;
    return true;
  }

  const e = edgeId(J.at, best.j, cfg.nails);
  J.err -= applyEdge(e, layer);
  J.used[e]++;
  J.threadPx += J.cch.len[e];
  J.results[J.layerIdx].path.push(best.j);
  J.pending.push(best.j);
  J.at = best.j;
  J.lineNo++; J.placed++;
  return true;
}

function pickBest(layer) {
  const J = job, cfg = J.cfg, C = J.C;
  const { off, idx, cov } = J.cch;
  const cur = J.cur, tgt = cfg.target;
  const alpha = layer.alpha, col = layer.rgb;
  const n = cfg.nails, i = J.at, stride = J.stride;
  const minGap = cfg.minGap, reuse = cfg.reuse, lf = J.lenFactor, used = J.used;

  const allowWorse = !cfg.earlyStop;
  let bestScore = allowWorse ? -Infinity : 0, bestJ = -1;

  for (let j = 0; j < n; j++) {
    if (j === i) continue;
    if (nailGap(i, j, n) < minGap) continue;

    const e = edgeId(i, j, n);
    const s = off[e], en = off[e + 1];
    let g = 0;

    if (C === 1) {
      const c0 = col[0];
      for (let p = s; p < en; p += stride) {
        const px = idx[p];
        const v = cur[px];
        const u = alpha * cov[p] * INV255 * (v - c0);
        g += u * (2 * (v - tgt[px]) - u);
      }
    } else {
      const c0 = col[0], c1 = col[1], c2 = col[2];
      for (let p = s; p < en; p += stride) {
        const b = idx[p] * 3;
        const a = alpha * cov[p] * INV255;
        let v = cur[b],     u = a * (v - c0); g += u * (2 * (v - tgt[b]) - u);
        v = cur[b + 1];     u = a * (v - c1); g += u * (2 * (v - tgt[b + 1]) - u);
        v = cur[b + 2];     u = a * (v - c2); g += u * (2 * (v - tgt[b + 2]) - u);
      }
    }
    if (g <= 0 && !allowWorse) continue;

    // the repeat penalty must always push a chord *down* the ranking,
    // so it divides positive gains and multiplies negative ones
    const pen = 1 + reuse * used[e];
    const raw = g * stride * lf[e];
    const score = raw > 0 ? raw / pen : raw * pen;
    if (score > bestScore) { bestScore = score; bestJ = j; }
  }
  return { j: bestJ, score: bestScore };
}

function applyEdge(e, layer) {
  const J = job, C = J.C;
  const { off, idx, cov } = J.cch;
  const cur = J.cur, tgt = J.cfg.target;
  const alpha = layer.alpha, col = layer.rgb;
  const s = off[e], en = off[e + 1];
  let g = 0;

  if (C === 1) {
    const c0 = col[0];
    for (let p = s; p < en; p++) {
      const px = idx[p];
      const v = cur[px];
      const u = alpha * cov[p] * INV255 * (v - c0);
      g += u * (2 * (v - tgt[px]) - u);
      cur[px] = v - u;
    }
  } else {
    const c0 = col[0], c1 = col[1], c2 = col[2];
    for (let p = s; p < en; p++) {
      const b = idx[p] * 3;
      const a = alpha * cov[p] * INV255;
      let v = cur[b],   u = a * (v - c0); g += u * (2 * (v - tgt[b]) - u);     cur[b] = v - u;
      v = cur[b + 1];   u = a * (v - c1); g += u * (2 * (v - tgt[b + 1]) - u); cur[b + 1] = v - u;
      v = cur[b + 2];   u = a * (v - c2); g += u * (2 * (v - tgt[b + 2]) - u); cur[b + 2] = v - u;
    }
  }
  return g;
}

/* ── reporting ──────────────────────────────────────────────── */
function stats() {
  const J = job;
  return {
    lines: J.placed,
    layer: Math.min(J.layerIdx, J.cfg.layers.length - 1),
    total: J.totalLines,
    match: Math.max(0, Math.min(1, 1 - J.err / J.err0)),
    threadPx: J.threadPx,
    radiusPx: (J.cfg.size - 1) / 2,
    elapsed: J.elapsed,
  };
}

function flush(force) {
  const J = job;
  const now = performance.now();
  if (!force && J.pending.length < 24 && now - J.lastPost < 90) return;
  if (J.pending.length) {
    self.postMessage({ type: 'lines', layer: J.layerIdx, segs: J.pending });
    J.pending = [];
  }
  J.lastPost = now;
  self.postMessage({ type: 'progress', pct: J.totalLines ? J.placed / J.totalLines : 1, stats: stats() });
}

function finish(cancelled) {
  const J = job;
  J.elapsed = performance.now() - J.t0;
  flush(true);
  self.postMessage({
    type: 'done',
    cancelled,
    layers: J.results.filter((r) => r.path.length > 1),
    stats: stats(),
    nails: J.cfg.nails,
    offsetRad: J.cfg.offsetRad,
    bg: J.cfg.bgHex,
  });
  job = null;
}
