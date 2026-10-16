// World data: equirectangular texture (for raster rendering), a land mask (for land-on-cut
// metrics), and densified vector lines (coastlines, borders, graticule, Tissot circles).
/* global d3, topojson */
import * as V from './vec.js';

export const TEX_W = 4096, TEX_H = 2048;
export const MASK_W = 2048, MASK_H = 1024;

export const STYLE = {
  ocean: '#bcd8e6',
  oceanDeep: '#a6c9db',
  land: '#efe8d2',
  landEdge: '#d9cfae',
};

/** Densify a lon/lat line into unit vectors with max step (radians). */
function densify(coords, maxStep = 0.012) {
  const out = [];
  let prev = null;
  for (const [lon, lat] of coords) {
    const v = V.lonLatToVec(lon, lat);
    if (prev) {
      const a = V.angle(prev, v);
      const n = Math.ceil(a / maxStep);
      for (let i = 1; i < n; i++) out.push(V.slerp(prev, v, i / n));
    }
    out.push(v);
    prev = v;
  }
  return out;
}

function geomLines(geom) {
  const lines = [];
  const add = (c) => lines.push(densify(c));
  if (!geom) return lines;
  if (geom.type === 'FeatureCollection') { for (const f of geom.features) lines.push(...geomLines(f.geometry)); return lines; }
  if (geom.type === 'Feature') return geomLines(geom.geometry);
  if (geom.type === 'LineString') add(geom.coordinates);
  if (geom.type === 'MultiLineString') geom.coordinates.forEach(add);
  if (geom.type === 'Polygon') geom.coordinates.forEach(add);
  if (geom.type === 'MultiPolygon') geom.coordinates.forEach((p) => p.forEach(add));
  return lines;
}

function decimate(lines, k) {
  return lines.filter((l) => l.length >= 2 * k || k === 1).map((l) => l.filter((_, i) => i % k === 0 || i === l.length - 1));
}

function graticule(step = 15) {
  const lines = [];
  for (let lon = -180; lon < 180; lon += step) {
    const c = [];
    for (let lat = -90; lat <= 90; lat += 1) c.push([lon, lat]);
    lines.push(densify(c));
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    const c = [];
    for (let lon = -180; lon <= 180; lon += 1) c.push([lon, lat]);
    lines.push(densify(c));
  }
  return lines;
}

function tissot(radiusDeg = 4.5) {
  const rings = [];
  const r = (radiusDeg * Math.PI) / 180;
  const pts = [];
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 30) pts.push([lon, lat]);
  pts.push([0, 90], [0, -90]);
  for (const [lon, lat] of pts) {
    const c = V.lonLatToVec(lon, lat);
    const e1 = V.norm(Math.abs(c[2]) > 0.99 ? V.cross([1, 0, 0], c) : V.cross([0, 0, 1], c));
    const e2 = V.cross(c, e1);
    const ring = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * 2 * Math.PI;
      ring.push(V.norm(V.add(V.scale(c, Math.cos(r)), V.add(V.scale(e1, Math.sin(r) * Math.cos(t)), V.scale(e2, Math.sin(r) * Math.sin(t))))));
    }
    rings.push(ring);
  }
  return rings;
}

function makeTexture(land) {
  const cv = document.createElement('canvas');
  cv.width = TEX_W; cv.height = TEX_H;
  const ctx = cv.getContext('2d');
  // ocean with a subtle latitude gradient
  const grad = ctx.createLinearGradient(0, 0, 0, TEX_H);
  grad.addColorStop(0, '#cfe3ec'); grad.addColorStop(0.5, STYLE.ocean); grad.addColorStop(1, '#cfe3ec');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, TEX_W, TEX_H);
  const proj = d3.geoEquirectangular().scale(TEX_W / (2 * Math.PI)).translate([TEX_W / 2, TEX_H / 2]).precision(0.1);
  const path = d3.geoPath(proj, ctx);
  ctx.beginPath(); path(land);
  ctx.fillStyle = STYLE.land; ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = STYLE.landEdge; ctx.stroke();
  return ctx.getImageData(0, 0, TEX_W, TEX_H);
}

function makeMask(land) {
  const cv = document.createElement('canvas');
  cv.width = MASK_W; cv.height = MASK_H;
  const ctx = cv.getContext('2d');
  const proj = d3.geoEquirectangular().scale(MASK_W / (2 * Math.PI)).translate([MASK_W / 2, MASK_H / 2]);
  const path = d3.geoPath(proj, ctx);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, MASK_W, MASK_H);
  ctx.beginPath(); path(land); ctx.fillStyle = '#fff'; ctx.fill();
  const img = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
  const mask = new Uint8Array(MASK_W * MASK_H);
  for (let i = 0; i < mask.length; i++) mask[i] = img[i * 4] > 127 ? 1 : 0;
  return mask;
}

/** Texture wrapper with fast lookup by unit vector. */
export function wrapTexture(imgData) {
  return { w: imgData.width, h: imgData.height, data32: new Uint32Array(imgData.data.buffer.slice(0)) };
}

export async function loadWorld() {
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const [land50, countries] = await Promise.all([get('vendor/land-50m.json'), get('vendor/countries-110m.json')]);
  const land = topojson.feature(land50, land50.objects.land);
  const borders = topojson.mesh(countries, countries.objects.countries, (a, b) => a !== b);
  const coast = geomLines(land);
  const bord = geomLines(borders);
  const grat = graticule(15);
  return {
    // decimated versions used while dragging
    lo: { coast: decimate(coast, 5), borders: decimate(bord, 3), graticule: decimate(grat, 3), tissot: tissot() },
    land,
    texture: wrapTexture(makeTexture(land)),
    defaultTexture: null,
    mask: makeMask(land),
    coast,
    borders: bord,
    graticule: grat,
    tissot: tissot(),
  };
}

/** Load a user-supplied equirectangular image as texture. */
export function textureFromImage(img) {
  const cv = document.createElement('canvas');
  const w = Math.min(img.naturalWidth, 8192), h = Math.round(w / 2);
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return wrapTexture(ctx.getImageData(0, 0, w, h));
}

export function isLand(mask, P) {
  const lon = Math.atan2(P[1], P[0]), lat = Math.asin(Math.max(-1, Math.min(1, P[2])));
  let x = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * MASK_W);
  let y = Math.floor(((Math.PI / 2 - lat) / Math.PI) * MASK_H);
  if (x >= MASK_W) x = MASK_W - 1; if (y >= MASK_H) y = MASK_H - 1; if (x < 0) x = 0; if (y < 0) y = 0;
  return mask[y * MASK_W + x];
}

/** Land length (radians of arc) along each edge, given the polyhedron->earth matrix R. */
export function edgeLandWeights(G, R, mask, stride = 1) {
  const w = new Float64Array(G.edges.length);
  for (const e of G.edges) {
    const S = e.samples;
    let cnt = 0, tot = 0;
    for (let i = 0; i < S.length; i += stride) {
      const p = S[i];
      const E = [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
      cnt += isLand(mask, E); tot++;
    }
    w[e.id] = (cnt / tot) * e.len;
  }
  return w;
}
