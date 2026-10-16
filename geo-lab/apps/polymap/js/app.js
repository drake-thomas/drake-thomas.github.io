// App controller: state, rebuild pipeline, interaction, presets, persistence.
import * as V from './vec.js';
import * as P from './polyhedra.js';
import * as Gm from './geometry.js';
import * as N from './net.js';
import * as W from './world.js';
import { GlobeView, NetView } from './render.js';
import { flattenGeometry } from './optimize-core.js';

const STORE_KEY = 'polymaplab-v1';
const EARTH_KM = 6371;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state
const defaultCfg = () => ({ notation: 'I', geodesic: 1, stretch: [1, 1, 1], truncV: 0, chamferE: 0, flatSplit: 'none', faceSplits: [], custom: null });

function viewFromLonLat(lon, lat) {
  const z = V.lonLatToVec(lon, lat);
  const l = (lon * Math.PI) / 180;
  const x = [-Math.sin(l), Math.cos(l), 0];
  const y = V.cross(z, x);
  return V.qFromMat([...x, ...y, ...z]);
}

const app = {
  cfg: defaultCfg(),
  mode: 'fuller',
  qR: [1, 0, 0, 0], R: null,
  qV: viewFromLonLat(15, 25), Vm: null,
  net: N.emptyNet(),
  netGen: 'land',
  G: null, L: null,
  world: null, tex: null,
  display: { raster: true, coast: true, borders: false, graticule: true, tint: true, labels: false, tissot: false },
  hover: { face: -1, edge: -1 },
  dragMode: 'poly',
  tool: 'cut',
  overlaps: new Set(),
  landW: null,
  faceColors: [],
  busy: false,
};
app.R = V.qToMat(app.qR);
app.Vm = V.qToMat(app.qV);

let globeView, netView;

// ------------------------------------------------------------------ render scheduling
const dirty = { globe: true, globeRaster: true, net: true, netRaster: true, netLines: true };
let interactive = false, idleTimer = null, rafPending = false;
const lowRes = { globe: false, net: false };

function invalidate(flags) {
  for (const k of flags) {
    dirty[k] = true;
    if (k === 'globeRaster') dirty.globe = true;
    if (k === 'netRaster' || k === 'netLines') dirty.net = true;
  }
  if (!rafPending) { rafPending = true; requestAnimationFrame(frame); }
}
const ALL = ['globe', 'globeRaster', 'net', 'netRaster', 'netLines'];

function frame() {
  rafPending = false;
  if (!app.G || !app.world) return;
  const q = interactive ? 0.5 : 1;
  if (dirty.netLines) { netView.invalidateLines(); dirty.netLines = false; dirty.netRaster = true; }
  if (dirty.globe) {
    globeView.draw(q, dirty.globeRaster);
    if (dirty.globeRaster) lowRes.globe = interactive;
  }
  if (dirty.net) {
    netView.draw(q, dirty.netRaster);
    if (dirty.netRaster) lowRes.net = interactive;
  }
  dirty.globe = dirty.globeRaster = dirty.net = dirty.netRaster = false;
}
function markInteractive() {
  interactive = true;
  app.interactive = true;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    interactive = false;
    app.interactive = false;
    const f = [];
    if (netView.lineCache && netView.lineCache.lo) f.push('net');
    if (lowRes.globe) f.push('globeRaster');
    if (lowRes.net) f.push('netRaster');
    if (f.length) invalidate(f);
  }, 200);
}

