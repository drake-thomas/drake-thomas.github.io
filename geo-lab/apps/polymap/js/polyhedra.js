// Polyhedron construction: seeds, Conway operators, canonicalization, convex hull,
// half-space modifications (truncation / chamfer), geodesic and flat face splits.
// A polyhedron is { verts: [[x,y,z]], faces: [[i,j,k,...]] } with faces CCW seen from outside.
import * as V from './vec.js';
import { MONOHEDRA } from './monohedra-data.js';

// ---------------------------------------------------------------- basics
export function newellNormal(pts) {
  const n = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return V.norm(n);
}

export function facePlane(poly, f) {
  const pts = f.map((i) => poly.verts[i]);
  const n = newellNormal(pts);
  let d = 0;
  for (const p of pts) d += V.dot(n, p);
  return { n, d: d / pts.length };
}

/** Make every face CCW seen from outside (assumes origin is inside). */
export function orientFaces(poly) {
  const faces = poly.faces.map((f) => {
    const pts = f.map((i) => poly.verts[i]);
    return V.dot(newellNormal(pts), V.centroid(pts)) < 0 ? f.slice().reverse() : f.slice();
  });
  return { verts: poly.verts, faces };
}

export function edgeList(poly) {
  const seen = new Set(), out = [];
  for (const f of poly.faces) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    const key = a < b ? a + '_' + b : b + '_' + a;
    if (!seen.has(key)) { seen.add(key); out.push([Math.min(a, b), Math.max(a, b)]); }
  }
  return out;
}

function dirEdgeMap(poly) {
  const m = new Map();
  poly.faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) m.set(f[k] + '>' + f[(k + 1) % f.length], fi);
  });
  return m;
}

/** Drop unused vertices and reindex. */
function compact(poly) {
  const used = new Map(), verts = [];
  const faces = poly.faces.map((f) => f.map((i) => {
    if (!used.has(i)) { used.set(i, verts.length); verts.push(poly.verts[i]); }
    return used.get(i);
  }));
  return { verts, faces };
}

// ---------------------------------------------------------------- convex hull
/**
 * Incremental 3D convex hull. Returns polygonal faces (coplanar triangles merged,
 * collinear boundary vertices removed), CCW from outside.
 */
