// Canvas renderers for the globe (orthographic) and the unfolded net.
// Both draw a raster pass (per-pixel inverse mapping into the world texture) and then vector
// overlays (coastlines, graticule, polyhedron edges, highlights) on top.
import * as V from './vec.js';
import { locate, forwardInFace, triInverseInto, sharedEdge, arcEdgeCrossing } from './geometry.js';
import { tApply, facePolygon } from './net.js';

const PI = Math.PI, TWO_PI = 2 * Math.PI, HALF_PI = PI / 2;

export const COLORS = {
  fold: 'rgba(60,70,80,0.45)',
  cut: '#c0392b',
  cutNet: '#2b2f33',
  hover: '#ff7a00',
  hoverFill: 'rgba(255,190,60,0.28)',
  overlap: 'rgba(230,40,40,0.35)',
  coast: 'rgba(55,75,85,0.85)',
  border: 'rgba(120,110,90,0.55)',
  graticule: 'rgba(40,60,80,0.18)',
  tissotFill: 'rgba(214,69,65,0.28)',
  tissotStroke: 'rgba(170,40,40,0.7)',
  label: 'rgba(30,30,30,0.75)',
};

function texLookup(tex, x, y, z) {
  const lon = Math.atan2(y, x);
  const lat = Math.asin(z > 1 ? 1 : z < -1 ? -1 : z);
  let tx = ((lon + PI) / TWO_PI * tex.w) | 0;
  let ty = ((HALF_PI - lat) / PI * tex.h) | 0;
  if (tx >= tex.w) tx = tex.w - 1; else if (tx < 0) tx = 0;
  if (ty >= tex.h) ty = tex.h - 1; else if (ty < 0) ty = 0;
  return tex.data32[ty * tex.w + tx];
}

function mixColor(c, tint, ta, shade) {
  let r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
  if (tint) { r += (tint[0] - r) * ta; g += (tint[1] - g) * ta; b += (tint[2] - b) * ta; }
  if (shade !== 1) { r *= shade; g *= shade; b *= shade; }
  return (0xff000000 | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
}

class RasterBuffer {
  constructor() { this.cv = document.createElement('canvas'); this.ctx = this.cv.getContext('2d'); this.img = null; }
  ensure(w, h) {
    if (!this.img || this.img.width !== w || this.img.height !== h) {
      this.cv.width = w; this.cv.height = h;
      this.img = this.ctx.createImageData(w, h);
      this.u32 = new Uint32Array(this.img.data.buffer);
    } else this.u32.fill(0);
    return this.u32;
  }
  commit() { this.ctx.putImageData(this.img, 0, 0); }
}

function setupCanvas(cv) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  return { dpr, w, h };
}