// ------------------------------------------------------------------ helpers
function toast(msg, err = false, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(s) { $('status').textContent = s; }

function makeFaceColors(G) {
  const out = [];
  for (let i = 0; i < G.F; i++) {
    const h = (i * 137.508) % 360, s = 0.55, l = 0.6;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    out.push([Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]);
  }
  return out;
}

function setOrientation(q, { live = false } = {}) {
  app.qR = V.qnormalize(q);
  app.R = V.qToMat(app.qR);
  syncOrientationSliders();
  invalidate(['globe', 'globeRaster', 'netLines']);
  if (!live) afterOrientationChange();
}
function afterOrientationChange() {
  updateLand();
  updateStats();
  save();
}

// ------------------------------------------------------------------ pipeline
/**
 * Rebuild polyhedron + geometry from app.cfg.
 * netMode: 'keep' (keep net if still valid, else regenerate), 'reset' (regenerate), 'migrate' (after face split)
 */
function rebuild(netMode = 'keep') {
  let res, G;
  try {
    res = P.buildPoly(app.cfg);
    G = Gm.buildGeometry(res.poly);
  } catch (e) {
    console.error(e);
    toast(e.message, true, 5000);
    return false;
  }
  if (res.appliedSplits < app.cfg.faceSplits.length) app.cfg.faceSplits.length = res.appliedSplits;
  const oldG = app.G;
  app.G = G;
  app.faceColors = makeFaceColors(G);
  app.hover = { face: -1, edge: -1 };
  updateLand();
  if (netMode === 'migrate' && oldG) {
    app.net = N.migrateNet(oldG, G, app.net, (g, p) => Gm.locate(g, p, 0));
    app.netGen = 'custom';
    relayout();
  } else if (netMode === 'keep' && netValid(G, app.net)) {
    N.sanitize(G, app.net);
    relayout();
  } else {
    generateNet(app.netGen === 'custom' ? 'land' : app.netGen);
  }
  updatePolyInfo();
  return true;
}

function netValid(G, net) {
  for (const k of net.folds) if (!G.edgeByKey.has(k)) return false;
  let anyAnchor = false;
  for (const k of net.anchors.keys()) if (G.faceByKey.has(k)) anyAnchor = true;
  return anyAnchor;
}

function relayout({ fit = false } = {}) {
  app.L = N.computeLayout(app.G, app.net);
  app.overlaps = N.findOverlaps(app.G, app.L);
  if (fit) netView.fit(N.layoutBBox(app.G, app.L));
  updateStats();
  invalidate(ALL);
  save();
}

function updateLand() {
  if (!app.G || !app.world) return;
  app.landW = W.edgeLandWeights(app.G, app.R, app.world.mask);
}

// ------------------------------------------------------------------ net generation
function generateNet(kind, { fit = true } = {}) {
  const G = app.G;
  let folds;
  switch (kind) {
    case 'bfs': folds = N.bfsTree(G, centralFace()); break;
    case 'dfs': folds = N.dfsTree(G, centralFace()); break;
    case 'random': folds = N.randomTree(G); break;
    case 'explode': folds = new Set(); break;
    case 'butterfly': folds = N.treeFromWeights(G, butterflyWeights()); break;
    case 'land':
    default: {
      kind = 'land';
      const w = app.landW.map((x, i) => x + 1e-6 * G.edges[i].len + 1e-9 * ((i * 7919) % 101));
      folds = N.treeFromWeights(G, w);
    }
  }
  app.net = { folds, anchors: new Map() };
  if (folds.size) app.net.anchors.set(G.faces[N.treeCenter(G, folds, centralFace())].key, [0, 0, 0]);
  app.netGen = kind;
  app.L = N.computeLayout(G, app.net);
  northUpAll(false);
  N.arrangePieces(G, app.net, app.L);
  relayout({ fit });
}

/** Face currently facing the globe viewer (nice root for compact nets). */
function centralFace() {
  const E = V.mulMtV(app.Vm, [0, 0, 1]);
  return Gm.locate(app.G, V.mulMtV(app.R, E), 0);
}

/** Cahill/Waterman-like preference: keep the equator and the northern hemisphere together, cut the Pacific. */
function butterflyWeights() {
  const G = app.G;
  return G.edges.map((e) => {
    const m = V.mulMV(app.R, V.norm(V.add(G.vdir[e.a], G.vdir[e.b])));
    const [lon, lat] = V.vecToLonLat(m);
    let w = 0;
    w += 3 * Math.cos((lat * Math.PI) / 180) ** 4;            // equator strongly preferred
    w += lat > -5 ? 1.5 : -1.5;                                // north + equator kept, south cut
    const dl = Math.abs(((lon - 160 + 540) % 360) - 180);       // distance from the 160E cut meridian
    if (lat > 5 && dl < 30) w -= 6;
    return w + 0.2 * (app.landW[e.id] || 0);
  });
}

function northUp(ci) {
  const G = app.G, L = app.L;
  const c = N.pieceCentroid(G, L, ci);
  // face of the piece nearest the centroid
  let best = -1, bd = Infinity;
  for (const f of L.comps[ci].faces) {
    const w = N.tApply(L.M[f], G.faces[f].cl);
    const d = Math.hypot(w[0] - c[0], w[1] - c[1]);
    if (d < bd) { bd = d; best = f; }
  }
  const fd = G.faces[best];
  const Pp = fd.A;
  const E = V.mulMV(app.R, Pp);
  const t = V.sub([0, 0, 1], V.scale(E, E[2]));
  if (V.len(t) < 1e-6) return;
  const E2 = V.norm(V.add(E, V.scale(V.norm(t), 0.01)));
  const P2 = V.mulMtV(app.R, E2);
  const a = N.tApply(L.M[best], Gm.forwardInFace(G, best, Pp, app.mode));
  const b = N.tApply(L.M[best], Gm.forwardInFace(G, best, P2, app.mode));
  const ang = Math.PI / 2 - Math.atan2(b[1] - a[1], b[0] - a[0]);
  N.rotatePiece(G, app.net, L, ci, ang, c);
}
function northUpAll(doRelayout = true) {
  for (let i = 0; i < app.L.comps.length; i++) northUp(i);
  if (doRelayout) relayout();
}

// ------------------------------------------------------------------ stats / info
const NAMES = {
  T: 'tetrahedron', C: 'cube', O: 'octahedron', D: 'dodecahedron', I: 'icosahedron',
  aC: 'cuboctahedron', aD: 'icosidodecahedron', tT: 'truncated tetrahedron', tC: 'truncated cube', tO: 'truncated octahedron',
  tD: 'truncated dodecahedron', tI: 'truncated icosahedron', eC: 'rhombicuboctahedron', eD: 'rhombicosidodecahedron',
  bC: 'truncated cuboctahedron', bD: 'truncated icosidodecahedron', sC: 'snub cube', sD: 'snub dodecahedron',
  jC: 'rhombic dodecahedron', jD: 'rhombic triacontahedron', kT: 'triakis tetrahedron', kC: 'tetrakis hexahedron',
  kO: 'triakis octahedron', kD: 'pentakis dodecahedron', kI: 'triakis icosahedron', oC: 'deltoidal icositetrahedron',
  oD: 'deltoidal hexecontahedron', gC: 'pentagonal icositetrahedron', gD: 'pentagonal hexecontahedron',
  mC: 'disdyakis dodecahedron', mD: 'disdyakis triacontahedron', cD: 'chamfered dodecahedron (Goldberg)',
  cC: 'chamfered cube', ccD: 'Goldberg GP(4,0)', dP: 'bipyramid',
  '@pent48': 'pentagonal monohedron, 48 congruent faces', '@pent120': 'pentagonal monohedron, 120 congruent faces',
  gaC: 'gyro cuboctahedron (canonical)', gaD: 'gyro icosidodecahedron (canonical)',
};

function updatePolyInfo() {
  const G = app.G, poly = G.poly;
  const hist = {};
  poly.faces.forEach((f) => (hist[f.length] = (hist[f.length] || 0) + 1));
  const faceDesc = Object.entries(hist).map(([k, v]) => `${v}×${k}-gon`).join(', ');
  const nm = app.cfg.custom ? 'custom' : (NAMES[app.cfg.notation] || (/^P\d+$/.test(app.cfg.notation) ? 'prism' : /^A\d+$/.test(app.cfg.notation) ? 'antiprism' : /^Y\d+$/.test(app.cfg.notation) ? 'pyramid' : ''));
  $('polyInfo').innerHTML = `${nm ? `<b>${nm}</b><br>` : ''}V ${poly.verts.length} · E ${G.edges.length} · F ${G.F}<br>${faceDesc}`;
  const n = app.cfg.faceSplits.length;
  $('splitInfo').textContent = n ? `${n} individual face split${n > 1 ? 's' : ''}` : 'No individual face splits';
}

function updateStats() {
  if (!app.G || !app.L || !app.landW) return;
  const G = app.G;
  let cutLand = 0, cutLen = 0, nCuts = 0;
  for (const e of G.edges) if (!app.net.folds.has(e.key)) { cutLand += app.landW[e.id]; cutLen += e.len; nCuts++; }
  const pieces = app.L.comps.length;
  const ov = app.overlaps.size;
  $('netStats').innerHTML =
    `<b>${pieces}</b> piece${pieces > 1 ? 's' : ''} · <b>${nCuts}</b> cut edges · ${G.edges.length - nCuts} folds<br>` +
    `Land crossed by cuts: <b>${Math.round(cutLand * EARTH_KM).toLocaleString()} km</b> ` +
    `<span class="muted">(${(100 * cutLand / Math.max(cutLen, 1e-9)).toFixed(1)}% of cut length)</span><br>` +
    (ov ? `<span style="color:#b03a2e">⚠ ${ov} faces overlap in the net</span>` : '<span class="muted">No overlapping faces</span>');
}

// ------------------------------------------------------------------ orientation sliders (ZYX Euler)
function eulerToQ(yaw, pitch, roll) {
  const d = Math.PI / 180;
  return V.qmul(V.qmul(V.qFromAxisAngle([0, 0, 1], yaw * d), V.qFromAxisAngle([0, 1, 0], pitch * d)), V.qFromAxisAngle([1, 0, 0], roll * d));
}
function qToEuler(R) {
  const d = 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, -R[6])));
  return [Math.atan2(R[3], R[0]) * d, pitch * d, Math.atan2(R[7], R[8]) * d];
}
function syncOrientationSliders() {
  const [y, p, r] = qToEuler(app.R);
  for (const [id, v] of [['yaw', y], ['pitch', p], ['roll', r]]) {
    $(id).value = v.toFixed(1);
    $(id + 'Out').textContent = Math.round(v);
  }
}

