/* Full-screen "follow along while you thread it" mode. */

import { $, nailTable, clamp } from './util.js';

const STORE_KEY = 'stringart.guide.position';
const MAP = 460;

export class BuildGuide {
  constructor() {
    this.result = null;
    this.steps = [];
    this.i = 0;
    this.timer = 0;
    this.trail = document.createElement('canvas');
    this.trail.width = this.trail.height = MAP;
    this._wire();
  }

  /* ── setup ────────────────────────────────────────────────── */
  _wire() {
    $('#guideNext').addEventListener('click', () => this.go(this.i + 1));
    $('#guidePrev').addEventListener('click', () => this.go(this.i - 1));
    $('#btnGuideClose').addEventListener('click', () => this.close());
    $('#guideSlider').addEventListener('input', (e) => this.go(+e.target.value));
    $('#guideTrail').addEventListener('change', () => this.draw());
    $('#guideAuto').addEventListener('change', (e) => this._auto(e.target.checked));
    $('#guideJump').addEventListener('click', () => {
      const v = prompt(`Jump to step (1 – ${this.steps.length}):`, String(this.i + 1));
      if (v !== null && !isNaN(+v)) this.go(clamp(Math.round(+v) - 1, 0, this.steps.length - 1));
    });
    $('#guideModal').addEventListener('click', (e) => {
      if (e.target.id === 'guideModal') this.close();
    });
    this._keys = (e) => {
      if ($('#guideModal').classList.contains('hidden')) return;
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.go(this.i + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.go(this.i - 1); }
      else if (e.key === 'Escape') this.close();
    };
    window.addEventListener('keydown', this._keys);
  }

  fingerprint(result) {
    const first = result.layers[0]?.path.slice(0, 12).join('-') ?? '';
    return `${result.opts.nails}:${result.stats.lines}:${first}`;
  }

  open(result) {
    this.result = result;
    this.steps = [];
    result.layers.forEach((L, li) => {
      for (let k = 1; k < L.path.length; k++) {
        this.steps.push({ layer: li, colour: L.color, from: L.path[k - 1], to: L.path[k], tieOn: k === 1 });
      }
    });
    if (!this.steps.length) return;

    this.pts = nailTable(result.opts.nails, result.opts.offsetRad)
      .map((p) => ({ x: p.x * (MAP - 1), y: p.y * (MAP - 1) }));

    const slider = $('#guideSlider');
    slider.max = String(this.steps.length - 1);

    $('#guideTot').textContent = String(this.steps.length);
    $('#guideSub').textContent =
      `${result.opts.nails} nails · ${result.layers.length} thread${result.layers.length > 1 ? 's' : ''} · ` +
      `use ← → or space to move`;

    const saved = this._load();
    this.trailAt = -1;
    $('#guideModal').classList.remove('hidden');
    this.go(saved, true);
  }

  close() {
    this._auto(false);
    $('#guideAuto').checked = false;
    $('#guideModal').classList.add('hidden');
  }

  /* ── position ─────────────────────────────────────────────── */
  go(i, silent = false) {
    if (!this.steps.length) return;
    this.i = clamp(i, 0, this.steps.length - 1);
    $('#guideSlider').value = String(this.i);
    if (!silent) this._save();
    this.paintText();
    this.draw();
  }

  paintText() {
    const s = this.steps[this.i];
    $('#guideIdx').textContent = String(this.i + 1);
    $('#guideFrom').textContent = String(s.from);
    $('#guideTo').textContent = String(s.to);
    $('#guideTo').style.color = s.colour;

    const title = this.result.layers.length > 1
      ? `Build guide — thread ${s.layer + 1} (${s.colour})`
      : 'Build guide';
    $('#guideTitle').textContent = title;

    // rewrites its own children, so nothing inside may be looked up by id
    const hint = $('.guide-hint');
    hint.innerHTML = s.tieOn
      ? `Start thread ${s.layer + 1}: tie on at nail <b>${s.from}</b>, then go around nail <b>${s.to}</b>.`
      : `From nail <b>${s.from}</b>, around nail <b>${s.to}</b>, then continue.`;

    const ol = $('#guideUpcoming');
    ol.innerHTML = '';
    for (let k = this.i + 1; k < Math.min(this.i + 13, this.steps.length); k++) {
      const li = document.createElement('li');
      li.innerHTML = `<i>${k + 1}</i> ${this.steps[k].from} &rarr; <b>${this.steps[k].to}</b>`;
      ol.appendChild(li);
    }
  }

