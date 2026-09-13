/* String Art Studio — UI wiring, worker lifecycle, exports. */

import {
  $, $$, clamp, hexToRgb01, luma, isGrey,
  toMM, fmtLength, fmtDuration, fmtBytes, fmtNum, toast, scheduleFrame,
} from './util.js';
import { ImageEditor, attachFrameControls } from './imageEditor.js';
import { buildSample } from './samples.js';
import { StringArtRenderer, renderResult, drawNailOverlay } from './render.js';
import { BuildGuide } from './guide.js';
import * as EX from './exporters.js';

const STAGE = 1000;       // px the result canvas is rendered at
const CROP = 300;         // px of the framing thumbnail
// Generous because this ships as a desktop app window rather than a shared
// browser tab; it still covers the whole range the sliders allow (500 nails
// at 900 px works out to roughly 645 MB).
const MEM_BUDGET = 1600 * 1048576;
const SEC_PER_LINE = 3.5; // rough human threading pace
const SETTINGS_KEY = 'stringart.settings';

const editor = new ImageEditor();
const guide = new BuildGuide();

let worker = null;
let running = false;
let paused = false;
let renderer = null;
let result = null;        // { layers, stats, opts, settings }
let liveOpts = null;
let threadSeq = 0;
let liveLayerIdx = -1;
let cfgLayers = [];       // layer configs for the run in flight

/* ─────────────────────────────────────────────────────────────
   Slider ⇄ readout plumbing
   ───────────────────────────────────────────────────────────── */
const FORMATTERS = {
  cropZoom: (v) => (+v).toFixed(2) + '×',
  cropRot: (v) => v + '°',
  nailOffset: (v) => v + '°',
  adjGamma: (v) => (+v).toFixed(2),
  adjSharpen: (v) => (+v).toFixed(1),
  adjVignette: (v) => (+v).toFixed(1),
  reusePen: (v) => (+v).toFixed(2),
  lenBias: (v) => (+v).toFixed(2),
  workRes: (v) => v + ' px',
};

function bindReadout(input) {
  const out = document.getElementById(input.id + 'Out');
  if (!out) return;
  const fmt = FORMATTERS[input.id] || ((v) => v);
  const sync = () => { out.textContent = fmt(input.value); };
  input.addEventListener('input', sync);
  sync();
}

/* ─────────────────────────────────────────────────────────────
   Image loading
   ───────────────────────────────────────────────────────────── */
function adoptImage(img) {
  editor.setImage(img);
  $('#cropWrap').classList.remove('hidden');
  $('#dropzone').querySelector('strong').textContent = 'Replace image';
  $('#emptyState').classList.add('hidden');
  $('#canvasStack').classList.add('has-image');
  $('#btnGenerate').disabled = false;
  syncFrameInputs();
  repaint();
}

function loadFile(file) {
  if (!file) return;
  if (file.name?.toLowerCase().endsWith('.json') || file.type === 'application/json') {
    importProject(file);
    return;
  }
  if (!file.type.startsWith('image/')) { toast('That file is not an image or a .json project.'); return; }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { adoptImage(img); URL.revokeObjectURL(url); toast(`Loaded ${file.name}`); };
  img.onerror = () => { URL.revokeObjectURL(url); toast('Could not decode that image.'); };
  img.src = url;
}

function wireImageInput() {
  const dz = $('#dropzone'), input = $('#fileInput');
  dz.addEventListener('click', () => input.click());
  dz.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files[0]) loadFile(input.files[0]);
    input.value = '';                    // re-picking the same file must re-fire
  });

  const proj = $('#projectInput');
  $('#btnOpenProject').addEventListener('click', () => proj.click());
  proj.addEventListener('change', () => {
    if (proj.files[0]) importProject(proj.files[0]);
    proj.value = '';
  });

  ['dragenter', 'dragover'].forEach((t) =>
    dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) =>
    dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove('is-over'); }));
  dz.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  window.addEventListener('paste', (e) => {
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) { loadFile(item.getAsFile()); return; }
    }
  });

  $$('[data-sample]').forEach((b) =>
    b.addEventListener('click', () => {
      adoptImage(buildSample(b.dataset.sample));
      toast('Loaded the ' + b.textContent.trim().toLowerCase() + ' sample');
    }));
}