export function convexHull(points, epsRel = 1e-9) {
  const P = points;
  const n = P.length;
  let maxAbs = 0;
  for (const p of P) maxAbs = Math.max(maxAbs, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = epsRel * Math.max(maxAbs, 1e-12);

  // initial simplex
  const i0 = 0;
  let i1 = -1, best = -1;
  for (let i = 0; i < n; i++) { const d = V.dist2(P[i], P[i0]); if (d > best) { best = d; i1 = i; } }
  let i2 = -1; best = -1;
  const d01 = V.sub(P[i1], P[i0]);
  for (let i = 0; i < n; i++) {
    const d = V.len(V.cross(d01, V.sub(P[i], P[i0])));
    if (d > best) { best = d; i2 = i; }
  }
  let i3 = -1; best = -1;
  const nrm = V.norm(V.cross(d01, V.sub(P[i2], P[i0])));
  for (let i = 0; i < n; i++) {
    const d = Math.abs(V.dot(nrm, V.sub(P[i], P[i0])));
    if (d > best) { best = d; i3 = i; }
  }
  if (best <= eps) throw new Error('Hull: points are coplanar');
  const interior = V.centroid([P[i0], P[i1], P[i2], P[i3]]);

  const faces = [];
  const emap = new Map(); // "a>b" -> face index
  function addFace(a, b, c) {
    const nn = V.norm(V.cross(V.sub(P[b], P[a]), V.sub(P[c], P[a])));
    const f = { v: [a, b, c], n: nn, d: V.dot(nn, P[a]), alive: true, vis: false };
    const idx = faces.length;
    faces.push(f);
    emap.set(a + '>' + b, idx); emap.set(b + '>' + c, idx); emap.set(c + '>' + a, idx);
    return f;
  }
  function addOriented(a, b, c) {
    const nn = V.cross(V.sub(P[b], P[a]), V.sub(P[c], P[a]));
    if (V.dot(nn, V.sub(interior, P[a])) > 0) addFace(a, c, b); else addFace(a, b, c);
  }
  addOriented(i0, i1, i2); addOriented(i0, i1, i3); addOriented(i0, i2, i3); addOriented(i1, i2, i3);

  const initial = new Set([i0, i1, i2, i3]);
  for (let i = 0; i < n; i++) {
    if (initial.has(i)) continue;
    const p = P[i];
    const vis = [];
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      if (f.alive && V.dot(f.n, p) - f.d > eps) { vis.push(fi); f.vis = true; }
    }
    if (!vis.length) continue;
    const horizon = [];
    for (const fi of vis) {
      const [a, b, c] = faces[fi].v;
      for (const [u, w] of [[a, b], [b, c], [c, a]]) {
        const t = emap.get(w + '>' + u);
        if (t === undefined || !faces[t].vis) horizon.push([u, w]);
      }
    }
    for (const fi of vis) {
      const f = faces[fi];
      f.alive = false; f.vis = false;
      const [a, b, c] = f.v;
      for (const [u, w] of [[a, b], [b, c], [c, a]]) if (emap.get(u + '>' + w) === fi) emap.delete(u + '>' + w);
    }
    for (const [u, w] of horizon) addFace(u, w, i);
  }

  // merge coplanar triangles
  const alive = faces.map((f, i) => (f.alive ? i : -1)).filter((i) => i >= 0);
  const parent = new Map(alive.map((i) => [i, i]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const angTol = 1e-6;
  for (const fi of alive) {
    const f = faces[fi];
    const [a, b, c] = f.v;
    for (const [u, w] of [[a, b], [b, c], [c, a]]) {
      const g = emap.get(w + '>' + u);
      if (g === undefined) continue;
      const fg = faces[g];
      if (V.dot(f.n, fg.n) > 1 - angTol && Math.abs(f.d - fg.d) < 1e3 * eps + 1e-7 * maxAbs) {
        const ra = find(fi), rb = find(g);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const groups = new Map();
  for (const fi of alive) {
    const r = find(fi);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(fi);
  }
  const outFaces = [];
  for (const g of groups.values()) {
    const inGroup = new Set(g);
    const next = new Map();
    for (const fi of g) {
      const [a, b, c] = faces[fi].v;
      for (const [u, w] of [[a, b], [b, c], [c, a]]) {
        const t = emap.get(w + '>' + u);
        if (t === undefined || !inGroup.has(t)) next.set(u, w);
      }
    }
    const start = next.keys().next().value;
    const poly = [];
    let cur = start, guard = 0;
    do { poly.push(cur); cur = next.get(cur); if (++guard > 10000) throw new Error('Hull: bad boundary'); } while (cur !== start);
    outFaces.push(poly);
  }
  // remove collinear vertices
  const colTol = 1e-9;
  const cleaned = outFaces.map((f) => f.filter((v, k) => {
    const a = P[f[(k - 1 + f.length) % f.length]], b = P[v], c = P[f[(k + 1) % f.length]];
    const e1 = V.norm(V.sub(b, a)), e2 = V.norm(V.sub(c, b));
    return V.len(V.cross(e1, e2)) > colTol;
  }));
  return compact({ verts: P.map((p) => p.slice()), faces: cleaned });
}

// ---------------------------------------------------------------- dual / canonical
/** Polar reciprocal about the unit sphere (requires planar faces, origin inside). */
export function reciprocal(poly) {
  const verts = poly.faces.map((f) => { const { n, d } = facePlane(poly, f); return V.scale(n, 1 / d); });
  const em = dirEdgeMap(poly);
  const vFace = new Array(poly.verts.length).fill(-1);
  poly.faces.forEach((f, fi) => f.forEach((v) => { if (vFace[v] < 0) vFace[v] = fi; }));
  const faces = [];
  for (let v = 0; v < poly.verts.length; v++) {
    const f0 = vFace[v];
    if (f0 < 0) continue;
    const ring = [];
    let f = f0, guard = 0;
    do {
      ring.push(f);
      const face = poly.faces[f];
      const i = face.indexOf(v);
      const nx = face[(i + 1) % face.length];
      f = em.get(nx + '>' + v);
      if (f === undefined || ++guard > 1000) throw new Error('reciprocal: non-manifold');
    } while (f !== f0);
    faces.push(ring);
  }
  return orientFaces({ verts, faces });
}

function tangentPoint(a, b) {
  const d = V.sub(b, a);
  const t = -V.dot(a, d) / V.dot(d, d);
  return V.add(a, V.scale(d, t));
}

/** Hart's canonicalization: edges tangent to the unit sphere, planar faces, centered. */
export function canonicalize(poly, maxIter = 3000) {
  let verts = poly.verts.map((v) => v.slice());
  const edges = edgeList(poly);
  const faces = poly.faces;
  // normalize initial scale so edges are roughly tangent to unit sphere
  {
    let s = 0;
    for (const [a, b] of edges) s += V.len(tangentPoint(verts[a], verts[b]));
    s /= edges.length;
    if (s > 0) verts = verts.map((v) => V.scale(v, 1 / s));
  }
  const K = 0.3;
  for (let it = 0; it < maxIter; it++) {
    const nv = verts.map((v) => v.slice());
    // tangentify
    for (const [a, b] of edges) {
      const t = tangentPoint(verts[a], verts[b]);
      const c = V.scale(t, (K / 2) * (1 - V.len(t)));
      nv[a] = V.add(nv[a], c); nv[b] = V.add(nv[b], c);
    }
    // recenter
    let cen = [0, 0, 0];
    for (const [a, b] of edges) cen = V.add(cen, tangentPoint(nv[a], nv[b]));
    cen = V.scale(cen, 1 / edges.length);
    for (let i = 0; i < nv.length; i++) nv[i] = V.sub(nv[i], cen);
    // planarize
    const pv = nv.map((v) => v.slice());
    for (const f of faces) {
      const pts = f.map((i) => nv[i]);
      let nn = newellNormal(pts);
      const c = V.centroid(pts);
      if (V.dot(nn, c) < 0) nn = V.neg(nn);
      for (const i of f) pv[i] = V.add(pv[i], V.scale(nn, K * V.dot(nn, V.sub(c, nv[i]))));
    }
    let maxMove = 0;
    for (let i = 0; i < pv.length; i++) maxMove = Math.max(maxMove, V.dist2(pv[i], verts[i]));
    verts = pv;
    if (it > 20 && maxMove < 1e-26) break;
  }
  return orientFaces({ verts, faces });
}

/** Max distance of any face vertex from its face's best-fit plane (diagnostic). */
export function planarityError(poly) {
  let m = 0;
  for (const f of poly.faces) {
    const { n, d } = facePlane(poly, f);
    for (const i of f) m = Math.max(m, Math.abs(V.dot(n, poly.verts[i]) - d));
  }
  return m;
}

// ---------------------------------------------------------------- seeds
const PHI = (1 + Math.sqrt(5)) / 2;
function cyc(list) {
  const out = [];
  for (const [x, y, z] of list) out.push([x, y, z], [z, x, y], [y, z, x]);
  return out;
}
function signs(p) {
  const out = [];
  const sx = p[0] ? [1, -1] : [1], sy = p[1] ? [1, -1] : [1], sz = p[2] ? [1, -1] : [1];
  for (const a of sx) for (const b of sy) for (const c of sz) out.push([p[0] * a, p[1] * b, p[2] * c]);
  return out;
}

export function seed(letter, n = 5) {
  let pts;
  switch (letter) {
    case 'T': pts = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]; break;
    case 'C': pts = signs([1, 1, 1]); break;
    case 'O': pts = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]; break;
    case 'I': pts = cyc(signs([0, 1, PHI])); break;
    case 'D': pts = [...signs([1, 1, 1]), ...cyc(signs([0, 1 / PHI, PHI]))]; break;
    case 'P': {
      const h = Math.sin(Math.PI / n);
      pts = [];
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        pts.push([Math.cos(a), Math.sin(a), h], [Math.cos(a), Math.sin(a), -h]);
      }
      break;
    }
    case 'A': {
      const h = Math.sqrt(Math.max(0.01, Math.sin(Math.PI / n) ** 2 - Math.sin(Math.PI / (2 * n)) ** 2));
      pts = [];
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n, b = a + Math.PI / n;
        pts.push([Math.cos(a), Math.sin(a), h], [Math.cos(b), Math.sin(b), -h]);
      }
      break;
    }
    case 'Y': {
      pts = [[0, 0, 1]];
      for (let k = 0; k < n; k++) {
        const a = (2 * Math.PI * k) / n;
        pts.push([Math.cos(a), Math.sin(a), -0.4]);
      }
      break;
    }
    default: throw new Error('Unknown seed ' + letter);
  }
  return canonicalize(orientFaces(convexHull(pts)));
}

// ---------------------------------------------------------------- Conway operators (flag based)
class Flag {
  constructor() { this.vpos = new Map(); this.faces = new Map(); }
  v(name, p) { if (!this.vpos.has(name)) this.vpos.set(name, p); }
  f(face, a, b) {
    let m = this.faces.get(face);
    if (!m) { m = new Map(); this.faces.set(face, m); }
    m.set(a, b);
  }
  toPoly() {
    const names = [...this.vpos.keys()];
    const idx = new Map(names.map((nm, i) => [nm, i]));
    const verts = names.map((nm) => this.vpos.get(nm));
    const faces = [];
    for (const m of this.faces.values()) {
      const start = m.keys().next().value;
      const face = [];
      let cur = start, guard = 0;
      do {
        if (!idx.has(cur)) throw new Error('flag: unknown vertex ' + cur);
        face.push(idx.get(cur));
        cur = m.get(cur);
        if (cur === undefined || ++guard > 1000) throw new Error('flag: open face');
      } while (cur !== start);
      faces.push(face);
    }
    return orientFaces({ verts, faces });
  }
}
const fc = (poly, f) => V.centroid(f.map((i) => poly.verts[i]));
const mid = (a, b) => (a < b ? `m${a}_${b}` : `m${b}_${a}`);

function kisRaw(poly) {
  const F = new Flag();
  poly.verts.forEach((p, i) => F.v('v' + i, p));
  poly.faces.forEach((f, i) => {
    const c = fc(poly, f);
    const n = newellNormal(f.map((j) => poly.verts[j]));
    F.v('f' + i, V.add(c, V.scale(n, 0.1 * V.len(c))));
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length], fn = `f${i}_${a}`;
      F.f(fn, 'v' + a, 'v' + b); F.f(fn, 'v' + b, 'f' + i); F.f(fn, 'f' + i, 'v' + a);
    }
  });
  return F.toPoly();
}
function amboRaw(poly) {
  const F = new Flag();
  poly.faces.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) {
      const v1 = f[(k - 1 + f.length) % f.length], v2 = f[k], v3 = f[(k + 1) % f.length];
      F.v(mid(v1, v2), V.lerp(poly.verts[v1], poly.verts[v2], 0.5));
      F.v(mid(v2, v3), V.lerp(poly.verts[v2], poly.verts[v3], 0.5));
      F.f('o' + i, mid(v1, v2), mid(v2, v3));
      F.f('d' + v2, mid(v2, v3), mid(v1, v2));
    }
  });
  return F.toPoly();
}
function gyroRaw(poly) {
  const F = new Flag();
  poly.verts.forEach((p, i) => F.v('v' + i, V.norm(p)));
  const e = (a, b) => `e${a}_${b}`;
  poly.faces.forEach((f, i) => {
    F.v('c' + i, V.norm(fc(poly, f)));
    for (let k = 0; k < f.length; k++) {
      const v1 = f[(k - 1 + f.length) % f.length], v2 = f[k], v3 = f[(k + 1) % f.length];
      const P = poly.verts;
      F.v(e(v1, v2), V.lerp(P[v1], P[v2], 1 / 3)); F.v(e(v2, v1), V.lerp(P[v2], P[v1], 1 / 3));
      F.v(e(v2, v3), V.lerp(P[v2], P[v3], 1 / 3));
      const fn = `p${i}_${v1}`;
      F.f(fn, 'c' + i, e(v1, v2)); F.f(fn, e(v1, v2), e(v2, v1)); F.f(fn, e(v2, v1), 'v' + v2);
      F.f(fn, 'v' + v2, e(v2, v3)); F.f(fn, e(v2, v3), 'c' + i);
    }
  });
  return F.toPoly();
}
function chamferRaw(poly) {
  const F = new Flag();
  poly.verts.forEach((p, i) => F.v('v' + i, V.scale(p, 1.05)));
  poly.faces.forEach((f, i) => {
    const c = fc(poly, f);
    const iv = (v) => `i${i}_${v}`;
    for (const v of f) F.v(iv(v), V.lerp(poly.verts[v], c, 0.3));
    for (let k = 0; k < f.length; k++) {
      const v1 = f[k], v2 = f[(k + 1) % f.length];
      const hex = v1 < v2 ? `h${v1}_${v2}` : `h${v2}_${v1}`;
      F.f('I' + i, iv(v1), iv(v2));
      F.f(hex, iv(v2), iv(v1)); F.f(hex, iv(v1), 'v' + v1); F.f(hex, 'v' + v2, iv(v2));
    }
  });
  return F.toPoly();
}