/** Rotate so that poly-frame direction p (nearest candidate to current north) points to the north pole. */
function featureToNorth(kind) {
  const G = app.G;
  let cands;
  if (kind === 'v') cands = G.vdir;
  else if (kind === 'f') cands = G.faces.map((f) => f.A);
  else cands = G.edges.map((e) => V.norm(V.add(G.vdir[e.a], G.vdir[e.b])));
  let best = null, bd = -Infinity;
  for (const c of cands) {
    const E = V.mulMV(app.R, c);
    if (E[2] > bd) { bd = E[2]; best = E; }
  }
  setOrientation(V.qmul(V.qFromTwoVecs(best, [0, 0, 1]), app.qR));
}

// Fuller's Dymaxion icosahedron (vertex positions from R. W. Gray's dymax.c)
const FULLER_V1 = [0.420152426708710003, 0.078145249402782959, 0.904082550615019298];
const FULLER_V2 = [0.995009439436241649, -0.091347795276427931, 0.040147175877166645];

function orientationFor(name) {
  if (name === 'fuller') {
    const ico = P.fromNotation('I').verts.map(V.norm);
    const a = ico[0];
    const b = ico.find((v) => Math.abs(V.dot(a, v) - 1 / Math.sqrt(5)) < 1e-6);
    return V.qAlign(a, b, FULLER_V1, FULLER_V2);
  }
  if (name === 'cahill') {
    // octahedron: one vertex at the north pole, equatorial vertices at 20W, 70E, 160E, 110W
    const oct = P.fromNotation('O').verts.map(V.norm);
    const top = oct.reduce((m, v) => (v[2] > m[2] ? v : m));
    const eq = oct.find((v) => Math.abs(V.dot(v, top)) < 1e-6);
    return V.qAlign(top, eq, [0, 0, 1], V.lonLatToVec(-20, 0));
  }
  if (name === 'faceNorth') {
    const G = Gm.buildGeometry(P.buildPoly(app.cfg).poly);
    const top = G.faces.reduce((m, f) => (f.A[2] > m[2] ? f.A : m), [0, 0, -2]);
    return V.qFromTwoVecs(top, [0, 0, 1]);
  }
  return [1, 0, 0, 0];
}

// ------------------------------------------------------------------ optimizer (Web Worker)
let opt = null; // running optimization: { worker, resolve, best, before, fixed, lastPreview }
let optUndo = null;

function landOnCutsKm() {
  let s = 0;
  for (const e of app.G.edges) if (!app.net.folds.has(e.key)) s += app.landW[e.id];
  return s * EARTH_KM;
}