  /* ── map ──────────────────────────────────────────────────── */
  draw() {
    const cv = $('#guideCanvas');
    if (cv.width !== MAP) { cv.width = cv.height = MAP; }
    const c = cv.getContext('2d');
    const showTrail = $('#guideTrail').checked;

    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = this.result.opts.bg;
    c.fillRect(0, 0, MAP, MAP);

    if (showTrail) {
      this._buildTrail(this.i);
      c.drawImage(this.trail, 0, 0);
    }

    // nails
    const n = this.result.opts.nails;
    const every = n > 300 ? 20 : n > 140 ? 10 : 5;
    c.font = '9px ui-monospace, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let k = 0; k < n; k++) {
      const p = this.pts[k];
      c.fillStyle = 'rgba(110,110,110,.7)';
      c.beginPath(); c.arc(p.x, p.y, 1.1, 0, Math.PI * 2); c.fill();
      if (k % every === 0) {
        const a = Math.atan2(p.y - MAP / 2, p.x - MAP / 2);
        c.fillStyle = 'rgba(110,110,110,.9)';
        c.fillText(String(k), MAP / 2 + Math.cos(a) * (MAP / 2 - 9),
                              MAP / 2 + Math.sin(a) * (MAP / 2 - 9));
      }
    }

    // the current move
    const s = this.steps[this.i];
    const a = this.pts[s.from], b = this.pts[s.to];
    c.strokeStyle = '#d8a24a';
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();

    for (const [p, col, r] of [[a, '#8a8a8a', 4], [b, '#d8a24a', 6]]) {
      c.fillStyle = col;
      c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = '#d8a24a';
    c.font = 'bold 13px ui-monospace, monospace';
    const ang = Math.atan2(b.y - MAP / 2, b.x - MAP / 2);
    c.fillText(String(s.to), MAP / 2 + Math.cos(ang) * (MAP / 2 - 24),
                             MAP / 2 + Math.sin(ang) * (MAP / 2 - 24));
  }

  /** Offscreen trail of every step already threaded, grown incrementally. */
  _buildTrail(upto) {
    const c = this.trail.getContext('2d');
    if (this.trailAt > upto || this.trailAt < 0) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, MAP, MAP);
      c.lineWidth = 0.8;
      this.trailAt = -1;
    }
    for (let k = this.trailAt + 1; k < upto; k++) {
      const s = this.steps[k];
      c.strokeStyle = s.colour;
      c.globalAlpha = 0.42;
      c.beginPath();
      c.moveTo(this.pts[s.from].x, this.pts[s.from].y);
      c.lineTo(this.pts[s.to].x, this.pts[s.to].y);
      c.stroke();
    }
    c.globalAlpha = 1;
    this.trailAt = upto - 1;
  }

  /* ── extras ───────────────────────────────────────────────── */
  _auto(on) {
    clearInterval(this.timer);
    if (!on) return;
    this.timer = setInterval(() => {
      if (this.i >= this.steps.length - 1) { this._auto(false); $('#guideAuto').checked = false; return; }
      this.go(this.i + 1);
    }, 900);
  }

  _save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ fp: this.fingerprint(this.result), i: this.i }));
    } catch { /* private mode, storage disabled — position just won't persist */ }
  }

  _load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (raw && raw.fp === this.fingerprint(this.result)) {
        return clamp(raw.i | 0, 0, this.steps.length - 1);
      }
    } catch { /* ignore */ }
    return 0;
  }
}
