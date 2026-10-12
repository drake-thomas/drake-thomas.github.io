// Shared protected-area review helpers (apps/review/board.html map-wide board, apps/review/index.html gavel):
// Web Mercator "world" coordinates (256 px at z0), decoding of the review blobs' delta-encoded rings, a raster union of
// member outlines for the polygon editor, member ordering and the review-item id for an explicit member set.
export const R2D = 180 / Math.PI;
export const wx = lng => (lng + 180) / 360 * 256;
export const wy = lat => { const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) / R2D); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256; };
export const lngOf = x => x / 256 * 360 - 180;
export const latOf = y => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 256)));
export const hash6 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 6); };

export function decodeRing(r, scale) {  // delta-encoded [x0, y0, dx, dy, …] (lng/lat * scale) -> world Float64Array [x, y, …]
  const a = new Float64Array(r.length); let x = 0, y = 0;
  for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; a[i] = wx(x / scale); a[i + 1] = wy(y / scale); }
  return a;
}
export function bbOf(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const a of rings) for (let i = 0; i < a.length; i += 2) { const x = a[i], y = a[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
export function shapeOf(g, scale) {  // polys [[outer, hole…]…] -> {rings, outer: [bool], bb, lod}
  const rings = [], outer = [];
  for (const poly of g || []) poly.forEach((r, k) => { if (r.length >= 6) { rings.push(decodeRing(r, scale)); outer.push(k === 0); } });
  return { rings, outer, bb: bbOf(rings), lod: {} };
}
export function geoShape(g) {  // GeoJSON Polygon/MultiPolygon -> shape
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const rings = [], outer = [];
  for (const p of polys) p.forEach((r, k) => {
    const a = new Float64Array(r.length * 2); r.forEach((c, i) => { a[2 * i] = wx(c[0]); a[2 * i + 1] = wy(c[1]); });
    rings.push(a); outer.push(k === 0);
  });
  return { rings, outer, bb: bbOf(rings), lod: {} };
}
export function toGeoJSON(sh) {  // shape -> GeoJSON (an outer ring starts a polygon)
  const polys = [];
  sh.rings.forEach((a, k) => {
    const ring = []; for (let i = 0; i < a.length; i += 2) ring.push([+lngOf(a[i]).toFixed(5), +latOf(a[i + 1]).toFixed(5)]);
    ring.push(ring[0]); if (sh.outer[k] || !polys.length) polys.push([ring]); else polys[polys.length - 1].push(ring);
  });
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}
export function dp(a, tol) {  // Douglas-Peucker on a closed ring of [x, y, …]; returns a new Float64Array
  const n = a.length / 2; if (n <= 4) return a;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  let far = 0, fd = -1; for (let i = 1; i < n; i++) { const d = (a[2 * i] - a[0]) ** 2 + (a[2 * i + 1] - a[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  keep[far] = 1;
  const st = [0, far, far, n - 1], t2 = tol * tol;
  while (st.length) {
    const b = st.pop(), s = st.pop(); if (b - s < 2) continue;
    const ax = a[2 * s], ay = a[2 * s + 1], dx = a[2 * b] - ax, dy = a[2 * b + 1] - ay, L = dx * dx + dy * dy;
    let best = -1, bi = -1;
    for (let i = s + 1; i < b; i++) {
      const px = a[2 * i] - ax, py = a[2 * i + 1] - ay; let t = L ? (px * dx + py * dy) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2; if (d > best) { best = d; bi = i; }
    }
    if (best > t2) { keep[bi] = 1; st.push(s, bi, bi, b); }
  }
  let m = 0; for (let i = 0; i < n; i++) m += keep[i];
  const o = new Float64Array(m * 2); let j = 0;
  for (let i = 0; i < n; i++) if (keep[i]) { o[j++] = a[2 * i]; o[j++] = a[2 * i + 1]; }
  return o;
}

// Union of several shapes' outer rings as GeoJSON (holes filled), for the polygon editor: one shape is returned as is;
// otherwise a raster union.
export function unionOutline(ms) {
  ms = ms.filter(m => m?.rings?.length);
  if (!ms.length) return null;
  if (ms.length === 1) return toGeoJSON(ms[0]);
  // raster union: fill outer rings on a grid (<= 1400 cells across; a 2-cell stroke closes slivers between touching
  // reserves), trace the cell boundaries into rings, keep the outer ones (holes filled), simplify
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of ms) { x0 = Math.min(x0, m.bb[0]); y0 = Math.min(y0, m.bb[1]); x1 = Math.max(x1, m.bb[2]); y1 = Math.max(y1, m.bb[3]); }
  const N = 1400, cell = Math.max(x1 - x0, y1 - y0) / N, pad = 3;
  const gw = Math.ceil((x1 - x0) / cell) + 2 * pad, gh = Math.ceil((y1 - y0) / cell) + 2 * pad;
  const c2 = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(gw, gh) : Object.assign(document.createElement('canvas'), { width: gw, height: gh })).getContext('2d', { willReadFrequently: true });
  c2.beginPath();
  for (const m of ms) m.rings.forEach((a, k) => {
    if (!m.outer[k]) return;
    c2.moveTo((a[0] - x0) / cell + pad, (a[1] - y0) / cell + pad);
    for (let i = 2; i < a.length; i += 2) c2.lineTo((a[i] - x0) / cell + pad, (a[i + 1] - y0) / cell + pad);
    c2.lineTo((a[0] - x0) / cell + pad, (a[1] - y0) / cell + pad);
  });
  c2.fillStyle = '#000'; c2.fill('nonzero'); c2.lineWidth = 2; c2.lineJoin = 'round'; c2.strokeStyle = '#000'; c2.stroke();
  const px = c2.getImageData(0, 0, gw, gh).data;
  const ins = (i, j) => i >= 0 && j >= 0 && i < gw && j < gh && px[(j * gw + i) * 4 + 3] >= 128;
  const VW = gw + 1, o1 = new Int8Array(VW * (gh + 1)).fill(-1), o2 = new Int8Array(VW * (gh + 1)).fill(-1);
  const put = (i, j, d) => { const v = j * VW + i; if (o1[v] < 0) o1[v] = d; else o2[v] = d; };
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) if (ins(i, j)) {
    if (!ins(i, j - 1)) put(i, j, 0); if (!ins(i + 1, j)) put(i + 1, j, 1);
    if (!ins(i, j + 1)) put(i + 1, j + 1, 2); if (!ins(i - 1, j)) put(i, j + 1, 3);
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1], polys = [];
  for (let v0 = 0; v0 < o1.length; v0++) {
    if (o1[v0] < 0 && o2[v0] < 0) continue;
    const pts = []; let v = v0, din = -1;
    for (let guard = 0; guard < 4e6; guard++) {
      let d;
      if (o1[v] >= 0 && o2[v] >= 0) {  // saddle: turn right of the incoming direction if possible
        const pref = [(din + 1) % 4, din, (din + 3) % 4];
        d = pref.find(p => p === o1[v] || p === o2[v]) ?? o1[v];
      } else d = o1[v] >= 0 ? o1[v] : o2[v];
      if (d === undefined || d < 0) break;
      if (o1[v] === d) o1[v] = -1; else o2[v] = -1;
      const i = v % VW, j = (v - i) / VW;
      if (d !== din) pts.push(i, j);
      din = d; v = (j + DY[d]) * VW + (i + DX[d]);
      if (v === v0) break;
    }
    let area = 0; const n = pts.length / 2;
    for (let k = 0; k < n; k++) { const k2 = (k + 1) % n; area += pts[2 * k] * pts[2 * k2 + 1] - pts[2 * k2] * pts[2 * k + 1]; }
    if (area / 2 < 6) continue;  // holes come out negative (filled anyway); drop specks
    const simp = dp(Float64Array.from(pts), 1.0);
    const ring = []; for (let k = 0; k < simp.length; k += 2) ring.push([+lngOf((simp[k] - pad) * cell + x0).toFixed(5), +latOf((simp[k + 1] - pad) * cell + y0).toFixed(5)]);
    if (ring.length < 3) continue;
    ring.push(ring[0]); polys.push([ring]);
  }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

// biggest non-umbrella member first
export const orderMembers = ms => [...ms].sort((A, B) => (A.umb || 0) - (B.umb || 0) || (B.km2 || 0) - (A.km2 || 0));
// review-item id for an explicit member set that isn't one whole blob: "pm:<primary ref>[+<n-1>~<hash of the sorted refs>]"
export const memberSetId = refs => `pm:${refs[0]}` + (refs.length > 1 ? `+${refs.length - 1}~${hash6([...refs].sort().join(','))}` : '');
export const MAX_MEMBERS = 300;  // tools/feedback_worker caps review items' members at 300