/** Run the optimizer. Options default to the panel's settings. Resolves when finished or stopped. */
function optimize(opts = {}) {
  if (opt) { stopOptimize(); return Promise.resolve(); }
  const fixed = opts.fixed ?? $('optFixed').checked;
  const spinOnly = opts.spinOnly ?? $('optSpin').checked;
  const effort = opts.effort ?? +$('optEffort').value;
  const clearanceKm = opts.clearanceKm ?? +$('optClear').value;
  const G = app.G;
  const geom = flattenGeometry(G, fixed ? app.net.folds : null);

  const before = { qR: app.qR.slice(), net: N.netToJSON(app.net), netGen: app.netGen, land: landOnCutsKm() };
  const worker = new Worker(new URL('./optimizer-worker.js', import.meta.url), { type: 'module' });
  const bar = $('optProgress');
  bar.hidden = false; bar.firstChild.style.width = '0%';
  $('optRun').textContent = 'Stop';
  $('optResult').hidden = true;
  const t0 = performance.now();
  return new Promise((resolve) => {
    opt = { worker, resolve, best: null, before, fixed, lastPreview: 0, t0 };
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'error') { toast('Optimizer: ' + m.message, true); finishOptimize(); return; }
      opt.best = m.best;
      bar.firstChild.style.width = `${(100 * m.frac).toFixed(1)}%`;
      setStatus(`${m.phase}… land under cuts ${Math.round(m.landKm).toLocaleString()} km` +
        (clearanceKm > 0 ? ` · objective ${Math.round(m.bestCost).toLocaleString()}` : ''));
      if (m.type === 'done') { finishOptimize(); return; }
      const now = performance.now();
      if ($('optPreview').checked && now - opt.lastPreview > 250) {
        opt.lastPreview = now;
        previewOrientation(m.best, fixed);
      }
    };
    worker.onerror = (e) => { toast('Optimizer failed: ' + e.message, true); finishOptimize(); };
    worker.postMessage({
      type: 'run',
      geom,
      mask: app.world.mask.slice(), maskW: W.MASK_W, maskH: W.MASK_H,
      start: app.qR, effort, clearanceKm, spinOnly,
    });
  });
}

function previewOrientation(q, fixed) {
  setOrientation(q, { live: true });
  updateLand();
  if (fixed) updateStats();
  else generateNet('land', { fit: false });
}

function stopOptimize() { if (opt) finishOptimize(); }

function finishOptimize() {
  const o = opt;
  if (!o) return;
  opt = null;
  o.worker.terminate();
  $('optProgress').hidden = true;
  $('optRun').textContent = 'Optimize';
  if (o.best) {
    setOrientation(o.best);
    if (o.fixed) {
      // restore the exact net the user had (previews don't touch it in fixed mode)
      app.net = N.netFromJSON(o.before.net);
      app.netGen = o.before.netGen;
      relayout();
    } else generateNet('land');
    optUndo = o.before;
    $('optRevert').disabled = false;
    const after = landOnCutsKm();
    const secs = ((performance.now() - o.t0) / 1000).toFixed(1);
    const r = $('optResult');
    r.hidden = false;
    r.innerHTML = `Land under cuts: <b>${Math.round(o.before.land).toLocaleString()}</b> → <b>${Math.round(after).toLocaleString()} km</b><br>` +
      `<span class="muted">${o.fixed ? 'fixed net' : 'best net per rotation'} · ${secs} s</span>`;
    setStatus(`Optimization finished in ${secs} s`);
  }
  o.resolve();
}

function revertOptimize() {
  if (!optUndo || opt) return;
  const u = optUndo;
  optUndo = null;
  $('optRevert').disabled = true;
  app.net = N.netFromJSON(u.net);
  app.netGen = u.netGen;
  setOrientation(u.qR);
  relayout({ fit: true });
  $('optResult').hidden = true;
}

// ------------------------------------------------------------------ face splitting
function splitAt(face, type) {
  const key = app.G.faces[face].key;
  app.cfg.faceSplits.push({ key, type });
  if (!rebuild('migrate')) app.cfg.faceSplits.pop();
}

// ------------------------------------------------------------------ presets
const BASES = [
  ['Platonic', [['T', 'Tetrahedron'], ['C', 'Cube'], ['O', 'Octahedron'], ['D', 'Dodecahedron'], ['I', 'Icosahedron']]],
  ['Archimedean', [['aC', 'Cuboctahedron'], ['aD', 'Icosidodecahedron'], ['tT', 'Truncated tetrahedron'], ['tC', 'Truncated cube'],
    ['tO', 'Truncated octahedron'], ['tD', 'Truncated dodecahedron'], ['tI', 'Truncated icosahedron'], ['eC', 'Rhombicuboctahedron'],
    ['eD', 'Rhombicosidodecahedron'], ['bC', 'Truncated cuboctahedron'], ['bD', 'Truncated icosidodecahedron'], ['sC', 'Snub cube'], ['sD', 'Snub dodecahedron']]],
  ['Catalan', [['jC', 'Rhombic dodecahedron'], ['jD', 'Rhombic triacontahedron'], ['kT', 'Triakis tetrahedron'], ['kC', 'Tetrakis hexahedron'],
    ['kO', 'Triakis octahedron'], ['kD', 'Pentakis dodecahedron'], ['kI', 'Triakis icosahedron'], ['oC', 'Deltoidal icositetrahedron'],
    ['oD', 'Deltoidal hexecontahedron'], ['gC', 'Pentagonal icositetrahedron'], ['mC', 'Disdyakis dodecahedron'], ['mD', 'Disdyakis triacontahedron']]],
  ['Prisms & co.', [['P3', 'Triangular prism'], ['P5', 'Pentagonal prism'], ['P6', 'Hexagonal prism'], ['A4', 'Square antiprism'],
    ['A5', 'Pentagonal antiprism'], ['dP4', 'Octagonal… square bipyramid'], ['dP5', 'Pentagonal bipyramid'], ['dA5', 'Pentagonal trapezohedron'], ['Y4', 'Square pyramid']]],
  ['Pentagonal monohedra (congruent faces)', [['@pent48', '48 congruent pentagons (O)'], ['@pent120', '120 congruent pentagons (I)'],
    ['gaC', 'Same map, canonical: gyro cuboctahedron'], ['gaD', 'Same map, canonical: gyro icosidodecahedron']]],
  ['Goldberg / geodesic', [['cD', 'Chamfered dodecahedron'], ['cC', 'Chamfered cube'], ['tkD', 'Goldberg GP(3,0)'], ['ccD', 'Goldberg GP(4,0)'], ['kD', 'Geodesic seed (kD)']]],
];