const dual = (p) => canonicalize(reciprocal(p));
const kis = (p) => canonicalize(kisRaw(p));
const ambo = (p) => canonicalize(amboRaw(p));
const gyro = (p) => canonicalize(gyroRaw(p));
const chamfer = (p) => canonicalize(chamferRaw(p));

export const OPS = {
  d: { name: 'dual', fn: dual },
  a: { name: 'ambo', fn: ambo },
  k: { name: 'kis', fn: kis },
  t: { name: 'truncate', fn: (p) => dual(kis(dual(p))) },
  j: { name: 'join', fn: (p) => dual(ambo(p)) },
  e: { name: 'expand', fn: (p) => ambo(ambo(p)) },
  b: { name: 'bevel', fn: (p) => dual(kis(dual(ambo(p)))) },
  o: { name: 'ortho', fn: (p) => dual(ambo(dual(ambo(p)))) },
  m: { name: 'meta', fn: (p) => kis(dual(ambo(p))) },
  g: { name: 'gyro', fn: gyro },
  s: { name: 'snub', fn: (p) => dual(gyro(dual(p))) },
  c: { name: 'chamfer', fn: chamfer },
};

const notationCache = new Map();
/** Parse Conway notation like "tI", "dkD", "P6", "sC". Operators apply right to left. */
export function fromNotation(str) {
  const s = str.replace(/\s+/g, '');
  if (notationCache.has(s)) return notationCache.get(s);
  const m = s.match(/^([a-z]*)(@\w+|[TCODIPAY])(\d*)$/);
  if (!m) throw new Error(`Can't parse "${str}". Use ops [${Object.keys(OPS).join('')}] then a seed T C O D I P<n> A<n> Y<n> or @${Object.keys(MONOHEDRA).join(' @')}`);
  const [, ops, sd, num] = m;
  let p;
  if (sd[0] === '@') {
    // named exact solid (e.g. a monohedron): keep its geometry as-is unless operators are applied
    const named = MONOHEDRA[sd.slice(1)];
    if (!named) throw new Error(`Unknown named solid ${sd} (have: @${Object.keys(MONOHEDRA).join(', @')})`);
    p = orientFaces({ verts: named.verts.map((v) => v.slice()), faces: named.faces.map((f) => f.slice()) });
  } else {
    let n = num ? parseInt(num, 10) : 5;
    if ('PAY'.includes(sd)) n = Math.max(3, Math.min(30, n));
    p = seed(sd, n);
  }
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = OPS[ops[i]];
    if (!op) throw new Error('Unknown operator ' + ops[i]);
    p = op.fn(p);
    if (p.faces.length > 4000) throw new Error('Too many faces');
  }
  const out = { verts: p.verts, faces: p.faces };
  notationCache.set(s, out);
  return out;
}