/* ─────────────────────────────────────────────────────────────
   Framing + adjustments
   ───────────────────────────────────────────────────────────── */
function readAdjustments() {
  editor.bgHex = $('#bgColor').value;
  editor.adj = {
    brightness: +$('#adjBright').value,
    contrast: +$('#adjContrast').value,
    gamma: +$('#adjGamma').value,
    sharpen: +$('#adjSharpen').value,
    vignette: +$('#adjVignette').value,
    invert: $('#adjInvert').checked,
    color: $('#adjColor').checked,
  };
  editor.frame.zoom = +$('#cropZoom').value;
  editor.frame.rot = +$('#cropRot').value;
}

function syncFrameInputs() {
  $('#cropZoom').value = String(editor.frame.zoom);
  $('#cropRot').value = String(editor.frame.rot);
  $('#cropZoomOut').textContent = editor.frame.zoom.toFixed(2) + '×';
  $('#cropRotOut').textContent = editor.frame.rot + '°';
}

function syncAdjInputs() {
  $('#adjBright').value = String(editor.adj.brightness);
  $('#adjContrast').value = String(editor.adj.contrast);
  $('#adjGamma').value = String(editor.adj.gamma);
  $('#adjSharpen').value = String(editor.adj.sharpen);
  $('#adjVignette').value = String(editor.adj.vignette);
  $('#adjInvert').checked = editor.adj.invert;
  $('#adjColor').checked = editor.adj.color;
  $$('.panel input[type=range]').forEach((i) => i.dispatchEvent(new Event('input')));
}

let repaintQueued = false;
function repaint() {
  if (repaintQueued) return;
  repaintQueued = true;
  scheduleFrame(() => {
    repaintQueued = false;
    if (!editor.ready) return;
    readAdjustments();
    editor.paint($('#cropCanvas'), CROP);
    editor.paint($('#sourceCanvas'), 800);
    updateEstimates();
  });
}

function wireEditorControls() {
  attachFrameControls($('#cropCanvas'), editor, (fromWheel) => {
    if (fromWheel) syncFrameInputs();
    repaint();
  });

  ['#cropZoom', '#cropRot', '#adjBright', '#adjContrast', '#adjGamma',
   '#adjSharpen', '#adjVignette'].forEach((s) =>
    $(s).addEventListener('input', repaint));
  ['#adjInvert', '#adjColor', '#bgColor'].forEach((s) =>
    $(s).addEventListener('change', repaint));

  $('#btnCropReset').addEventListener('click', () => {
    editor.resetFrame(); syncFrameInputs(); repaint();
  });
  $('#btnCropFlip').addEventListener('click', () => {
    editor.frame.flip = !editor.frame.flip; repaint();
  });
  $('#btnAdjReset').addEventListener('click', () => {
    editor.resetAdjustments(); syncAdjInputs(); repaint();
  });
  $('#btnAuto').addEventListener('click', () => {
    if (!editor.ready) { toast('Load an image first.'); return; }
    readAdjustments();
    editor.autoLevels();
    syncAdjInputs();
    repaint();
    toast('Levels stretched to the full range');
  });
}

/* ─────────────────────────────────────────────────────────────
   Threads
   ───────────────────────────────────────────────────────────── */