const PRESETS = [
  { id: 'dymaxion', label: 'Dymaxion — Fuller icosahedron', cfg: { notation: 'I' }, mode: 'fuller', orient: 'fuller', net: 'land',
    note: "Fuller's 1954 icosahedron orientation (vertices from R. W. Gray). The net is an automatic ocean-cut tree; Fuller's own layout also split two faces — try the split tools around Australia/Asia." },
  { id: 'fuller43', label: 'Fuller 1943 — cuboctahedron', cfg: { notation: 'aC' }, mode: 'fuller', orient: 'optimize', net: 'land',
    note: "Fuller's first Dymaxion (Life, 1943) used a cuboctahedron: 8 triangles + 6 squares. Orientation found by searching for the fewest land cuts." },
  { id: 'cahill', label: 'Cahill-style butterfly — octahedron', cfg: { notation: 'O' }, mode: 'fuller', orient: 'cahill', net: 'butterfly',
    note: 'Octants bounded by the equator and the 20°W / 70°E / 160°E / 110°W meridians; northern octants joined at the pole, southern ones hanging below.' },
  { id: 'waterman', label: 'Waterman-style butterfly — truncated octahedron', cfg: { notation: 'O', truncV: 0.42 }, mode: 'fuller', orient: 'cahill', net: 'butterfly',
    note: 'An octahedron with its corners truncated (non-uniform: tweak "Truncate vertices"), in the butterfly orientation. Cut and join edges to explore Waterman-like layouts.' },
  { id: 'snyder', label: 'Truncated icosahedron — equal-area', cfg: { notation: 'tI' }, mode: 'equal', orient: 'optimize', net: 'land',
    note: 'The "soccer ball" (Snyder 1992 studied equal-area maps on it).' },
  { id: 'cube', label: 'Cube — gnomonic', cfg: { notation: 'C' }, mode: 'gnomonic', orient: 'faceNorth', net: 'bfs',
    note: 'Classic gnomonic cube map (like a skybox / cube-map).' },
  { id: 'dodeca', label: 'Dodecahedron', cfg: { notation: 'D' }, mode: 'fuller', orient: 'optimize', net: 'land', note: '' },
  { id: 'rtc', label: 'Rhombic triacontahedron', cfg: { notation: 'jD' }, mode: 'fuller', orient: 'optimize', net: 'land', note: '30 rhombi — a Catalan solid.' },
  { id: 'geo', label: 'Geodesic icosahedron (freq 3)', cfg: { notation: 'I', geodesic: 3 }, mode: 'gnomonic', orient: 'fuller', net: 'land',
    note: 'Many small faces: very low distortion, many possible cuts.' },
  { id: 'gores', label: 'Prism gores (12-gon prism, exploded)', cfg: { notation: 'P12', stretch: [1, 1, 1] }, mode: 'equal', orient: 'faceNorth', net: 'land',
    note: 'Cut the cap faces apart to get globe-gore-like strips.' },
];

async function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) return;
  app.cfg = { ...defaultCfg(), ...p.cfg };
  app.mode = p.mode;
  app.netGen = p.net === 'optimize' ? 'land' : p.net;
  if (p.orient !== 'optimize') { app.qR = orientationFor(p.orient); app.R = V.qToMat(app.qR); }
  syncControls();
  rebuild('reset');
  syncOrientationSliders();
  $('presetNote').textContent = p.note || '';
  if (p.orient === 'optimize') await optimize({ fixed: false, spinOnly: false });
}

// ------------------------------------------------------------------ persistence
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(serialize())); } catch { /* storage unavailable */ }
  }, 300);
}
function serialize() {
  return {
    version: 1, cfg: app.cfg, mode: app.mode, qR: app.qR, qV: app.qV, net: N.netToJSON(app.net), netGen: app.netGen,
    display: app.display, dragMode: app.dragMode, tool: app.tool, netViewport: netView ? netView.view : null,
  };
}
function deserialize(s) {
  if (!s || s.version !== 1) return false;
  app.cfg = { ...defaultCfg(), ...s.cfg };
  app.mode = s.mode || 'fuller';
  app.qR = s.qR || [1, 0, 0, 0]; app.R = V.qToMat(app.qR);
  app.qV = s.qV || app.qV; app.Vm = V.qToMat(app.qV);
  app.net = N.netFromJSON(s.net);
  app.netGen = s.netGen || 'land';
  Object.assign(app.display, s.display || {});
  app.dragMode = s.dragMode || 'poly';
  app.tool = s.tool || 'cut';
  if (s.netViewport && netView) netView.view = s.netViewport;
  return true;
}

// ------------------------------------------------------------------ controls
const MODE_NOTES = {
  gnomonic: 'True central projection onto each face. Straight lines in each face are great circles; distortion grows toward face corners.',
  fuller: 'Positions along each edge and outward from each face centre are proportional to arc length (Fuller-like). Seamless across every edge of any solid.',
  equal: 'Slice-and-dice equal-area mapping of each centre-fan triangle. Seamless on symmetric solids; tiny seams where unlike faces meet.',
};