// ---------------------------------------------------------------- geometric modifications
/** Class-I geodesic subdivision of frequency n; non-triangular faces are fanned first. */
export function geodesic(poly, n) {
  const verts = poly.verts.map((v) => V.norm(v));
  const tris = [];
  for (const f of poly.faces) {
    if (f.length === 3) { tris.push(f); continue; }
    const c = verts.length;
    verts.push(V.norm(V.centroid(f.map((i) => verts[i]))));
    for (let k = 0; k < f.length; k++) tris.push([f[k], f[(k + 1) % f.length], c]);
  }
  if (n <= 1) return orientFaces({ verts, faces: tris });
  const idx = new Map();
  const out = verts.slice();
  const pid = (ids, ws) => {
    const parts = [];
    for (let k = 0; k < 3; k++) if (ws[k]) parts.push([ids[k], ws[k]]);
    if (parts.length === 1) return parts[0][0];
    parts.sort((a, b) => a[0] - b[0]);
    const key = parts.map((p) => p[0] + ':' + p[1]).join('|');
    if (!idx.has(key)) {
      let p = [0, 0, 0];
      for (const [vi, w] of parts) p = V.add(p, V.scale(verts[vi], w));
      idx.set(key, out.length);
      out.push(V.norm(p));
    }
    return idx.get(key);
  };
  const faces = [];
  for (const t of tris) {
    const P = (i, j) => pid(t, [n - i - j, i, j]);
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      faces.push([P(i, j), P(i + 1, j), P(i, j + 1)]);
      if (i + j < n - 1) faces.push([P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)]);
    }
  }
  return orientFaces({ verts: out, faces });
}