function addThread(hex = '#111111', lines = 4000, alpha = 0.1) {
  const id = 't' + ++threadSeq;
  const el = document.createElement('div');
  el.className = 'thread';
  el.dataset.id = id;
  el.innerHTML = `
    <div class="thread-top">
      <input type="color" class="t-col" value="${hex}">
      <span class="thread-name">${hex}</span>
      <button class="thread-del" title="Remove this thread" aria-label="Remove this thread">&times;</button>
    </div>
    <div class="ctrl"><label>Lines <output class="t-lines-o">${lines}</output></label>
      <input type="range" class="t-lines" min="100" max="10000" step="50" value="${lines}"></div>
    <div class="ctrl"><label>Thread opacity <output class="t-alpha-o">${alpha.toFixed(2)}</output></label>
      <input type="range" class="t-alpha" min="0.02" max="1" step="0.01" value="${alpha}"></div>`;

  const col = el.querySelector('.t-col');
  col.addEventListener('input', () => {
    el.querySelector('.thread-name').textContent = col.value;
    updateEstimates();
  });
  el.querySelector('.t-lines').addEventListener('input', (e) => {
    el.querySelector('.t-lines-o').textContent = e.target.value;
    updateEstimates();
  });
  el.querySelector('.t-alpha').addEventListener('input', (e) => {
    el.querySelector('.t-alpha-o').textContent = (+e.target.value).toFixed(2);
  });
  el.querySelector('.thread-del').addEventListener('click', () => {
    el.remove(); refreshThreadChrome(); updateEstimates();
  });

  $('#threadList').appendChild(el);
  refreshThreadChrome();
  updateEstimates();
}

function refreshThreadChrome() {
  const rows = $$('.thread');
  rows.forEach((r) => { r.querySelector('.thread-del').style.visibility = rows.length > 1 ? '' : 'hidden'; });
  $('#btnAddThread').disabled = rows.length >= 6;
}

function readThreads() {
  return $$('.thread').map((el) => ({
    hex: el.querySelector('.t-col').value,
    lines: +el.querySelector('.t-lines').value,
    alpha: +el.querySelector('.t-alpha').value,
  }));
}

/* ─────────────────────────────────────────────────────────────
   Config
   ───────────────────────────────────────────────────────────── */
function boardMM() { return toMM(Math.max(1, +$('#boardSize').value || 1), $('#boardUnit').value); }

function buildConfig() {
  const nails = +$('#numNails').value;
  const size = +$('#workRes').value;
  const offsetRad = (+$('#nailOffset').value * Math.PI) / 180;
  const bgHex = $('#bgColor').value;
  const threads = readThreads();

  const wantColour = $('#adjColor').checked
    || !isGrey(bgHex) || threads.some((t) => !isGrey(t.hex));
  const channels = wantColour ? 3 : 1;

  const toChan = (hex) => {
    const rgb = hexToRgb01(hex);
    return channels === 1 ? [luma(rgb[0], rgb[1], rgb[2])] : rgb;
  };

  readAdjustments();
  const target = editor.buildTarget(size, channels);
  if (!target) return null;

  const start = clamp(+$('#startNail').value, 0, nails - 1);

  return {
    nails, size, offsetRad, channels, target,
    bg: toChan(bgHex), bgHex,
    minGap: clamp(+$('#minGap').value, 1, Math.floor(nails / 2)),
    reuse: +$('#reusePen').value,
    lenBias: +$('#lenBias').value,
    earlyStop: $('#earlyStop').checked,
    memBudget: MEM_BUDGET,
    layers: threads.map((t) => ({
      hex: t.hex, rgb: toChan(t.hex), alpha: t.alpha, lines: t.lines, start,
    })),
  };
}

function currentSettings() {
  return {
    nails: +$('#numNails').value,
    offsetDeg: +$('#nailOffset').value,
    boardSize: +$('#boardSize').value,
    boardUnit: $('#boardUnit').value,
    workRes: +$('#workRes').value,
    minGap: +$('#minGap').value,
    reuse: +$('#reusePen').value,
    lenBias: +$('#lenBias').value,
    startNail: +$('#startNail').value,
    earlyStop: $('#earlyStop').checked,
    bg: $('#bgColor').value,
    threads: readThreads(),
    adjustments: { ...editor.adj },
  };
}

/* ─────────────────────────────────────────────────────────────
   Estimates panel
   ───────────────────────────────────────────────────────────── */