function syncControls() {
  const c = app.cfg;
  $('notation').value = c.custom ? '(custom)' : c.notation;
  $('baseSel').value = BASES.some(([, l]) => l.some(([k]) => k === c.notation)) ? c.notation : '';
  const set = (id, v, fmt = (x) => x) => { $(id).value = v; $(id + 'Out').textContent = fmt(v); };
  set('geo', c.geodesic);
  set('truncV', c.truncV, (x) => (+x).toFixed(2));
  set('chamferE', c.chamferE, (x) => (+x).toFixed(2));
  set('sx', c.stretch[0], (x) => (+x).toFixed(2));
  set('sy', c.stretch[1], (x) => (+x).toFixed(2));
  set('sz', c.stretch[2], (x) => (+x).toFixed(2));
  $('flatSplit').value = c.flatSplit;
  for (const b of $('modeSeg').children) b.classList.toggle('on', b.dataset.v === app.mode);
  $('modeNote').textContent = MODE_NOTES[app.mode];
  for (const b of $('dragSeg').children) b.classList.toggle('on', b.dataset.v === app.dragMode);
  for (const b of $('toolSeg').children) b.classList.toggle('on', b.dataset.v === app.tool);
  document.querySelectorAll('[data-disp]').forEach((el) => (el.checked = !!app.display[el.dataset.disp]));
}