export function stretch(poly, s) {
  return { verts: poly.verts.map((v) => [v[0] * s[0], v[1] * s[1], v[2] * s[2]]), faces: poly.faces };
}

/**
 * Cut the polyhedron with extra planes: at each vertex (depth tv in [0,1], 1 = through edge
 * midpoints) and along each edge (depth te in [0,1], 1 = through face centroids).
 */
export function halfspaceModify(poly, tv, te) {
  if (tv < 1e-4 && te < 1e-4) return poly;
  const planes = poly.faces.map((f) => facePlane(poly, f));
  const P = poly.verts;
  const edges = edgeList(poly);
  if (tv >= 1e-4) {
    const nbrs = P.map(() => []);
    for (const [a, b] of edges) { nbrs[a].push(b); nbrs[b].push(a); }
    P.forEach((v, i) => {
      const vh = V.norm(v), dv = V.len(v);
      let dm = -Infinity;
      for (const w of nbrs[i]) dm = Math.max(dm, V.dot(V.lerp(v, P[w], 0.5), vh));
      planes.push({ n: vh, d: dv - tv * (dv - dm) });
    });
  }
  if (te >= 1e-4) {
    const em = dirEdgeMap(poly);
    for (const [a, b] of edges) {
      const mh = V.norm(V.lerp(P[a], P[b], 0.5));
      const dm = Math.max(V.dot(P[a], mh), V.dot(P[b], mh));
      let df = -Infinity;
      for (const key of [a + '>' + b, b + '>' + a]) {
        const fi = em.get(key);
        if (fi !== undefined) df = Math.max(df, V.dot(fc(poly, poly.faces[fi]), mh));
      }
      planes.push({ n: mh, d: dm - te * (dm - df) });
    }
  }
  const dualPts = planes.map((p) => V.scale(p.n, 1 / p.d));
  return reciprocal(convexHull(dualPts, 1e-7));
}