// =====================================================================================
export class GlobeView {
  constructor(canvas, app) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.app = app;
    this.zoom = 1; this.buf = new RasterBuffer(); this.rasterKey = '';
  }
  geom() {
    const w = this.cv.clientWidth, h = this.cv.clientHeight;
    return { cx: w / 2, cy: h / 2, r: 0.46 * Math.min(w, h) * this.zoom };
  }
  /** css px -> unit vector in view coords (clamped to rim if outside). */
  screenToView(mx, my, clamp = false) {
    const { cx, cy, r } = this.geom();
    const x = (mx - cx) / r, y = (cy - my) / r, d2 = x * x + y * y;
    if (d2 > 1) { if (!clamp) return null; const d = Math.sqrt(d2); return [x / d, y / d, 0]; }
    return [x, y, Math.sqrt(1 - d2)];
  }

  renderRaster(q) {
    const app = this.app, G = app.G, R = app.R, Vm = app.Vm, tex = app.tex;
    const { dpr } = setupCanvas(this.cv);
    const rs = q < 1 ? q : dpr;
    const W = Math.max(1, Math.round(this.cv.clientWidth * rs)), H = Math.max(1, Math.round(this.cv.clientHeight * rs));
    const out = this.buf.ensure(W, H);
    const { cx, cy, r } = this.geom();
    const CX = cx * rs, CY = cy * rs, RR = r * rs;
    const tint = app.display.tint ? app.faceColors : null;
    const ta = 0.16;
    const P = [0, 0, 0];
    let hint = 0;
    const y0 = Math.max(0, Math.floor(CY - RR)), y1 = Math.min(H, Math.ceil(CY + RR));
    const x0 = Math.max(0, Math.floor(CX - RR)), x1 = Math.min(W, Math.ceil(CX + RR));
    for (let py = y0; py < y1; py++) {
      const vy = (CY - (py + 0.5)) / RR;
      for (let px = x0; px < x1; px++) {
        const vx = (px + 0.5 - CX) / RR;
        const d2 = vx * vx + vy * vy;
        if (d2 > 1) continue;
        const vz = Math.sqrt(1 - d2);
        // earth = Vm^T v
        const ex = Vm[0] * vx + Vm[3] * vy + Vm[6] * vz;
        const ey = Vm[1] * vx + Vm[4] * vy + Vm[7] * vz;
        const ez = Vm[2] * vx + Vm[5] * vy + Vm[8] * vz;
        const c = app.display.raster ? texLookup(tex, ex, ey, ez) : 0xffffffff;
        let tc = null;
        if (tint) {
          P[0] = R[0] * ex + R[3] * ey + R[6] * ez;
          P[1] = R[1] * ex + R[4] * ey + R[7] * ez;
          P[2] = R[2] * ex + R[5] * ey + R[8] * ez;
          hint = locate(G, P, hint);
          tc = tint[hint];
        }
        out[py * W + px] = mixColor(c, tc, ta, 0.72 + 0.28 * vz);
      }
    }
    this.buf.commit();
  }

  draw(q = 1, rasterDirty = true) {
    const app = this.app;
    if (!app.G) return;
    const { dpr, w, h } = setupCanvas(this.cv);
    if (rasterDirty || !this.buf.img) this.renderRaster(q);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { cx, cy, r } = this.geom();
    // halo
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)'; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TWO_PI); ctx.fillStyle = '#dde7ec'; ctx.fill();
    ctx.restore();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buf.cv, 0, 0, w, h);

    const Vm = app.Vm, R = app.R;
    const toView = (E) => V.mulMV(Vm, E);
    const polyToView = (p) => V.mulMV(Vm, V.mulMV(R, p));
    const d = app.display;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (d.graticule) this.strokeLines(app.world.graticule, toView, COLORS.graticule, 0.8);
    if (d.borders) this.strokeLines(app.world.borders, toView, COLORS.border, 0.6);
    if (d.coast) this.strokeLines(app.world.coast, toView, COLORS.coast, 0.7);
    if (d.tissot) this.fillRings(app.world.tissot, toView);

    const G = app.G;
    // hover face
    if (app.hover.face >= 0) {
      const f = app.hover.face, fd = G.faces[f];
      const ring = [];
      fd.verts.forEach((_, k) => {
        const e = G.edges[G.faceEdge[f][k]];
        const s = e.samples;
        const fwd = e.a === fd.verts[k];
        for (let i = 0; i < s.length; i++) ring.push(polyToView(s[fwd ? i : s.length - 1 - i]));
      });
      ctx.beginPath();
      ring.forEach((v, i) => {
        let x = v[0], y = v[1];
        if (v[2] < 0) { const l = Math.hypot(x, y) || 1; x /= l; y /= l; }
        const sx = cx + r * x, sy = cy - r * y;
        if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy);
      });
      ctx.closePath(); ctx.fillStyle = COLORS.hoverFill; ctx.fill();
    }
    // edges
    const folds = app.net.folds;
    const foldLines = [], cutLines = [];
    for (const e of G.edges) (folds.has(e.key) ? foldLines : cutLines).push(e.samples);
    this.strokeLines(foldLines, polyToView, COLORS.fold, 1, [4, 3]);
    this.strokeLines(cutLines, polyToView, COLORS.cut, 2.2);
    if (app.hover.edge >= 0) this.strokeLines([G.edges[app.hover.edge].samples], polyToView, COLORS.hover, 4);
    // labels
    if (d.labels) {
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.label;
      G.faces.forEach((fd, i) => {
        const v = polyToView(fd.A);
        if (v[2] > 0.15) ctx.fillText(String(i), cx + r * v[0], cy - r * v[1]);
      });
    }
    // rim
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TWO_PI);
    ctx.strokeStyle = 'rgba(40,60,70,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.stroke();
  }

  strokeLines(lines, toView, color, width, dash = []) {
    const ctx = this.ctx, { cx, cy, r } = this.geom();
    ctx.beginPath();
    for (const line of lines) {
      let prev = null;
      for (const E of line) {
        const v = toView(E);
        const vis = v[2] >= 0;
        if (prev) {
          const pvis = prev[2] >= 0;
          if (vis && pvis) ctx.lineTo(cx + r * v[0], cy - r * v[1]);
          else if (vis !== pvis) {
            const t = prev[2] / (prev[2] - v[2]);
            let hx = prev[0] + (v[0] - prev[0]) * t, hy = prev[1] + (v[1] - prev[1]) * t;
            const l = Math.hypot(hx, hy) || 1; hx /= l; hy /= l;
            if (vis) { ctx.moveTo(cx + r * hx, cy - r * hy); ctx.lineTo(cx + r * v[0], cy - r * v[1]); }
            else ctx.lineTo(cx + r * hx, cy - r * hy);
          }
        } else if (vis) ctx.moveTo(cx + r * v[0], cy - r * v[1]);
        prev = v;
      }
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    ctx.setLineDash([]);
  }

  fillRings(rings, toView) {
    const ctx = this.ctx, { cx, cy, r } = this.geom();
    ctx.beginPath();
    for (const ring of rings) {
      const vs = ring.map(toView);
      if (vs.some((v) => v[2] < 0)) continue;
      vs.forEach((v, i) => (i ? ctx.lineTo(cx + r * v[0], cy - r * v[1]) : ctx.moveTo(cx + r * v[0], cy - r * v[1])));
      ctx.closePath();
    }
    ctx.fillStyle = COLORS.tissotFill; ctx.fill();
    ctx.strokeStyle = COLORS.tissotStroke; ctx.lineWidth = 0.6; ctx.stroke();
  }

  /** Hit test at css px: returns { P (poly frame), face, edge }. */
  pick(mx, my) {
    const app = this.app, G = app.G;
    const v = this.screenToView(mx, my);
    if (!v) return { P: null, face: -1, edge: -1 };
    const E = V.mulMtV(app.Vm, v);
    const P = V.mulMtV(app.R, E);
    const face = locate(G, P, app.hover.face >= 0 ? app.hover.face : 0);
    const { r } = this.geom();
    const tol = 7 / r;
    let edge = -1, best = tol;
    for (const k of G.faceEdge[face]) {
      const d = edgeDist(G, k, P);
      if (d < best) { best = d; edge = k; }
    }
    return { P, face, edge };
  }
}