function bindControls() {
  // presets
  const ps = $('presetSel');
  for (const p of PRESETS) ps.add(new Option(p.label, p.id));
  $('presetApply').onclick = () => applyPreset(ps.value);
  ps.onchange = () => ($('presetNote').textContent = PRESETS.find((p) => p.id === ps.value)?.note || '');

  // base solids
  const bs = $('baseSel');
  bs.add(new Option('— choose —', ''));
  for (const [group, list] of BASES) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const [k, nm] of list) og.appendChild(new Option(`${nm}  (${k})`, k));
    bs.appendChild(og);
  }
  bs.onchange = () => { if (!bs.value) return; app.cfg.notation = bs.value; app.cfg.custom = null; app.cfg.faceSplits = []; syncControls(); rebuild('reset'); };
  const applyNotation = () => {
    const v = $('notation').value.trim();
    const prev = { ...app.cfg };
    app.cfg.notation = v; app.cfg.custom = null; app.cfg.faceSplits = [];
    if (!rebuild('reset')) { app.cfg = prev; }
    syncControls();
  };
  $('notationApply').onclick = applyNotation;
  $('notation').onkeydown = (e) => { if (e.key === 'Enter') applyNotation(); };
  const ops = $('opsRow');
  for (const [k, op] of Object.entries(P.OPS)) {
    const b = document.createElement('button');
    b.innerHTML = `<b>${k}</b> ${op.name}`;
    b.title = `Apply ${op.name} (prepend "${k}")`;
    b.onclick = () => {
      if (app.cfg.custom) { toast('Conway operators work on notation solids, not custom ones', true); return; }
      const prev = app.cfg.notation;
      app.cfg.notation = k + app.cfg.notation; app.cfg.faceSplits = [];
      setStatus(`Building ${app.cfg.notation}…`);
      setTimeout(() => { if (!rebuild('reset')) app.cfg.notation = prev; syncControls(); setStatus(''); }, 10);
    };
    ops.appendChild(b);
  }
  ops.style.gridTemplateColumns = 'repeat(3, 1fr)';

  // modifiers (rebuild on change, cheap preview on input for stretch)
  const slider = (id, apply, fmt = (x) => (+x).toFixed(2)) => {
    const el = $(id);
    el.oninput = () => { $(id + 'Out').textContent = fmt(el.value); apply(+el.value); app.cfg.faceSplits = []; rebuild('keep'); };
  };
  slider('geo', (v) => (app.cfg.geodesic = v), (x) => x);
  slider('truncV', (v) => (app.cfg.truncV = v));
  slider('chamferE', (v) => (app.cfg.chamferE = v));
  slider('sx', (v) => (app.cfg.stretch = [v, app.cfg.stretch[1], app.cfg.stretch[2]]));
  slider('sy', (v) => (app.cfg.stretch = [app.cfg.stretch[0], v, app.cfg.stretch[2]]));
  slider('sz', (v) => (app.cfg.stretch = [app.cfg.stretch[0], app.cfg.stretch[1], v]));
  $('flatSplit').onchange = (e) => { app.cfg.flatSplit = e.target.value; app.cfg.faceSplits = []; rebuild('reset'); };
  $('clearSplits').onclick = () => { app.cfg.faceSplits = []; rebuild('reset'); };

  // projection mode
  for (const b of $('modeSeg').children) b.onclick = () => {
    app.mode = b.dataset.v; syncControls();
    relayout();
  };

  // orientation
  const euler = () => setOrientation(eulerToQ(+$('yaw').value, +$('pitch').value, +$('roll').value), { live: true });
  for (const id of ['yaw', 'pitch', 'roll']) {
    $(id).oninput = () => { $(id + 'Out').textContent = Math.round($(id).value); euler(); markInteractive(); };
    $(id).onchange = () => afterOrientationChange();
  }
  $('vNorth').onclick = () => featureToNorth('v');
  $('fNorth').onclick = () => featureToNorth('f');
  $('eNorth').onclick = () => featureToNorth('e');
  $('oReset').onclick = () => setOrientation([1, 0, 0, 0]);
  $('optRun').onclick = () => optimize();
  $('optRevert').onclick = revertOptimize;
  $('optClear').oninput = () => ($('optClearOut').textContent = $('optClear').value);

  // net
  document.querySelectorAll('[data-gen]').forEach((b) => (b.onclick = () => generateNet(b.dataset.gen)));
  $('northUp').onclick = () => northUpAll();
  $('arrange').onclick = () => { N.arrangePieces(app.G, app.net, app.L); relayout({ fit: true }); };
  $('fitNet').onclick = () => { netView.fit(N.layoutBBox(app.G, app.L)); invalidate(['net', 'netRaster']); save(); };
  for (const b of $('toolSeg').children) b.onclick = () => { app.tool = b.dataset.v; syncControls(); save(); };
  for (const b of $('dragSeg').children) b.onclick = () => { app.dragMode = b.dataset.v; syncControls(); save(); };

  // display
  document.querySelectorAll('[data-disp]').forEach((el) => (el.onchange = () => {
    app.display[el.dataset.disp] = el.checked;
    invalidate(ALL);
    save();
  }));
  $('texFile').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => { app.tex = W.textureFromImage(img); URL.revokeObjectURL(img.src); invalidate(['globeRaster', 'netRaster']); toast('Texture loaded'); };
    img.onerror = () => toast('Could not read that image', true);
    img.src = URL.createObjectURL(file);
  };
  $('texReset').onclick = () => { app.tex = app.world.texture; $('texFile').value = ''; invalidate(['globeRaster', 'netRaster']); };

  // file
  $('exportPng').onclick = () => {
    setStatus('Rendering PNG…');
    setTimeout(() => {
      const cv = netView.exportCanvas(N.layoutBBox(app.G, app.L), 4000);
      cv.toBlob((blob) => {
        download(blob, `polymap-${app.cfg.custom ? 'custom' : app.cfg.notation}-${app.mode}.png`);
        setStatus('');
      });
    }, 20);
  };
  $('saveJson').onclick = () => download(new Blob([JSON.stringify(serialize(), null, 1)], { type: 'application/json' }), 'polymap-config.json');
  $('loadJsonBtn').onclick = () => $('loadJson').click();
  $('loadJson').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!deserialize(s)) throw new Error('Not a Polyhedral Map Lab config');
      syncControls(); syncOrientationSliders();
      rebuild('keep');
      netView.fit(N.layoutBBox(app.G, app.L));
      invalidate(ALL);
      toast('Config loaded');
    } catch (err) { toast(err.message, true); }
    e.target.value = '';
  };
  $('resetAll').onclick = () => { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } location.reload(); };
  $('customApply').onclick = () => {
    try {
      const c = JSON.parse($('customPoly').value);
      const prev = app.cfg;
      app.cfg = { ...defaultCfg(), custom: c };
      if (!rebuild('reset')) app.cfg = prev;
      syncControls();
    } catch (err) { toast('Invalid JSON: ' + err.message, true); }
  };

  $('btnHelp').onclick = () => ($('help').hidden = false);
  $('helpClose').onclick = () => ($('help').hidden = true);
  $('help').onclick = (e) => { if (e.target === $('help')) $('help').hidden = true; };
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('help').hidden = true; });
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ pointer interaction
function hoverStatus() {
  const { face, edge } = app.hover;
  if (edge >= 0) {
    const e = app.G.edges[edge];
    const fold = app.net.folds.has(e.key);
    const km = Math.round((app.landW?.[edge] || 0) * EARTH_KM);
    setStatus(`Edge ${edge} · ${fold ? 'fold' : 'cut'} · faces ${e.faces[0]}/${e.faces[1]} · ${km} km over land — click to ${fold ? 'cut' : 'fold'}`);
  } else if (face >= 0) {
    const fd = app.G.faces[face];
    setStatus(`Face ${face} · ${fd.verts.length}-gon · piece ${app.L.comp[face] + 1}/${app.L.comps.length}` +
      (app.tool !== 'cut' ? ' — click to split' : ''));
  } else setStatus('');
}
function setHover(face, edge) {
  if (face === app.hover.face && edge === app.hover.edge) return;
  app.hover = { face, edge };
  hoverStatus();
  invalidate(['globe', 'net']);
}

function handleClick(face, edge) {
  if (app.tool === 'cut') {
    if (edge < 0) return;
    const what = N.toggleEdge(app.G, app.net, app.L, edge);
    app.netGen = 'custom';
    relayout();
    hoverStatus();
    if (what === 'rehinge') toast('Re-hinged: the flap now attaches along this edge');
  } else if (face >= 0) {
    splitAt(face, app.tool);
  }
}

function bindGlobe(cv) {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const v = globeView.screenToView(e.offsetX, e.offsetY, true);
    const inside = !!globeView.screenToView(e.offsetX, e.offsetY);
    let mode = app.dragMode;
    if (e.shiftKey) mode = mode === 'poly' ? 'view' : 'poly';
    drag = { x: e.offsetX, y: e.offsetY, v, moved: false, mode, inside };
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) {
      const h = globeView.pick(e.offsetX, e.offsetY);
      setHover(h.face, h.edge);
      return;
    }
    if (!drag.moved && Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) < 3) return;
    if (!drag.moved) { drag.moved = true; cv.classList.add('dragging'); }
    const v = globeView.screenToView(e.offsetX, e.offsetY, true);
    const dq = V.qFromTwoVecs(V.norm(drag.v), V.norm(v));
    drag.v = v;
    markInteractive();
    if (drag.mode === 'view') {
      app.qV = V.qnormalize(V.qmul(dq, app.qV));
      app.Vm = V.qToMat(app.qV);
      invalidate(['globe', 'globeRaster']);
    } else {
      const qe = V.qmul(V.qmul(V.qconj(app.qV), dq), app.qV);
      setOrientation(V.qmul(qe, app.qR), { live: true });
    }
  });
  const end = (e) => {
    if (!drag) return;
    cv.classList.remove('dragging');
    if (!drag.moved) {
      const h = globeView.pick(e.offsetX, e.offsetY);
      if (h.P) handleClick(h.face, h.edge);
    } else if (drag.mode === 'poly') afterOrientationChange();
    else save();
    drag = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', () => { drag = null; cv.classList.remove('dragging'); });
  cv.addEventListener('pointerleave', () => { if (!drag) setHover(-1, -1); });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    globeView.zoom = Math.max(0.5, Math.min(6, globeView.zoom * Math.exp(-e.deltaY * 0.0015)));
    markInteractive();
    invalidate(['globe', 'globeRaster']);
  }, { passive: false });
}