function updateEstimates() {
  const nails = +$('#numNails').value;
  const size = +$('#workRes').value;
  const mm = boardMM();

  $('#startNail').max = String(nails - 1);
  if (+$('#startNail').value > nails - 1) {
    $('#startNail').value = String(nails - 1);
    $('#startNailOut').textContent = String(nails - 1);
  }
  $('#minGap').max = String(Math.max(1, Math.floor(nails / 3)));

  const spacing = (Math.PI * mm) / nails;
  $('#nailSpacingNote').textContent =
    `${nails} nails · ${fmtLength(spacing)} apart on the rim · ` +
    `rim length ${fmtLength(Math.PI * mm)}`;
  $('#nailSpacingNote').classList.toggle('warn', spacing < 2.5);
  if (spacing < 2.5) {
    $('#nailSpacingNote').textContent += ' — nails may be too close to drill';
  }

  const bytes = Math.round(((nails * (nails - 1)) / 2) * 1.15 * size) * 5;
  const note = $('#memNote');
  note.textContent = `Chord cache ≈ ${fmtBytes(bytes)} · ` +
    `${fmtNum((nails * (nails - 1)) / 2)} possible chords`;
  note.classList.toggle('warn', bytes > MEM_BUDGET);
  if (bytes > MEM_BUDGET) note.textContent += ' — too large, reduce nails or resolution';

  const totalLines = readThreads().reduce((s, t) => s + t.lines, 0);
  if (!running && !result) {
    $('#statTime').textContent = fmtDuration(totalLines * SEC_PER_LINE);
    $('#statLines').textContent = fmtNum(totalLines) + ' planned';
  }
  $('#btnGenerate').disabled = !editor.ready || running || bytes > MEM_BUDGET;
}

/* ─────────────────────────────────────────────────────────────
   Worker lifecycle
   ───────────────────────────────────────────────────────────── */
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./stringart.worker.js', import.meta.url));
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => {
    setRunning(false);
    toast('Solver error: ' + (e.message || 'unknown'));
    $('#progressTxt').textContent = 'Failed';
  };
  return worker;
}

function generate() {
  if (!editor.ready || running) return;
  const cfg = buildConfig();
  if (!cfg) return;

  liveOpts = {
    size: STAGE, workRes: cfg.size, bg: cfg.bgHex,
    nails: cfg.nails, offsetRad: cfg.offsetRad, boardMM: boardMM(),
  };
  renderer = new StringArtRenderer($('#resultCanvas'));
  renderer.reset(liveOpts);
  liveLayerIdx = -1;
  result = null;
  setExportsEnabled(false);
  $('#btnGuide').disabled = true;
  setView('result');
  setRunning(true);
  $('#progressTxt').textContent = 'Building chord cache…';
  $('#progressBar').style.width = '0%';

  cfgLayers = cfg.layers;
  ensureWorker().postMessage({ type: 'start', cfg }, [cfg.target.buffer]);
}

function onWorkerMessage(ev) {
  const m = ev.data;
  switch (m.type) {
    case 'phase':
      if (m.phase === 'cache') {
        $('#progressBar').style.width = (m.pct * 100).toFixed(0) + '%';
        $('#progressTxt').textContent = `Building chord cache — ${(m.pct * 100) | 0}%`;
      } else {
        $('#progressBar').style.width = '0%';
        $('#progressTxt').textContent = 'Threading…';
      }
      break;

    case 'lines':
      if ($('#liveDraw').checked && renderer) {
        if (m.layer !== liveLayerIdx) {
          liveLayerIdx = m.layer;
          const L = cfgLayers[m.layer];
          if (L) renderer.beginLayer(L.hex, L.alpha, L.start);
        }
        renderer.addSegments(m.segs);
      }
      break;

    case 'progress':
      $('#progressBar').style.width = (clamp(m.pct, 0, 1) * 100).toFixed(1) + '%';
      showStats(m.stats, false);
      break;

    case 'done':
      finishRun(m);
      break;

    case 'error':
      setRunning(false);
      $('#progressTxt').textContent = 'Stopped';
      toast(m.message, 6000);
      break;
  }
}

