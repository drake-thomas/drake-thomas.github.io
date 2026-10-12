// Manual outline editor on a Google map (explorer feedback panel, review app "fix").
//
//   const ed = openPolyEdit(map, { geometry, title, onDone(geojson | null, meta), onClose() });
//
// Edits a copy of a GeoJSON Polygon / MultiPolygon (or LineString / MultiLineString; null = a point feature, so the
// owner draws an outline from scratch). Large outlines are simplified for editing (<= ~400 vertices per ring, tolerance
// scaled to the current view, reported in meta.tol_m). onDone gets the edited geometry (rounded to 5 decimals, outer
// rings CCW) or null when nothing changed; meta = { vertices, orig_vertices, tol_m, parts }.
//
// Controls (shown in the editor's own HUD):
//   drag a vertex · click a midpoint handle to add a vertex there · right-click / Alt-click / Backspace (hovered) deletes
//   R  replace a stretch: draw a path (click points, or freehand drag) from near one boundary point to near another; the
//      shorter boundary between the two snap points is replaced. F flips to the other side.
//   N  redraw from scratch (clicks or freehand; double-click / Enter / clicking the first point closes)
//   A  add a part · D delete the hovered part · Ctrl/Cmd-Z undo, Shift-Ctrl/Cmd-Z (or Ctrl-Y) redo
//   Enter / E done · Esc cancels a drawing, else leaves (twice if there are edits) · Space held: pan while drawing
//   - / = zoom out / in
const CAP_RING = 400, CAP_LINE = 1200, CAP_TOTAL = 4500, SNAP_PX = 26, HIT_V = 9, HIT_M = 8;
const R2D = 180 / Math.PI;
const wx = lng => (lng + 180) / 360 * 256;
const wy = lat => { const s = Math.sin(Math.max(-85.06, Math.min(85.06, lat)) / R2D); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256; };
const r5 = v => Math.round(v * 1e5) / 1e5;
const clone = parts => parts.map(p => p.map(r => r.map(c => [c[0], c[1]])));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Douglas-Peucker on [x, y] points; returns kept indices
function dpIdx(P, tol, closed) {
  const n = P.length; if (n <= 3) return P.map((_, i) => i);
  const keep = new Uint8Array(n); const t2 = tol * tol;
  let a0 = 0, b0 = n - 1;
  if (closed) {  // anchor the ring at its first vertex and the vertex farthest from it
    let best = -1; for (let i = 1; i < n; i++) { const d = (P[i][0] - P[0][0]) ** 2 + (P[i][1] - P[0][1]) ** 2; if (d > best) { best = d; b0 = i; } }
  }
  keep[a0] = keep[b0] = 1;
  const segs = closed ? [[a0, b0], [b0, n]] : [[a0, b0]];
  const at = i => P[i % n];
  while (segs.length) {
    const [a, b] = segs.pop(); if (b - a < 2) continue;
    const A = at(a), B = at(b), dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const p = at(i); let t = L ? ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
      const d = (p[0] - A[0] - t * dx) ** 2 + (p[1] - A[1] - t * dy) ** 2;
      if (d > best) { best = d; bi = i; }
    }
    if (best > t2) { keep[bi % n] = 1; segs.push([a, bi], [bi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

function segX(a, b, c, d) {  // proper intersection of segments ab and cd
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function ringCrosses(r) {
  const n = r.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segX(r[i], r[(i + 1) % n], r[j], r[(j + 1) % n])) return true;
  }
  return false;
}
const signedArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };

// GeoJSON -> { kind, parts } with rings open (no closing duplicate); lines are one-"ring" parts
function parse(g) {
  if (!g) return { kind: 'poly', parts: [] };
  const open = r => { const c = r.map(p => [+p[0], +p[1]]); if (c.length > 1 && c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1]) c.pop(); return c; };
  if (g.type === 'Polygon') return { kind: 'poly', parts: [g.coordinates.map(open)] };
  if (g.type === 'MultiPolygon') return { kind: 'poly', parts: g.coordinates.map(p => p.map(open)) };
  if (g.type === 'LineString') return { kind: 'line', parts: [[g.coordinates.map(p => [+p[0], +p[1]])]] };
  if (g.type === 'MultiLineString') return { kind: 'line', parts: g.coordinates.map(l => [l.map(p => [+p[0], +p[1]])]) };
  if (g.type === 'GeometryCollection') {  // keep the areal members
    const ps = g.geometries.filter(x => /Polygon/.test(x.type)).flatMap(x => parse(x).parts);
    return { kind: 'poly', parts: ps };
  }
  return { kind: 'poly', parts: [] };
}

export function toGeoJSON(kind, parts) {
  const clean = (r, closed) => {
    const out = [];
    for (const c of r) { const p = [r5(c[0]), r5(c[1])]; const l = out[out.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
    if (closed && out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
    return out;
  };
  if (kind === 'line') {
    const ls = parts.map(p => clean(p[0], false)).filter(l => l.length >= 2);
    if (!ls.length) return null;
    return ls.length === 1 ? { type: 'LineString', coordinates: ls[0] } : { type: 'MultiLineString', coordinates: ls };
  }
  const polys = [];
  for (const p of parts) {
    const rings = [];
    p.forEach((r, k) => {
      let c = clean(r, true); if (c.length < 3) return;
      const ccw = signedArea(c) > 0; if ((k === 0) !== ccw) c = c.reverse();  // RFC 7946: outer CCW, holes CW
      rings.push([...c, c[0]]);
    });
    if (rings.length && p[0] && clean(p[0], true).length >= 3) polys.push(rings);
  }
  if (!polys.length) return null;
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

// draw a finished geometry with plain Maps shapes (the "edited outline attached" preview); returns the shapes
export function drawGeometry(map, g, style = {}) {
  const st = { strokeColor: '#c58cff', strokeOpacity: 1, strokeWeight: 2.5, clickable: false, zIndex: 40, ...style };
  const ring = r => r.map(c => ({ lat: c[1], lng: c[0] }));
  const out = [];
  if (!g) return out;
  if (g.type === 'Polygon') out.push(new google.maps.Polygon({ map, paths: g.coordinates.map(ring), fillColor: st.strokeColor, fillOpacity: .1, ...st }));
  else if (g.type === 'MultiPolygon') for (const p of g.coordinates) out.push(new google.maps.Polygon({ map, paths: p.map(ring), fillColor: st.strokeColor, fillOpacity: .1, ...st }));
  else if (g.type === 'LineString') out.push(new google.maps.Polyline({ map, path: ring(g.coordinates), ...st }));
  else if (g.type === 'MultiLineString') for (const l of g.coordinates) out.push(new google.maps.Polyline({ map, path: ring(l), ...st }));
  return out;
}

let current = null;
export const activeEditor = () => current;
globalThis.__polyedit = activeEditor;  // headless tests / debugging

export function openPolyEdit(map, opts) {
  if (current) current.close(false);
  return (current = new PolyEdit(map, opts));
}

class PolyEdit {
  constructor(map, { geometry = null, title = '', onDone = () => {}, onClose = () => {}, doneLabel = 'Done' } = {}) {
    Object.assign(this, { map, title, onDone, onClose, doneLabel });
    const div = map.getDiv();
    this.div = div;
    this.ov = new google.maps.OverlayView(); this.ov.onAdd = () => {}; this.ov.draw = () => {}; this.ov.onRemove = () => {}; this.ov.setMap(map);
    const { kind, parts } = parse(geometry);
    this.kind = kind;
    this.origVertices = parts.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0);
    this.parts = this.simplify(parts);
    this.ref = clone(this.parts);    // faint reference of the starting outline
    this.start = JSON.stringify(this.parts);
    this.hist = []; this.fwd = []; this.lastReplace = null;
    this.hover = null; this.hoverPart = -1; this.drag = null; this.draw = null; this.space = false; this.escArm = 0;
    this.msg = ''; this.msgAt = 0;
    this.savedOpts = { disableDoubleClickZoom: map.get('disableDoubleClickZoom') ?? false, gestureHandling: map.get('gestureHandling') || 'auto', draggableCursor: map.get('draggableCursor') ?? null };
    map.setOptions({ disableDoubleClickZoom: true });

    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'polyedit-layer');
    Object.assign(this.svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', zIndex: 20, pointerEvents: 'none', overflow: 'visible' });
    div.appendChild(this.svg);
    this.hud = document.createElement('div');
    this.hud.className = 'panel polyedit-hud';
    Object.assign(this.hud.style, { position: 'fixed', zIndex: 30, fontSize: '13px', padding: '8px 12px', maxWidth: '600px' });
    document.body.appendChild(this.hud);
    this.hud.addEventListener('click', e => { const b = e.target.closest('button[data-a]'); if (b) { b.blur(); this.action(b.dataset.a); } });

    this.L = [];
    const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); this.L.push(() => t.removeEventListener(ev, fn, o)); };
    on(div, 'pointerdown', e => this.onDown(e), true);
    on(div, 'mousedown', e => { if (this.swallow) { e.stopPropagation(); e.preventDefault(); } }, true);
    on(div, 'touchstart', e => { if (this.swallow) e.stopPropagation(); }, { capture: true, passive: true });
    on(div, 'click', e => { if (this.swallow) { e.stopPropagation(); this.swallow = false; } }, true);
    on(div, 'dblclick', e => { if (this.draw) { e.stopPropagation(); e.preventDefault(); } }, true);
    on(div, 'contextmenu', e => { if (this.hover?.t === 'v' && !this.draw) { e.preventDefault(); e.stopPropagation(); this.delVertex(this.hover); } }, true);
    on(window, 'pointermove', e => this.onMove(e), true);
    on(window, 'pointerup', e => this.onUp(e), true);
    on(window, 'keydown', e => this.onKey(e), true);
    on(window, 'keyup', e => { if (e.key === ' ') { this.space = false; this.cursor(); } }, true);
    on(window, 'resize', () => this.placeHud());
    this.last = '';
    const loop = () => { if (!this.svg) return; this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
    if (!this.parts.length) this.startDraw('redraw');
    this.updateHud();
  }

  // ---------- geometry helpers ----------
  get closed() { return this.kind === 'poly'; }
  count() { return this.parts.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0); }
  simplify(parts) {
    const z = this.map.getZoom() || 5, S = 2 ** z, closed = this.kind === 'poly', cap = closed ? CAP_RING : CAP_LINE;
    let lat0 = 0, n0 = 0; for (const p of parts) for (const c of p[0] || []) { lat0 += c[1]; n0++; }
    lat0 = n0 ? lat0 / n0 : 0;
    let maxTol = 0;
    const one = (P, r, tol0) => {
      let tol = tol0, idx = dpIdx(P, tol, closed);
      while (idx.length > cap) { tol *= 1.4; idx = dpIdx(P, tol, closed); }
      if (idx.length < r.length) maxTol = Math.max(maxTol, tol);
      return idx.map(i => r[i]);
    };
    // pass 0: Douglas-Peucker at 0.5 px of the current view. If the total is still over CAP_TOTAL (lakes with
    // thousands of islands), raise the tolerance and drop holes / parts smaller than it (counted in this.dropped).
    const PX = parts.map(p => p.map(r => r.map(c => [wx(c[0]) * S, wy(c[1]) * S])));
    let tol0 = 0.5, out, dropped = 0;
    for (let k = 0; k < 24; k++) {
      maxTol = 0; dropped = 0; out = [];
      parts.forEach((p, pi) => {
        const rings = [];
        for (let ri = 0; ri < p.length; ri++) {
          const r = p[ri], P = PX[pi][ri];
          const sr = r.length > 4 ? one(P, r, tol0) : r.map(c => [c[0], c[1]]);
          const tiny = closed && k > 0 && (sr.length < 3 || Math.abs(signedArea(P)) < 4 * tol0 * tol0);
          if (tiny || sr.length < (closed ? 3 : 2)) {
            if (ri === 0) { dropped += p.length; return; }  // a dropped outer ring takes its holes with it
            dropped++; maxTol = Math.max(maxTol, tol0); continue;
          }
          rings.push(sr);
        }
        if (rings.length) out.push(rings);
      });
      if (out.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0) <= CAP_TOTAL) break;
      tol0 *= 1.5;
    }
    this.dropped = dropped;
    this.tolM = maxTol ? maxTol * 156543.03392 * Math.cos(lat0 / R2D) / S : 0;
    return out;
  }
  // container px <-> lng/lat (lng unwrapped to the copy of the world nearest the view centre)
  proj() {
    const pr = this.ov.getProjection(); if (!pr) return null;
    const c = this.map.getCenter(); if (!c) return null;
    const lng0 = Math.round(c.lng()), lat0 = Math.max(-80, Math.min(80, Math.round(c.lat())));
    const a = pr.fromLatLngToContainerPixel(new google.maps.LatLng(lat0, lng0, true));
    const b = pr.fromLatLngToContainerPixel(new google.maps.LatLng(lat0, lng0 + 1, true));
    const s = (b.x - a.x) / (256 / 360);
    return { pr, lng0, x0: a.x, y0: a.y, wx0: wx(lng0), wy0: wy(lat0), s, key: `${a.x.toFixed(2)},${a.y.toFixed(2)},${s.toFixed(5)}` };
  }
  px(P, c) { const lng = c[0] + 360 * Math.round((P.lng0 - c[0]) / 360); return [P.x0 + (wx(lng) - P.wx0) * P.s, P.y0 + (wy(c[1]) - P.wy0) * P.s]; }
  ll(x, y, near) {
    const g = this.P.pr.fromContainerPixelToLatLng(new google.maps.Point(x, y), true);
    let lng = g.lng(); const ref = near ? near[0] : this.P.lng0;
    lng += 360 * Math.round((ref - lng) / 360);
    if (!near) lng = ((lng + 180) % 360 + 360) % 360 - 180;
    return [lng, g.lat()];
  }
  evPx(e) { const r = this.div.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  // ---------- render ----------
  frame() {
    const P = this.proj(); if (!P) return;
    const key = P.key + '|' + this.ver;
    if (key === this.last) return;
    this.last = key; this.P = P; this.render();
  }
  dirty() { this.ver = (this.ver || 0) + 1; }
  render() {
    const P = this.P; if (!P) return;
    const W = this.div.clientWidth, H = this.div.clientHeight, M = 40;
    const inView = p => p[0] > -M && p[0] < W + M && p[1] > -M && p[1] < H + M;
    this.scr = this.parts.map(p => p.map(r => r.map(c => this.px(P, c))));
    const d = (pts, closed) => pts.length ? 'M' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('L') + (closed ? 'Z' : '') : '';
    const fade = !!(this.draw && this.draw.mode === 'redraw');
    let h = '';
    // reference: the outline as it was when editing started
    const refPath = this.ref.map(p => p.map(r => d(r.map(c => this.px(P, c)), this.closed)).join('')).join('');
    if (refPath) h += `<path d="${refPath}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.2" stroke-dasharray="4 4"/>`;
    this.scr.forEach((p, k) => {
      const path = p.map(r => d(r, this.closed)).join('');
      const hot = k === this.hoverPart && !this.draw;
      h += `<path d="${path}" fill="${this.closed ? (hot ? 'rgba(255,226,122,.16)' : 'rgba(255,226,122,.06)') : 'none'}" fill-rule="evenodd" stroke="#000" stroke-opacity="${fade ? .2 : .6}" stroke-width="4.5"/>`;
      h += `<path d="${path}" fill="none" stroke="${hot ? '#fff3b0' : '#ffe27a'}" stroke-opacity="${fade ? .35 : 1}" stroke-width="${hot ? 2.6 : 2}"/>`;
    });
    // handles (skipped while drawing a replacement outline from scratch)
    this.vis = [];
    if (!fade) {
      let nv = 0; const mids = [], verts = [];
      this.scr.forEach((p, pi) => p.forEach((r, ri) => {
        const n = r.length, m = this.closed ? n : n - 1;
        for (let i = 0; i < n; i++) if (inView(r[i])) { verts.push([pi, ri, i]); nv++; }
        for (let i = 0; i < m; i++) {
          const a = r[i], b = r[(i + 1) % n];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= 16) { const q = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; if (inView(q)) mids.push([pi, ri, i, q]); }
        }
      }));
      this.tooDense = nv > 3000;
      if (!this.tooDense && !this.draw) {
        for (const [pi, ri, i, q] of mids) h += `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="3.2" fill="#ffe27a" fill-opacity=".55" stroke="#000" stroke-width="1"/>`;
        this.vis.mids = mids;
      } else this.vis.mids = [];
      if (!this.tooDense) for (const [pi, ri, i] of verts) { const q = this.scr[pi][ri][i]; h += `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="${this.draw ? 2.5 : 4}" fill="#fff" stroke="#000" stroke-width="1.3"/>`; }
      this.vis.verts = this.tooDense ? [] : verts;
    }
    const hv = this.hover;
    if (hv && !this.draw) {
      const q = hv.t === 'v' ? this.scr[hv.p]?.[hv.r]?.[hv.i] : hv.q;
      if (q) h += `<circle cx="${q[0]}" cy="${q[1]}" r="${hv.t === 'v' ? 7 : 6}" fill="${hv.t === 'v' ? '#ff9f43' : '#ffe27a'}" stroke="#000" stroke-width="1.5"/>`;
    }
    // the path being drawn, with snap markers for a replacement
    if (this.draw) {
      const pts = this.draw.pts.map(c => this.px(P, c));
      if (this.draw.cursor && !this.draw.free && pts.length) pts.push(this.draw.cursor);
      const closedPreview = this.draw.mode !== 'replace' && this.closed && pts.length > 2;
      if (pts.length) {
        h += `<path d="${d(pts, closedPreview)}" fill="${closedPreview ? 'rgba(79,227,255,.12)' : 'none'}" stroke="#000" stroke-opacity=".6" stroke-width="4.5"/>`;
        h += `<path d="${d(pts, closedPreview)}" fill="none" stroke="#4fe3ff" stroke-width="2.2"/>`;
        for (const q of this.draw.pts.map(c => this.px(P, c)).slice(0, this.draw.free ? 1 : 1e9)) h += `<circle cx="${q[0]}" cy="${q[1]}" r="3.5" fill="#4fe3ff" stroke="#000"/>`;
      }
      if (this.draw.mode === 'replace') {
        const at = this.draw.pts.length ? this.px(P, this.draw.pts[0]) : this.draw.cursor;
        const s = at && this.snap(at[0], at[1]);
        if (s && s.d <= SNAP_PX) h += `<circle cx="${s.q[0]}" cy="${s.q[1]}" r="7" fill="none" stroke="#4fe3ff" stroke-width="2.5"/>`;
        const cur = this.draw.cursor;
        if (this.draw.pts.length && cur) { const e = this.snap(cur[0], cur[1], s && s.d <= SNAP_PX ? s : null); if (e && e.d <= SNAP_PX) h += `<circle cx="${e.q[0]}" cy="${e.q[1]}" r="7" fill="none" stroke="#5ad17a" stroke-width="2.5"/>`; }
      }
    }
    this.svg.innerHTML = h;
  }

  // nearest boundary point to (x, y): {p, r, u (edge param), q (px), d}; restricted to the ring of `same` if given
  snap(x, y, same) {
    let best = null;
    (this.scr || []).forEach((p, pi) => p.forEach((r, ri) => {
      if (same && (same.p !== pi || same.r !== ri)) return;
      const n = r.length, m = this.closed ? n : n - 1;
      for (let i = 0; i < m; i++) {
        const a = r[i], b = r[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        let t = L ? ((x - a[0]) * dx + (y - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
        const q = [a[0] + t * dx, a[1] + t * dy], dd = Math.hypot(x - q[0], y - q[1]);
        if (!best || dd < best.d) best = { p: pi, r: ri, u: i + t, q, d: dd };
      }
      if (n === 1) { const dd = Math.hypot(x - r[0][0], y - r[0][1]); if (!best || dd < best.d) best = { p: pi, r: ri, u: 0, q: r[0], d: dd }; }
    }));
    return best;
  }
  coordAt(p, r, u) {
    const R = this.parts[p][r], n = R.length, i = Math.floor(u), t = u - i;
    const a = R[i % n], b = R[(i + 1) % n];
    if (t < 1e-9 || !b) return [a[0], a[1]];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }

  // ---------- history ----------
  push() { this.hist.push(clone(this.parts)); if (this.hist.length > 200) this.hist.shift(); this.fwd = []; this.lastReplace = null; this.escArm = 0; }
  changed() { this.dirty(); this.updateHud(); }
  undo() {
    if (this.draw) { if (this.draw.pts.length && !this.draw.free) { this.draw.pts.pop(); this.changed(); return; } }
    const s = this.hist.pop(); if (!s) return this.say('Nothing to undo');
    this.fwd.push(clone(this.parts)); this.parts = s; this.lastReplace = null; this.changed();
  }
  redo() {
    const s = this.fwd.pop(); if (!s) return this.say('Nothing to redo');
    this.hist.push(clone(this.parts)); this.parts = s; this.lastReplace = null; this.changed();
  }
  say(m) { this.msg = m; this.msgAt = Date.now(); this.updateHud(); clearTimeout(this._mt); this._mt = setTimeout(() => this.updateHud(), 4100); }

  // ---------- vertex edits ----------
  delVertex(h) {
    const R = this.parts[h.p]?.[h.r]; if (!R) return;
    if (R.length <= (this.closed ? 3 : 2)) return this.say(this.parts.length > 1 || h.r > 0 ? 'Too few vertices left; D deletes the whole part' : 'Too few vertices left; N redraws from scratch');
    this.push(); R.splice(h.i, 1); this.hover = null; this.changed();
  }
  delPart() {
    const k = this.hoverPart;
    if (k < 0 || !this.parts[k]) return this.say('Hover over a part first, then press D');
    this.push(); this.parts.splice(k, 1); this.hoverPart = -1; this.hover = null; this.changed();
    this.say(this.parts.length ? 'Part deleted (Ctrl/⌘-Z to undo)' : 'All parts deleted: N or A draws a new outline');
  }

  // ---------- pointer ----------
  cursor() { this.map.setOptions({ draggableCursor: this.draw && !this.space ? 'crosshair' : this.hover ? 'pointer' : null, draggingCursor: this.drag ? 'grabbing' : null }); }
  onDown(e) {
    this.swallow = false;
    if (e.button !== 0 || this.space) return;
    if (e.target.closest?.('.gmnoprint, .gm-control-active, button')) return;  // map controls keep working
    const [x, y] = this.evPx(e);
    if (this.draw) {
      e.stopPropagation(); e.preventDefault(); this.swallow = true;
      this.draw.down = [x, y]; this.draw.cursor = [x, y];
      return;
    }
    this.updateHover(x, y);
    const h = this.hover; if (!h) return;
    e.stopPropagation(); e.preventDefault(); this.swallow = true;
    if (h.t === 'v' && (e.altKey)) return this.delVertex(h);
    this.push();
    let i = h.i;
    if (h.t === 'm') { i = h.i + 1; this.parts[h.p][h.r].splice(i, 0, this.ll(h.q[0], h.q[1], this.parts[h.p][h.r][h.i])); }
    this.drag = { p: h.p, r: h.r, i, x, y, moved: h.t === 'm', inserted: h.t === 'm' };
    this.map.setOptions({ gestureHandling: 'none' });
    this.hover = { t: 'v', p: h.p, r: h.r, i };
    this.changed(); this.cursor();
  }
  onMove(e) {
    if (!this.P) return;
    const [x, y] = this.evPx(e);
    if (this.drag) {
      const D = this.drag;
      if (!D.moved && Math.hypot(x - D.x, y - D.y) < 3) return;
      D.moved = true;
      const R = this.parts[D.p][D.r];
      R[D.i] = this.ll(x, y, R[D.i]);
      this.dirty(); return;
    }
    if (this.draw) {
      const Dw = this.draw; Dw.cursor = [x, y];
      if (Dw.down && (e.buttons & 1)) {
        if (!Dw.free && Math.hypot(x - Dw.down[0], y - Dw.down[1]) > 6) {
          Dw.free = true; Dw.freeStart = Dw.pts.length;
          Dw.pts.push(this.ll(Dw.down[0], Dw.down[1], Dw.pts[Dw.pts.length - 1]));
          Dw.freePx = [Dw.down];
        }
        if (Dw.free) { const l = Dw.freePx[Dw.freePx.length - 1]; if (Math.hypot(x - l[0], y - l[1]) >= 3) { Dw.freePx.push([x, y]); Dw.pts.push(this.ll(x, y, Dw.pts[Dw.pts.length - 1])); } }
      }
      this.dirty(); return;
    }
    if (e.buttons) return;  // panning the map
    const r = this.div.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom || e.target.closest?.('.polyedit-hud')) {
      if (this.hover || this.hoverPart >= 0) { this.hover = null; this.hoverPart = -1; this.dirty(); this.cursor(); } return;
    }
    this.updateHover(x, y);
  }
  updateHover(x, y) {
    let best = null, bd = HIT_V;
    for (const [p, r, i] of this.vis?.verts || []) { const q = this.scr[p][r][i], d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = { t: 'v', p, r, i }; } }
    if (!best) { bd = HIT_M; for (const [p, r, i, q] of this.vis?.mids || []) { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = { t: 'm', p, r, i, q }; } } }
    // the part under the cursor (inside it, or near its edge) for D
    let hp = -1;
    const s = this.snap(x, y); if (s && s.d < 10) hp = s.p;
    else if (this.closed) this.scr?.forEach((p, k) => { if (hp < 0 && p[0] && pip(p[0], x, y) && !p.slice(1).some(h => pip(h, x, y))) hp = k; });
    const k = JSON.stringify([best?.t, best?.p, best?.r, best?.i, hp]);
    if (k !== this._hk) { this._hk = k; this.hover = best; this.hoverPart = hp; this.dirty(); this.cursor(); }
  }
  onUp(e) {
    if (this.drag) {
      const D = this.drag; this.drag = null;
      this.map.setOptions({ gestureHandling: this.savedOpts.gestureHandling });
      if (!D.moved) this.hist.pop();  // a click on a vertex isn't an edit
      this.changed(); this.cursor(); return;
    }
    if (this.draw && this.draw.down) {
      const Dw = this.draw, [x, y] = this.evPx(e); Dw.down = null;
      if (Dw.free) {
        // thin the stroke (1 px in screen space) so a freehand line doesn't carry hundreds of points
        const seg = Dw.pts.slice(Dw.freeStart), P = seg.map(c => this.px(this.P, c));
        Dw.pts = Dw.pts.slice(0, Dw.freeStart).concat(dpIdx(P, 1.2, false).map(i => seg[i]));
        Dw.free = false;
        if (Dw.freeStart === 0 || Dw.mode === 'replace') return this.finishDraw();  // a single stroke is the whole path
        this.changed(); return;
      }
      // a click: close on the first point, finish on a double-click, else add a point
      const now = Date.now(), pts = Dw.pts;
      if (pts.length) {
        const f = this.px(this.P, pts[0]), l = this.px(this.P, pts[pts.length - 1]);
        if (Dw.mode !== 'replace' && this.closed && pts.length >= 3 && Math.hypot(x - f[0], y - f[1]) < 10) return this.finishDraw();
        if (now - (Dw.lastClick || 0) < 350 && Math.hypot(x - l[0], y - l[1]) < 8) return this.finishDraw();
      }
      Dw.lastClick = now;
      pts.push(this.ll(x, y, pts[pts.length - 1] || (this.parts[0]?.[0]?.[0])));
      this.changed();
    }
  }

  // ---------- drawing modes ----------
  startDraw(mode) {
    if (this.drag) return;
    if (mode === 'replace' && !this.parts.length) mode = 'redraw';
    this.draw = { mode, pts: [], free: false, down: null, cursor: null };
    this.hover = null; this.hoverPart = -1; this.escArm = 0;
    this.changed(); this.cursor();
  }
  cancelDraw() { this.draw = null; this.changed(); this.cursor(); }
  finishDraw() {
    const Dw = this.draw; if (!Dw) return;
    const pts = Dw.pts;
    if (Dw.mode === 'replace') return this.replace(pts);
    const need = this.closed ? 3 : 2;
    if (pts.length < need) return this.say(`Draw at least ${need} points (${Dw.mode === 'redraw' ? 'Esc cancels' : 'Esc cancels'})`);
    this.push();
    const part = [pts.map(c => [c[0], c[1]])];
    if (Dw.mode === 'redraw') this.parts = [part]; else this.parts.push(part);
    this.draw = null;
    this.say(Dw.mode === 'redraw' ? 'Redrawn. A adds another part; drag vertices to refine.' : 'Part added.');
    this.changed(); this.cursor();
  }
  replace(pts) {
    if (pts.length < 2) return this.say('Draw a path from near one boundary point to near another (Esc cancels)');
    const P = this.P, a = this.px(P, pts[0]), b = this.px(P, pts[pts.length - 1]);
    let S = this.snap(a[0], a[1]), E = this.snap(b[0], b[1]);
    let path = pts;
    const okS = S && S.d <= SNAP_PX, okE0 = E && E.d <= SNAP_PX;
    if (!okS && okE0) { path = [...pts].reverse(); [S, E] = [E, this.snap(a[0], a[1])]; }
    if (!(S && S.d <= SNAP_PX)) { this.draw.pts = []; this.changed(); return this.say(`Start (or end) the path within ${SNAP_PX}px of the outline`); }
    E = this.snap(...this.px(P, path[path.length - 1]), S);  // the end must snap onto the same ring
    const okE = E && E.d <= SNAP_PX;
    const R = this.parts[S.p][S.r], n = R.length;
    const sc = this.coordAt(S.p, S.r, S.u), mid = path.slice(1, -1).map(c => [c[0], c[1]]);
    const alts = [];
    const len = a => { let s = 0; for (let i = 1; i < a.length; i++) s += Math.hypot(a[i][0] - a[i - 1][0], a[i][1] - a[i - 1][1]); return s; };
    const sR = this.scr[S.p][S.r];
    if (this.closed) {
      if (!okE) { this.draw.pts = []; this.changed(); return this.say('End the path near the same outline it started on'); }
      const ec = this.coordAt(S.p, S.r, E.u), D = ((E.u - S.u) % n + n) % n;
      const fwd = [], back = [];
      for (let m = 1; m <= n; m++) {
        const k = (Math.floor(S.u) + m) % n, rel = ((k - S.u) % n + n) % n;
        if (rel < 1e-9 || Math.abs(rel - D) < 1e-9) continue;  // vertices the snap points sit on are replaced by them
        (rel < D ? fwd : back).push({ k, rel });
      }
      back.sort((x, y) => x.rel - y.rel); fwd.sort((x, y) => x.rel - y.rel);
      const head = [sc, ...mid, ec], fwdRev = [...fwd].reverse();
      const A = [...head, ...back.map(v => R[v.k])];     // replace the forward arc S -> E
      const B = [...head, ...fwdRev.map(v => R[v.k])];   // replace the backward arc E -> S
      const arcLen = list => len([S.q, ...list.map(v => sR[v.k]), E.q]);
      const lf = arcLen(fwd), lb = arcLen([...back].reverse());
      for (const [ring, l] of [[A, lf], [B, lb]]) if (ring.length >= 3) alts.push({ ring, l });
      alts.sort((x, y) => x.l - y.l);
    } else {
      const before = u => R.filter((_, k) => k < u - 1e-9), after = u => R.filter((_, k) => k > u + 1e-9);
      if (okE) {
        let s = S, e = E, m = mid;
        if (s.u > e.u) { [s, e] = [e, s]; m = [...mid].reverse(); }
        const ring = [...before(s.u), this.coordAt(S.p, S.r, s.u), ...m, this.coordAt(S.p, S.r, e.u), ...after(e.u)];
        alts.push({ ring, l: 0 });
      } else {  // one end free: extend / re-route one end of the line
        const free = path[path.length - 1];
        const keepHead = [...before(S.u), sc, ...mid, free], keepTail = [free, ...[...mid].reverse(), sc, ...after(S.u)];
        const lh = len(sR.filter((_, k) => k < S.u)), lt = len(sR.filter((_, k) => k > S.u));
        alts.push({ ring: keepHead, l: -lh }, { ring: keepTail, l: -lt });
        alts.sort((x, y) => x.l - y.l);
      }
    }
    if (!alts.length) { this.draw.pts = []; this.changed(); return this.say('That replacement would leave too few vertices'); }
    this.push();
    this.parts[S.p][S.r] = alts[0].ring.map(c => [c[0], c[1]]);
    this.lastReplace = alts.length > 1 ? { p: S.p, r: S.r, alts: alts.map(a => a.ring), i: 0, line: !this.closed } : null;
    this.draw = null;
    this.say(!this.lastReplace ? 'Replaced.' : this.closed ? 'Replaced the shorter side. F flips to the other side.'
      : 'Re-routed the shorter end of the line along your path. F re-routes the other end instead.');
    this.changed(); this.cursor();
  }
  flip() {
    const L = this.lastReplace; if (!L) return this.say('F flips the side of the last replacement (right after making it)');
    L.i = 1 - L.i; this.parts[L.p][L.r] = L.alts[L.i].map(c => [c[0], c[1]]);
    this.say(L.line ? `Flipped: re-routed the ${L.i ? 'longer' : 'shorter'} end` : `Flipped: replaced the ${L.i ? 'other' : 'shorter'} side`); this.changed();
  }

  // ---------- keys / actions ----------
  onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && e.key !== 'Escape') return;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k, mod = e.ctrlKey || e.metaKey;
    let used = true;
    if (k === ' ') { this.space = true; this.cursor(); }
    else if (mod && (lk === 'z')) e.shiftKey ? this.redo() : this.undo();
    else if (mod && lk === 'y') this.redo();
    else if (mod) used = false;  // leave other shortcuts (copy, reload…) alone
    else if (k === 'Escape') this.action('esc');
    else if (k === 'Enter') this.action(this.draw ? 'finish' : 'done');
    else if (k === 'Backspace' || k === 'Delete') {
      if (this.draw) { if (this.draw.pts.length) { this.draw.pts.pop(); this.changed(); } }
      else if (this.hover?.t === 'v') this.delVertex(this.hover);
      else this.say('Hover over a vertex to delete it');
    }
    else if (lk === 'r') this.action('replace');
    else if (lk === 'n') this.action('redraw');
    else if (lk === 'a') this.action('part');
    else if (lk === 'd') this.action('delpart');
    else if (lk === 'f') this.action('flip');
    else if (lk === 'e') this.action('done');
    else if (k === '-' || k === '_') this.map.setZoom(this.map.getZoom() - 1);
    else if (k === '=' || k === '+') this.map.setZoom(this.map.getZoom() + 1);
    else if (k.startsWith('Arrow')) {}  // swallowed: hosts use arrows for navigation (review: next blob)
    else if (k === 'Tab' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'Control') used = false;
    // any other plain key is swallowed so the host app's shortcuts don't fire mid-edit
    if (used || !mod) { if (used || k.length === 1) { e.preventDefault(); e.stopImmediatePropagation(); } }
  }
  action(a) {
    if (a === 'undo') this.undo();
    else if (a === 'redo') this.redo();
    else if (a === 'replace') this.draw?.mode === 'replace' ? this.cancelDraw() : this.startDraw('replace');
    else if (a === 'redraw') this.draw?.mode === 'redraw' ? this.cancelDraw() : this.startDraw('redraw');
    else if (a === 'part') this.draw?.mode === 'part' ? this.cancelDraw() : this.startDraw('part');
    else if (a === 'delpart') this.delPart();
    else if (a === 'flip') this.flip();
    else if (a === 'finish') this.finishDraw();
    else if (a === 'esc') {
      if (this.draw) { if (this.draw.pts.length) { this.draw.pts = []; this.changed(); } else this.cancelDraw(); return; }
      if (this.isChanged() && Date.now() - this.escArm > 4000) { this.escArm = Date.now(); return this.say('Discard your edits? Press Esc again (Enter keeps them)'); }
      this.close(false);
    }
    else if (a === 'cancel') this.close(false);
    else if (a === 'done') {
      if (this.draw) { if (this.draw.pts.length >= (this.draw.mode === 'replace' ? 2 : this.closed ? 3 : 2)) this.finishDraw(); else this.cancelDraw(); if (this.draw) return; }
      if (this.isChanged() && !this.count()) return this.say('The outline is empty: draw one (N) or undo');
      if (this.isChanged() && this.crosses && !this.crossOk) { this.crossOk = true; return this.say('⚠ The outline crosses itself. Press Done again to keep it anyway.'); }
      this.close(true);
    }
  }
  isChanged() { return JSON.stringify(this.parts) !== this.start; }
  geometry() { return toGeoJSON(this.kind, this.parts); }
  meta() { return { vertices: this.count(), orig_vertices: this.origVertices, tol_m: Math.round(this.tolM), parts: this.parts.length, dropped_rings: this.dropped || 0 }; }
  close(keep) {
    if (!this.svg) return;
    const g = keep && this.isChanged() ? this.geometry() : null, meta = this.meta();
    cancelAnimationFrame(this.raf);
    this.L.forEach(f => f()); this.svg.remove(); this.hud.remove(); this.svg = null;
    this.ov.setMap(null);
    this.map.setOptions(this.savedOpts);
    if (current === this) current = null;
    if (keep) this.onDone(g, meta);
    this.onClose(keep);
  }

  // ---------- HUD ----------
  placeHud() {  // top centre of the map, clear of side panels
    const r = this.div.getBoundingClientRect(), w = Math.min(600, r.width - 20);
    Object.assign(this.hud.style, { left: r.left + (r.width - w) / 2 + 'px', top: r.top + 10 + 'px', width: w + 'px', maxWidth: '' });
  }
  updateHud() {
    if (!this.hud) return;
    this.placeHud();
    this.crosses = this.closed && this.parts.some(p => p.some(r => r.length <= 1500 && ringCrosses(r)));
    if (!this.crosses) this.crossOk = false;
    const n = this.count(), Dw = this.draw;
    const b = (a, label, title, on) => `<button data-a="${a}" title="${esc(title)}" style="padding:4px 8px;font-size:12px${on ? ';background:#4fe3ff;color:#001a2c' : ''}">${label}</button>`;
    const help = Dw ? (Dw.mode === 'replace'
        ? 'Replace a stretch: click points or drag freehand, starting near the outline and ending near it again. Enter finishes a clicked path; Backspace removes the last point; Space+drag pans; Esc cancels.'
        : `${Dw.mode === 'redraw' ? 'Redraw from scratch' : 'New part'}: click points or drag freehand. ${this.closed ? 'Click the first point, double-click or Enter to close.' : 'Double-click or Enter to finish.'} Backspace removes the last point; Space+drag pans; Esc cancels.`)
      : 'Drag vertices · click a small dot to add one · right-click / Alt-click / Backspace deletes · <b>R</b> replace a stretch · <b>N</b> redraw · <b>A</b> add part · <b>D</b> delete hovered part · Ctrl/⌘-Z undo, ⇧ redo · <b>Enter</b> done · <b>Esc</b> leave';
    const msg = Date.now() - this.msgAt < 4000 ? this.msg : '';
    this.hud.innerHTML = `<div class="row" style="gap:6px"><b>✎ Editing${this.title ? ': ' + esc(this.title) : ''}</b>
      <span class="muted small grow">${n.toLocaleString()} vertices${this.parts.length > 1 ? ` · ${this.parts.length} parts` : ''}${this.origVertices > n && this.tolM ? ` · simplified from ${this.origVertices.toLocaleString()} (≤ ${this.tolM < 1000 ? Math.round(this.tolM) + ' m' : (this.tolM / 1000).toFixed(1) + ' km'}${this.dropped ? `; ${this.dropped} tiny ring${this.dropped > 1 ? 's' : ''} dropped` : ''})` : ''}${this.tooDense ? ' · zoom in to see vertices' : ''}</span>
      ${this.crosses ? '<span class="small" style="color:var(--warn)">⚠ crosses itself</span>' : ''}</div>
      <div class="small muted" style="margin:4px 0 6px">${help}</div>
      ${msg ? `<div class="small" style="color:#ffe27a;margin-bottom:6px">${esc(msg)}</div>` : ''}
      <div class="row" style="gap:5px">${b('undo', 'Undo', 'Undo (Ctrl/⌘-Z)')}${b('redo', 'Redo', 'Redo (Shift-Ctrl/⌘-Z)')}
        ${b('replace', 'Replace (R)', 'Replace a stretch of the boundary with a drawn path', Dw?.mode === 'replace')}
        ${b('redraw', 'Redraw (N)', 'Scrap the outline and draw it anew', Dw?.mode === 'redraw')}
        ${b('part', 'Add part (A)', 'Draw another part', Dw?.mode === 'part')}
        ${b('delpart', 'Delete part (D)', 'Delete the part under the cursor')}
        ${this.lastReplace ? b('flip', 'Flip (F)', 'Replace the other side instead') : ''}
        <span class="grow"></span>${b('cancel', 'Cancel', 'Discard the edits (Esc)')}<button data-a="done" class="primary" style="padding:4px 10px;font-size:12px" title="Keep the edited outline (Enter)">${esc(this.doneLabel)}</button></div>`;
  }
}

function pip(r, x, y) {  // point in ring (screen px)
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