function bindNet(cv) {
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    const h = netView.pick(e.offsetX, e.offsetY);
    drag = { x: e.offsetX, y: e.offsetY, lx: e.offsetX, ly: e.offsetY, moved: false, h, rotate: e.shiftKey || e.altKey };
    if (h.face >= 0) {
      drag.ci = app.L.comp[h.face];
      drag.pivot = N.pieceCentroid(app.G, app.L, drag.ci);
    }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) {
      const h = netView.pick(e.offsetX, e.offsetY);
      setHover(h.face, h.edge);
      return;
    }
    if (!drag.moved && Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) < 3) return;
    if (!drag.moved) { drag.moved = true; cv.classList.add('dragging'); }
    markInteractive();
    if (drag.ci !== undefined) {
      if (drag.rotate) {
        const p = netView.toScreen(drag.pivot);
        const a0 = Math.atan2(-(drag.ly - p[1]), drag.lx - p[0]);
        const a1 = Math.atan2(-(e.offsetY - p[1]), e.offsetX - p[0]);
        N.rotatePiece(app.G, app.net, app.L, drag.ci, a1 - a0, drag.pivot);
      } else {
        const k = netView.view.k;
        N.movePiece(app.G, app.net, app.L, drag.ci, (e.offsetX - drag.lx) / k, -(e.offsetY - drag.ly) / k);
      }
    } else {
      netView.view.ox += e.offsetX - drag.lx;
      netView.view.oy += e.offsetY - drag.ly;
    }
    drag.lx = e.offsetX; drag.ly = e.offsetY;
    invalidate(['net', 'netRaster']);
  });
  cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    cv.classList.remove('dragging');
    if (!drag.moved) handleClick(drag.h.face, drag.h.edge);
    else if (drag.ci !== undefined) { app.overlaps = N.findOverlaps(app.G, app.L); updateStats(); invalidate(['net']); save(); }
    else save();
    drag = null;
  });
  cv.addEventListener('pointercancel', () => { drag = null; cv.classList.remove('dragging'); });
  cv.addEventListener('pointerleave', () => { if (!drag) setHover(-1, -1); });
  cv.addEventListener('dblclick', (e) => {
    const h = netView.pick(e.offsetX, e.offsetY);
    if (h.face < 0) return;
    northUp(app.L.comp[h.face]);
    relayout();
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    const v = netView.view;
    v.ox = e.offsetX - (e.offsetX - v.ox) * f;
    v.oy = e.offsetY - (e.offsetY - v.oy) * f;
    v.k *= f;
    markInteractive();
    invalidate(['net', 'netRaster']);
    save();
  }, { passive: false });
}

// ------------------------------------------------------------------ boot
/** index.html#load=<json {cfg, mode, qR}> (used by the Pareto study page). */
function loadFromHash() {
  const m = location.hash.match(/^#load=(.*)$/);
  if (!m) return false;
  try {
    const o = JSON.parse(decodeURIComponent(m[1]));
    app.cfg = { ...defaultCfg(), ...o.cfg };
    if (o.mode) app.mode = o.mode;
    if (o.qR) { app.qR = V.qnormalize(o.qR); app.R = V.qToMat(app.qR); }
    app.netGen = 'land';
    history.replaceState(null, '', location.pathname);
    syncControls();
    return true;
  } catch (e) {
    toast('Bad link: ' + e.message, true);
    return false;
  }
}

async function main() {
  globeView = new GlobeView($('globe'), app);
  netView = new NetView($('netc'), app);
  bindControls();
  let restored = false;
  try { restored = deserialize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch { restored = false; }
  syncControls();
  bindGlobe($('globe'));
  bindNet($('netc'));
  new ResizeObserver(() => invalidate(['globe', 'globeRaster', 'net', 'netRaster'])).observe($('globeWrap'));
  new ResizeObserver(() => invalidate(['net', 'netRaster'])).observe($('netWrap'));

  try {
    app.world = await W.loadWorld();
  } catch (e) {
    setStatus('Failed to load world data — serve this folder over http (python3 -m http.server)');
    toast(e.message, true, 8000);
    return;
  }
  app.tex = app.world.texture;
  const linked = loadFromHash();
  if (linked) {
    rebuild('reset');
  } else if (restored && rebuild('keep')) {
    if (!netView.view || !isFinite(netView.view.k)) netView.fit(N.layoutBBox(app.G, app.L));
  } else {
    await applyPreset('dymaxion');
    $('presetSel').value = 'dymaxion';
  }
  syncOrientationSliders();
  setStatus('Ready — drag the globe to slide the polyhedron over the Earth; click edges to cut or fold.');
  invalidate(ALL);
}

main();
window.polymap = app; // handy for poking at state from the console
app.views = () => ({ globeView, netView });