function finishRun(m) {
  setRunning(false);
  const opts = { ...liveOpts };
  result = {
    layers: m.layers,
    stats: {
      lines: m.stats.lines,
      match: m.stats.match,
      threadMM: (m.stats.threadPx * opts.boardMM) / (opts.workRes - 1),
      elapsed: m.stats.elapsed,
    },
    opts,
    settings: currentSettings(),
  };

  renderResult($('#resultCanvas'), result.layers, opts);   // clean, exact redraw
  showStats(m.stats, true);
  $('#progressBar').style.width = '100%';
  $('#progressTxt').textContent = m.cancelled
    ? `Stopped at ${fmtNum(m.stats.lines)} lines`
    : `Done — ${fmtNum(m.stats.lines)} lines`;

  setExportsEnabled(true);
  $('#btnGuide').disabled = false;
  updateNailOverlay();
  saveSettings();
  if (!m.cancelled) toast('Finished — open the Build Guide to thread it');
}

function showStats(s, final) {
  const opts = liveOpts || {};
  const mm = (s.threadPx * (opts.boardMM || 0)) / Math.max(1, (opts.workRes || 1) - 1);
  $('#statLines').textContent = fmtNum(s.lines) + (final ? '' : ` / ${fmtNum(s.total)}`);
  $('#statLen').textContent = fmtLength(mm);
  $('#statErr').textContent = (s.match * 100).toFixed(1) + '%';
  $('#statTime').textContent = fmtDuration(s.lines * SEC_PER_LINE);
  $('#statCompute').textContent = (s.elapsed / 1000).toFixed(1) + ' s';
}

function setRunning(on) {
  running = on;
  paused = false;
  $('#btnGenerate').disabled = on || !editor.ready;
  $('#btnPause').disabled = !on;
  $('#btnStop').disabled = !on;
  $('#btnPause').textContent = 'Pause';
  $('#sidebar').style.opacity = on ? '.72' : '';
  if (!on) updateEstimates();
}

function setExportsEnabled(on) {
  $$('[data-export]').forEach((b) => { b.disabled = !on; });
}

/* ─────────────────────────────────────────────────────────────
   Stage views
   ───────────────────────────────────────────────────────────── */
let splitPct = 50;

function setView(v) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === v));
  const res = $('#resultCanvas'), src = $('#sourceCanvas'), handle = $('#splitHandle');
  res.classList.toggle('hidden', v === 'source');
  src.classList.toggle('hidden', v === 'result');
  handle.classList.toggle('hidden', v !== 'split');
  res.style.clipPath = v === 'split' ? `inset(0 0 0 ${splitPct}%)` : '';
  if (v === 'split') handle.style.left = splitPct + '%';
}

function currentView() {
  return $('.tab.is-active').dataset.view;
}

function wireStage() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));

  const stack = $('#canvasStack'), handle = $('#splitHandle');
  let dragging = false;
  const move = (e) => {
    if (!dragging) return;
    const r = stack.getBoundingClientRect();
    splitPct = clamp(((e.clientX - r.left) / r.width) * 100, 0, 100);
    setView('split');
  };
  handle.addEventListener('pointerdown', (e) => {
    dragging = true; handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', (e) => {
    dragging = false;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* gone */ }
  });

  $('#showNails').addEventListener('change', updateNailOverlay);
  $('#liveDraw').addEventListener('change', () => {
    if (!$('#liveDraw').checked) $('#progressTxt').textContent = 'Threading (preview off)…';
  });
}

function updateNailOverlay() {
  const ov = $('#overlayCanvas');
  const opts = liveOpts || {
    size: STAGE, nails: +$('#numNails').value,
    offsetRad: (+$('#nailOffset').value * Math.PI) / 180,
  };
  if (!$('#showNails').checked) {
    ov.width = ov.width;   // clear
    return;
  }
  drawNailOverlay(ov, { ...opts, size: STAGE });
}