function edgeDist(G, eid, P) {
  const e = G.edges[eid];
  const A = G.vdir[e.a], B = G.vdir[e.b], n = e.normal;
  const inA = V.dot(V.cross(n, A), P) >= 0, inB = V.dot(V.cross(B, n), P) >= 0;
  if (inA && inB) return Math.abs(Math.asin(Math.max(-1, Math.min(1, V.dot(P, n)))));
  return Math.min(V.angle(P, A), V.angle(P, B));
}

// =====================================================================================
/**
 * Forward-project sphere polylines (earth frame) into the net. Points are stored in face-local
 * coordinates with their face index (so moving pieces doesn't require reprojection); f = -1
 * marks a pen-up. Lines break where they cross a cut edge.
 */
export function projectLinesToNet(app, lines) {
  const G = app.G, R = app.R, mode = app.mode, folds = app.net.folds;
  const xs = [], ys = [], fs = [];
  const brk = () => { xs.push(0); ys.push(0); fs.push(-1); };
  const pt = (f, p) => { xs.push(p[0]); ys.push(p[1]); fs.push(f); };
  let hint = 0;
  for (const line of lines) {
    let pf = -1, pP = null;
    for (const E of line) {
      const P = V.mulMtV(R, E);
      const f = locate(G, P, hint); hint = f;
      const loc = forwardInFace(G, f, P, mode);
      if (pf < 0) { brk(); pt(f, loc); }
      else if (f === pf) pt(f, loc);
      else {
        const eid = sharedEdge(G, pf, f);
        if (eid >= 0) {
          const X = arcEdgeCrossing(G, eid, pP, P);
          pt(pf, forwardInFace(G, pf, X, mode));
          if (!folds.has(G.edges[eid].key)) brk();
          pt(f, forwardInFace(G, f, X, mode));
          pt(f, loc);
        } else { brk(); pt(f, loc); }
      }
      pf = f; pP = P;
    }
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), f: Int32Array.from(fs) };
}