/** Split all faces flat: 'fan' (center fan) or 'mid' (corner triangles + inner midpoint polygon). */
export function flatSplitAll(poly, type) {
  if (type !== 'fan' && type !== 'mid') return poly;
  const verts = poly.verts.slice();
  const faces = [];
  if (type === 'fan') {
    for (const f of poly.faces) {
      const c = verts.length;
      verts.push(V.centroid(f.map((i) => verts[i])));
      for (let k = 0; k < f.length; k++) faces.push([f[k], f[(k + 1) % f.length], c]);
    }
  } else {
    const mids = new Map();
    const M = (a, b) => {
      const key = a < b ? a + '_' + b : b + '_' + a;
      if (!mids.has(key)) { mids.set(key, verts.length); verts.push(V.lerp(verts[a], verts[b], 0.5)); }
      return mids.get(key);
    };
    for (const f of poly.faces) {
      const n = f.length, inner = [];
      for (let k = 0; k < n; k++) {
        const prev = f[(k - 1 + n) % n], v = f[k], next = f[(k + 1) % n];
        faces.push([v, M(v, next), M(prev, v)]);
        inner.push(M(v, next));
      }
      faces.push(inner);
    }
  }
  return { verts, faces };
}

export const faceKey = (f) => [...f].sort((a, b) => a - b).join(',');