/* ─────────────────────────────────────────────────────────────
   Exports
   ───────────────────────────────────────────────────────────── */
function wireExports() {
  const actions = {
    png: () => EX.exportPNG(result),
    svg: () => EX.exportSVG(result),
    txt: () => EX.exportTXT(result),
    csv: () => EX.exportCSV(result),
    json: () => EX.exportJSON(result),
    template: () => EX.exportTemplate(result),
    copy: async () => {
      try {
        await EX.copySequence(result);
        toast('Sequence copied to the clipboard');
      } catch {
        toast('Clipboard blocked — use the .txt export instead');
      }
      return null;
    },
  };
  $$('[data-export]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!result) return;
      b.disabled = true;
      try {
        const name = await actions[b.dataset.export]();
        if (name) toast('Saved ' + name);      // null means the user cancelled
      } catch (err) {
        toast('Export failed: ' + err.message);
      } finally {
        b.disabled = false;
      }
    }));
}

/* ─────────────────────────────────────────────────────────────
   Settings persistence
   ───────────────────────────────────────────────────────────── */
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings())); }
  catch { /* storage unavailable */ }
}

/** Push a saved settings object back into the controls. */
function applySettings(s) {
  const set = (sel, v) => { if (v !== undefined && v !== null) $(sel).value = String(v); };
  set('#numNails', s.nails); set('#nailOffset', s.offsetDeg);
  set('#boardSize', s.boardSize); set('#boardUnit', s.boardUnit);
  set('#workRes', s.workRes); set('#minGap', s.minGap);
  set('#reusePen', s.reuse); set('#lenBias', s.lenBias);
  set('#startNail', s.startNail); set('#bgColor', s.bg);
  if (typeof s.earlyStop === 'boolean') $('#earlyStop').checked = s.earlyStop;
  if (s.adjustments) { editor.adj = { ...editor.adj, ...s.adjustments }; syncAdjInputs(); }

  $('#threadList').innerHTML = '';
  (s.threads?.length ? s.threads : [{}]).forEach((t) =>
    addThread(t.hex ?? '#111111', t.lines ?? 4000, t.alpha ?? 0.1));
  $$('.panel input[type=range]').forEach((i) => i.dispatchEvent(new Event('input')));
}

function restoreSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch { /* ignore */ }
  if (!s) { addThread(); return; }
  applySettings(s);
}

/* ─────────────────────────────────────────────────────────────
   Opening a saved .json project
   ───────────────────────────────────────────────────────────── */
async function importProject(file) {
  let doc;
  try { doc = JSON.parse(await file.text()); }
  catch { toast('That file is not valid JSON.'); return; }

  if (doc.generator !== 'String Art Studio' || !Array.isArray(doc.threads) || !doc.threads.length) {
    toast('That does not look like a String Art Studio project file.');
    return;
  }

  const board = doc.board || {};
  const settings = doc.settings || {};
  const opts = {
    size: STAGE,
    workRes: settings.workRes || 500,
    bg: board.colour || '#ffffff',
    nails: board.nails || 240,
    offsetRad: ((board.firstNailAngleDeg ?? -90) * Math.PI) / 180,
    boardMM: board.diameterMM || 600,
  };
  const layers = doc.threads
    .filter((t) => Array.isArray(t.path) && t.path.length > 1)
    .map((t) => ({ color: t.colour || '#111111', alpha: t.opacity ?? 0.1, path: t.path }));
  if (!layers.length) { toast('That project has no thread paths in it.'); return; }

  if (Object.keys(settings).length) applySettings(settings);

  liveOpts = opts;
  result = {
    layers,
    stats: {
      lines: doc.stats?.lines ?? layers.reduce((n, L) => n + L.path.length - 1, 0),
      match: doc.stats?.match ?? 0,
      threadMM: doc.stats?.threadMM ?? 0,
      elapsed: doc.stats?.elapsed ?? 0,
    },
    opts,
    settings,
  };

  renderResult($('#resultCanvas'), layers, opts);
  $('#emptyState').classList.add('hidden');
  $('#canvasStack').classList.add('has-image');
  setView('result');
  updateNailOverlay();

  $('#statLines').textContent = fmtNum(result.stats.lines);
  $('#statLen').textContent = fmtLength(result.stats.threadMM);
  $('#statErr').textContent = result.stats.match
    ? (result.stats.match * 100).toFixed(1) + '%' : '—';
  $('#statTime').textContent = fmtDuration(result.stats.lines * SEC_PER_LINE);
  $('#statCompute').textContent = result.stats.elapsed
    ? (result.stats.elapsed / 1000).toFixed(1) + ' s' : '—';
  $('#progressBar').style.width = '100%';
  $('#progressTxt').textContent = `Opened project — ${fmtNum(result.stats.lines)} lines`;

  setExportsEnabled(true);
  $('#btnGuide').disabled = false;
  toast('Project opened — Build Guide is ready');
}