export class NetView {
  constructor(canvas, app) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.app = app;
    this.view = { k: 100, ox: 0, oy: 0 };
    this.buf = new RasterBuffer();
    this.lineCache = null;
  }
  toScreen(p) { return [this.view.ox + this.view.k * p[0], this.view.oy - this.view.k * p[1]]; }
  toWorld(sx, sy) { return [(sx - this.view.ox) / this.view.k, (this.view.oy - sy) / this.view.k]; }

  fit(bbox, w = this.cv.clientWidth, h = this.cv.clientHeight, margin = 24) {
    // leave room for the toolbar on top and the hint line at the bottom
    const top = 52, bottom = 30;
    const bw = bbox[2] - bbox[0], bh = bbox[3] - bbox[1];
    const k = Math.min((w - 2 * margin) / bw, (h - top - bottom - margin) / bh);
    this.view = { k, ox: w / 2 - k * (bbox[0] + bbox[2]) / 2, oy: top + (h - top - bottom) / 2 + k * (bbox[1] + bbox[3]) / 2 };
  }

  invalidateLines() { this.lineCache = null; }
  lines() {
    const app = this.app;
    const lo = !!app.interactive;
    if (!this.lineCache || (this.lineCache.lo && !lo)) {
      const w = lo ? app.world.lo : app.world, d = app.display;
      this.lineCache = {
        lo,
        coast: d.coast ? projectLinesToNet(app, w.coast) : null,
        borders: d.borders ? projectLinesToNet(app, w.borders) : null,
        graticule: d.graticule ? projectLinesToNet(app, w.graticule) : null,
        tissot: d.tissot ? projectLinesToNet(app, w.tissot) : null,
      };
    }
    return this.lineCache;
  }

  renderRaster(q, target = null) {
    const app = this.app, G = app.G, L = app.L, R = app.R, tex = app.tex, mode = app.mode;
    let W, H, rs, view, buf;
    if (target) { ({ W, H, view } = target); rs = 1; buf = target.buf; }
    else {
      const { dpr } = setupCanvas(this.cv);
      rs = q < 1 ? q : dpr; view = this.view; buf = this.buf;
      W = Math.max(1, Math.round(this.cv.clientWidth * rs)); H = Math.max(1, Math.round(this.cv.clientHeight * rs));
    }
    const out = buf.ensure(W, H);
    const tintOn = app.display.tint;
    const ta = 0.16;
    const P = [0, 0, 0];
    const k = view.k * rs, ox = view.ox * rs, oy = view.oy * rs;
    for (let f = 0; f < G.F; f++) {
      const fd = G.faces[f], M = L.M[f];
      const tint = tintOn ? app.faceColors[f] : null;
      for (const T of fd.tris) {
        const a = tApply(M, T.a2), b = tApply(M, T.b2), c = tApply(M, T.c2);
        const ax = ox + k * a[0], ay = oy - k * a[1];
        const bx = ox + k * b[0], by = oy - k * b[1];
        const cx = ox + k * c[0], cy = oy - k * c[1];
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        if (Math.abs(det) < 1e-9) continue;
        const xmin = Math.max(0, Math.floor(Math.min(ax, bx, cx))), xmax = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
        const ymin = Math.max(0, Math.floor(Math.min(ay, by, cy))), ymax = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
        if (xmin > xmax || ymin > ymax) continue;
        const e = -1e-3 * Math.max(1, 200 / Math.sqrt(Math.abs(det)));
        const d1x = (by - cy) / det, d2x = (cy - ay) / det;
        for (let py = ymin; py <= ymax; py++) {
          const yy = py + 0.5;
          let l1 = ((by - cy) * (xmin + 0.5 - cx) + (cx - bx) * (yy - cy)) / det;
          let l2 = ((cy - ay) * (xmin + 0.5 - cx) + (ax - cx) * (yy - cy)) / det;
          for (let px = xmin; px <= xmax; px++, l1 += d1x, l2 += d2x) {
            const l3 = 1 - l1 - l2;
            if (l1 < e || l2 < e || l3 < e) continue;
            const w1 = l1 < 0 ? 0 : l1, w2 = l2 < 0 ? 0 : l2, w3 = l3 < 0 ? 0 : l3;
            const sw = w1 + w2 + w3;
            triInverseInto(fd, T, w1 / sw, w2 / sw, w3 / sw, mode, P);
            const ex = R[0] * P[0] + R[1] * P[1] + R[2] * P[2];
            const ey = R[3] * P[0] + R[4] * P[1] + R[5] * P[2];
            const ez = R[6] * P[0] + R[7] * P[1] + R[8] * P[2];
            const col = app.display.raster ? texLookup(tex, ex, ey, ez) : 0xffffffff;
            out[py * W + px] = mixColor(col, tint, ta, 1);
          }
        }
      }
    }
    buf.commit();
  }

  draw(q = 1, rasterDirty = true) {
    const app = this.app;
    if (!app.G || !app.L) return;
    const { dpr, w, h } = setupCanvas(this.cv);
    if (rasterDirty || !this.buf.img) this.renderRaster(q);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cv.width, this.cv.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.buf.cv, 0, 0, w, h);
    this.drawOverlays(ctx, this.view, 1);
  }

  drawOverlays(ctx, view, lw) {
    const app = this.app, G = app.G, L = app.L, d = app.display;
    const S = (p) => [view.ox + view.k * p[0], view.oy - view.k * p[1]];
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const lines = this.lines();
    const M = L.M;
    const strokePath = (arr, color, width, fill = null) => {
      if (!arr) return;
      ctx.beginPath();
      let move = true;
      const { x, y, f } = arr;
      for (let i = 0; i < f.length; i++) {
        const fi = f[i];
        if (fi < 0) { move = true; continue; }
        const m = M[fi];
        const wx = m[0] * x[i] - m[1] * y[i] + m[2], wy = m[1] * x[i] + m[0] * y[i] + m[3];
        const sx = view.ox + view.k * wx, sy = view.oy - view.k * wy;
        if (move) { ctx.moveTo(sx, sy); move = false; } else ctx.lineTo(sx, sy);
      }
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = color; ctx.lineWidth = width * lw; ctx.stroke();
    };
    strokePath(lines.graticule, COLORS.graticule, 0.8);
    strokePath(lines.borders, COLORS.border, 0.6);
    strokePath(lines.coast, COLORS.coast, 0.75);
    strokePath(lines.tissot, COLORS.tissotStroke, 0.6, COLORS.tissotFill);

    // overlaps
    if (app.overlaps && app.overlaps.size) {
      ctx.beginPath();
      for (const f of app.overlaps) {
        facePolygon(G, L, f).forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        ctx.closePath();
      }
      ctx.fillStyle = COLORS.overlap; ctx.fill();
    }
    // hover face
    if (app.hover.face >= 0) {
      ctx.beginPath();
      facePolygon(G, L, app.hover.face).forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
      ctx.closePath(); ctx.fillStyle = COLORS.hoverFill; ctx.fill();
    }
    // edges
    const folds = app.net.folds;
    const foldPath = new Path2D(), cutPath = new Path2D(), hoverPath = new Path2D();
    for (let f = 0; f < G.F; f++) {
      const poly = facePolygon(G, L, f).map(S);
      const n = poly.length;
      for (let k = 0; k < n; k++) {
        const eid = G.faceEdge[f][k];
        const e = G.edges[eid];
        const a = poly[k], b = poly[(k + 1) % n];
        const isFold = folds.has(e.key);
        if (isFold && G.faceNbr[f][k] < f) continue;
        const p = isFold ? foldPath : cutPath;
        p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]);
        if (eid === app.hover.edge) { hoverPath.moveTo(a[0], a[1]); hoverPath.lineTo(b[0], b[1]); }
      }
    }
    ctx.setLineDash([4 * lw, 3 * lw]); ctx.strokeStyle = COLORS.fold; ctx.lineWidth = 0.9 * lw; ctx.stroke(foldPath);
    ctx.setLineDash([]); ctx.strokeStyle = COLORS.cutNet; ctx.lineWidth = 1.4 * lw; ctx.stroke(cutPath);
    ctx.strokeStyle = COLORS.hover; ctx.lineWidth = 4 * lw; ctx.stroke(hoverPath);
    if (d.labels) {
      ctx.font = `600 ${11 * lw}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = COLORS.label;
      for (let f = 0; f < G.F; f++) {
        const fd = G.faces[f];
        const s = S(tApply(L.M[f], fd.cl));
        ctx.fillText(String(f), s[0], s[1]);
      }
    }
  }

  /** Hit test at css px. */
  pick(mx, my) {
    const app = this.app, G = app.G, L = app.L;
    const wpt = this.toWorld(mx, my);
    const tol = 7 / this.view.k;
    let face = -1;
    for (let f = G.F - 1; f >= 0; f--) {
      const poly = facePolygon(G, L, f);
      let inside = true;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        if ((b[0] - a[0]) * (wpt[1] - a[1]) - (b[1] - a[1]) * (wpt[0] - a[0]) < 0) { inside = false; break; }
      }
      if (inside) { face = f; break; }
    }
    let edge = -1, best = tol;
    for (let f = 0; f < G.F; f++) {
      const poly = facePolygon(G, L, f);
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((wpt[0] - a[0]) * dx + (wpt[1] - a[1]) * dy) / (dx * dx + dy * dy)));
        const dd = Math.hypot(wpt[0] - a[0] - t * dx, wpt[1] - a[1] - t * dy);
        if (dd < best) { best = dd; edge = G.faceEdge[f][k]; }
      }
    }
    return { face, edge, world: wpt };
  }

  /** Render the net to a standalone canvas at a given pixel width (for PNG export). */
  exportCanvas(bbox, pxWidth = 4000, background = '#ffffff') {
    const margin = 0.03 * (bbox[2] - bbox[0]);
    const bw = bbox[2] - bbox[0] + 2 * margin, bh = bbox[3] - bbox[1] + 2 * margin;
    const k = pxWidth / bw;
    const W = Math.round(pxWidth), H = Math.round(bh * k);
    const view = { k, ox: (margin - bbox[0]) * k, oy: (bbox[3] + margin) * k };
    const buf = new RasterBuffer();
    this.renderRaster(1, { W, H, view, buf });
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(buf.cv, 0, 0);
    const lw = Math.max(1, W / 1400);
    const saveHover = this.app.hover;
    this.app.hover = { face: -1, edge: -1 };
    this.drawOverlays(ctx, view, lw);
    this.app.hover = saveHover;
    return cv;
  }
}