/** Split a single face flat. 'mid' inserts edge midpoints into neighbours too (collinear vertices). */
export function splitFace(poly, key, type) {
  const fi = poly.faces.findIndex((f) => faceKey(f) === key);
  if (fi < 0) return null;
  const verts = poly.verts.slice();
  const f = poly.faces[fi];
  const rest = poly.faces.filter((_, i) => i !== fi).map((g) => g.slice());
  const n = f.length;
  const added = [];
  if (type === 'fan') {
    const c = verts.length;
    verts.push(V.centroid(f.map((i) => verts[i])));
    for (let k = 0; k < n; k++) added.push([f[k], f[(k + 1) % n], c]);
  } else {
    const mids = [];
    for (let k = 0; k < n; k++) {
      const a = f[k], b = f[(k + 1) % n];
      const m = verts.length;
      verts.push(V.lerp(verts[a], verts[b], 0.5));
      mids.push(m);
      // insert m between b and a in the neighbour that has edge b->a
      for (const g of rest) {
        const L = g.length;
        for (let j = 0; j < L; j++) if (g[j] === b && g[(j + 1) % L] === a) { g.splice(j + 1, 0, m); break; }
      }
    }
    for (let k = 0; k < n; k++) added.push([f[k], mids[k], mids[(k - 1 + n) % n]]);
    added.push(mids.slice());
  }
  return { verts, faces: [...rest, ...added] };
}

// ---------------------------------------------------------------- full pipeline
/** User polyhedron: vertices (+ optional faces). Without faces, the convex hull is used. */
export function customPoly(c) {
  if (!c || !Array.isArray(c.verts) || c.verts.length < 4) throw new Error('Custom polyhedron needs at least 4 vertices');
  let verts = c.verts.map((v) => [+v[0], +v[1], +v[2]]);
  // centre on the vertex centroid so the origin is inside
  const cen = V.centroid(verts);
  verts = verts.map((v) => V.sub(v, cen));
  if (Array.isArray(c.faces) && c.faces.length >= 4) return orientFaces({ verts, faces: c.faces.map((f) => f.map(Number)) });
  return orientFaces(convexHull(verts));
}

/**
 * cfg: { notation, geodesic, stretch:[sx,sy,sz], truncV, chamferE, flatSplit, faceSplits:[{key,type}] }
 * Returns { poly, splitErrors }
 */
export function buildPoly(cfg) {
  let p = cfg.custom ? customPoly(cfg.custom) : fromNotation(cfg.notation || 'I');
  if ((cfg.geodesic || 1) > 1) p = geodesic(p, cfg.geodesic);
  const s = cfg.stretch || [1, 1, 1];
  if (s.some((x) => Math.abs(x - 1) > 1e-9)) p = stretch(p, s);
  p = halfspaceModify(p, cfg.truncV || 0, cfg.chamferE || 0);
  p = flatSplitAll(p, cfg.flatSplit);
  let applied = 0;
  for (const sp of cfg.faceSplits || []) {
    const q = splitFace(p, sp.key, sp.type);
    if (!q) break;
    p = q; applied++;
  }
  return { poly: p, appliedSplits: applied };
}