/* ─────────────────────────────────────────────────────────────
   Boot
   ───────────────────────────────────────────────────────────── */
function init() {
  $$('.panel input[type=range], .crop-wrap input[type=range]').forEach(bindReadout);

  wireImageInput();
  wireEditorControls();
  wireStage();
  wireExports();

  $('#btnAddThread').addEventListener('click', () => addThread('#111111', 1500, 0.12));
  $('#btnGenerate').addEventListener('click', generate);
  $('#btnStop').addEventListener('click', () => worker?.postMessage({ type: 'stop' }));
  $('#btnPause').addEventListener('click', () => {
    if (!running) return;
    paused = !paused;
    worker.postMessage({ type: paused ? 'pause' : 'resume' });
    $('#btnPause').textContent = paused ? 'Resume' : 'Pause';
    $('#progressTxt').textContent = paused ? 'Paused' : 'Threading…';
  });
  $('#btnGuide').addEventListener('click', () => result && guide.open(result));
  $('#btnResetAll').addEventListener('click', () => {
    if (!confirm('Reset every board, thread and image setting back to defaults?')) return;
    try { localStorage.removeItem(SETTINGS_KEY); } catch { /* storage unavailable */ }
    // the unload save would otherwise write the old values straight back
    window.removeEventListener('beforeunload', saveSettings);
    location.reload();
  });

  ['#numNails', '#nailOffset', '#workRes', '#minGap', '#startNail'].forEach((s) =>
    $(s).addEventListener('input', updateEstimates));
  ['#boardSize', '#boardUnit'].forEach((s) => $(s).addEventListener('input', updateEstimates));
  ['#numNails', '#nailOffset'].forEach((s) => $(s).addEventListener('input', updateNailOverlay));

  // App-window shortcuts. Edge's own Ctrl+S / Ctrl+O are suppressed in
  // --app mode, so these are free to use.
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (!$('#guideModal').classList.contains('hidden')) return;
    const mod = e.ctrlKey || e.metaKey;
    const hit = (fn) => { e.preventDefault(); fn(); };

    if (!mod && e.key === 'g') return hit(generate);
    if (!mod && e.key === 'Escape' && running) return hit(() => $('#btnStop').click());
    if (!mod && e.key === ' ' && running) return hit(() => $('#btnPause').click());
    if (mod && e.key === 'o') return hit(() => $('#fileInput').click());
    if (mod && e.shiftKey && e.key.toLowerCase() === 'o') return hit(() => $('#projectInput').click());
    if (mod && e.key === 's') return hit(() => $('[data-export="png"]').click());
    if (mod && e.key === 'e') return hit(() => $('[data-export="txt"]').click());
    if (mod && e.key === 'g') return hit(() => { if (result) guide.open(result); });
  });
  window.addEventListener('beforeunload', saveSettings);

  restoreSettings();
  refreshThreadChrome();
  updateEstimates();
  setView('result');
}

init();
