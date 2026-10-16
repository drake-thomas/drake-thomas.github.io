// Derived geometry for a polyhedral projection: face frames, face lookup on the sphere,
// and per-face forward/inverse maps between the sphere and the flat face.
//
// Every face is fanned from its centroid into triangles (A = centre, B, C = consecutive vertices).
// Three in-face mappings are offered:
//   gnomonic : central projection onto the face plane (exact polyhedral projection)
//   fuller   : "arc-linear" - edges are spaced linearly by arc length, and radially from the
//              centre by arc length. Continuous across every edge for any polyhedron.
//   equal    : slice-and-dice equal-area (van Leeuwen & Strebe style): exactly equal-area within
//              each fan triangle; seamless across edges whose two faces mirror each other
//              (all Platonic and edge-transitive solids), small seams otherwise.
import * as V from './vec.js';
import { newellNormal, faceKey } from './polyhedra.js';

const LUT_N = 96;

export function buildGeometry(poly) {
  const { verts, faces } = poly;
  const vdir = verts.map(V.norm);
  const F = faces.length;
  const fdata = faces.map((f, fi) => {
    const pts = f.map((i) => verts[i]);
    const n = newellNormal(pts);
    const c = V.centroid(pts);
    const d = V.dot(n, c);
    const helper = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const u = V.norm(V.cross(helper, n));
    const w = V.cross(n, u);
    const loc = pts.map((p) => [V.dot(p, u), V.dot(p, w)]);
    const cl = [V.dot(c, u), V.dot(c, w)];
    const A = V.norm(c);
    const tris = f.map((_, k) => {
      const k2 = (k + 1) % f.length;
      const B = vdir[f[k]], C = vdir[f[k2]];
      const thBC = V.angle(B, C);
      return {
        A, B, C,
        nBC: V.norm(V.cross(B, C)),
        thBC, sinBC: Math.sin(thBC),
        area: V.sphTriArea(A, B, C),
        a2: cl, b2: loc[k], c2: loc[k2],
        lut: null,
      };
    });
    let area2 = 0;
    for (let k = 0; k < loc.length; k++) {
      const p = loc[k], q = loc[(k + 1) % loc.length];
      area2 += p[0] * q[1] - q[0] * p[1];
    }
    let rad = 0;
    for (const p of loc) rad = Math.max(rad, Math.hypot(p[0] - cl[0], p[1] - cl[1]));
    return { verts: f, n, d, c, u, w, loc, cl, A, tris, key: faceKey(f), area: area2 / 2, rad };
  });

  const edges = [];
  const edgeByKey = new Map();
  const faceEdge = faces.map((f) => new Array(f.length).fill(-1));
  const faceNbr = faces.map((f) => new Array(f.length).fill(-1));
  faces.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      const key = a < b ? a + '_' + b : b + '_' + a;
      let id = edgeByKey.get(key);
      if (id === undefined) {
        id = edges.length;
        edgeByKey.set(key, id);
        edges.push({ id, key, a: Math.min(a, b), b: Math.max(a, b), faces: [fi], sides: [k] });
      } else {
        edges[id].faces.push(fi);
        edges[id].sides.push(k);
      }
      faceEdge[fi][k] = id;
    }
  });
  for (const e of edges) {
    if (e.faces.length !== 2) throw new Error(`Edge ${e.key} has ${e.faces.length} faces (not a closed surface)`);
    const [f, g] = e.faces;
    faceNbr[f][e.sides[0]] = g;
    faceNbr[g][e.sides[1]] = f;
    const A = vdir[e.a], B = vdir[e.b];
    e.len = V.angle(A, B);
    e.normal = V.norm(V.cross(A, B));
    const ns = Math.max(4, Math.ceil(e.len / 0.006)); // ~38 km sample spacing
    e.samples = [];
    for (let i = 0; i <= ns; i++) e.samples.push(V.slerp(A, B, i / ns));
  }
  const faceByKey = new Map(fdata.map((fd, i) => [fd.key, i]));
  let meanRad = 0;
  for (const fd of fdata) meanRad += fd.rad;
  meanRad /= F;
  return { poly, verts, vdir, faces: fdata, F, edges, edgeByKey, faceEdge, faceNbr, faceByKey, meanRad };
}

/** Edge id shared by faces f and g, or -1. */
export function sharedEdge(G, f, g) {
  const nb = G.faceNbr[f];
  for (let k = 0; k < nb.length; k++) if (nb[k] === g) return G.faceEdge[f][k];
  return -1;
}

// ---------------------------------------------------------------- face lookup
function inFace(fd, P, eps) {
  const np = V.dot(fd.n, P);
  if (np <= 0) return { ok: false, side: -1 };
  const s = fd.d / np;
  const qx = (P[0] * fd.u[0] + P[1] * fd.u[1] + P[2] * fd.u[2]) * s;
  const qy = (P[0] * fd.w[0] + P[1] * fd.w[1] + P[2] * fd.w[2]) * s;
  const L = fd.loc, n = L.length;
  let worst = -1, worstVal = -eps;
  for (let k = 0; k < n; k++) {
    const a = L[k], b = L[(k + 1) % n];
    const cr = (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0]);
    const v = cr / Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (v < worstVal) { worstVal = v; worst = k; }
  }
  return { ok: worst < 0, side: worst, qx, qy };
}

/** Face containing unit vector P (polyhedron frame). `hint` = a nearby face to start walking from. */
export function locate(G, P, hint = 0) {
  const eps = 1e-9 * G.meanRad;
  let f = hint >= 0 && hint < G.F ? hint : 0;
  for (let step = 0; step < 64; step++) {
    const r = inFace(G.faces[f], P, eps);
    if (r.ok) return f;
    if (r.side < 0) break;
    f = G.faceNbr[f][r.side];
  }
  // brute force: best central-projection score, verified by containment
  const cand = [];
  for (let i = 0; i < G.F; i++) {
    const fd = G.faces[i];
    cand.push([V.dot(fd.n, P) / fd.d, i]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  for (let j = 0; j < Math.min(8, cand.length); j++) {
    if (inFace(G.faces[cand[j][1]], P, 1e-7 * G.meanRad).ok) return cand[j][1];
  }
  return cand[0][1];
}

/** Which fan triangle of face fd contains P (using gnomonic coordinates). */
function wedge(fd, P) {
  const s = fd.d / V.dot(fd.n, P);
  const qx = V.dot(P, fd.u) * s - fd.cl[0], qy = V.dot(P, fd.w) * s - fd.cl[1];
  const L = fd.loc, n = L.length;
  let best = 0, bestVal = -Infinity;
  for (let k = 0; k < n; k++) {
    const b = L[k], c = L[(k + 1) % n];
    const bx = b[0] - fd.cl[0], by = b[1] - fd.cl[1], cx = c[0] - fd.cl[0], cy = c[1] - fd.cl[1];
    const c1 = bx * qy - by * qx;   // >= 0 when q is left of centre->B
    const c2 = cx * qy - cy * qx;   // <= 0 when q is right of centre->C
    const v = Math.min(c1, -c2);
    if (v >= 0) return k;
    if (v > bestVal) { bestVal = v; best = k; }
  }
  return best;
}

// ---------------------------------------------------------------- per-triangle maps
function ensureLut(T) {
  if (T.lut) return T.lut;
  const lut = new Float64Array(LUT_N + 1);
  for (let j = 0; j <= LUT_N; j++) {
    const D = V.slerp(T.B, T.C, j / LUT_N);
    lut[j] = j === 0 ? 0 : V.sphTriArea(T.A, T.B, D) / T.area;
  }
  lut[LUT_N] = 1;
  T.lut = lut;
  return lut;
}
/** Inverse of the LUT: area fraction -> arc fraction along BC. */
function lutInv(lut, t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  let lo = 0, hi = LUT_N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (lut[m] < t) lo = m; else hi = m; }
  const f = (t - lut[lo]) / (lut[hi] - lut[lo] || 1);
  return (lo + f) / LUT_N;
}

function triForward(T, P, mode) {
  const { A, B, C, a2, b2, c2 } = T;
  const nAP = V.cross(A, P);
  if (V.len(nAP) < 1e-12) return [a2[0], a2[1]];
  let D = V.norm(V.cross(nAP, T.nBC));
  if (V.dot(D, V.add(B, C)) < 0) D = V.neg(D);
  let t, s;
  if (mode === 'fuller') {
    t = V.angle(B, D) / T.thBC;
    s = V.angle(A, P) / V.angle(A, D);
  } else {
    t = V.sphTriArea(A, B, D) / T.area;
    s = Math.sqrt(V.dist2(A, P) / V.dist2(A, D));
  }
  const dx = b2[0] + t * (c2[0] - b2[0]), dy = b2[1] + t * (c2[1] - b2[1]);
  return [a2[0] + s * (dx - a2[0]), a2[1] + s * (dy - a2[1])];
}

/** Sphere point -> local 2D coordinates of face fi. */
export function forwardInFace(G, fi, P, mode) {
  const fd = G.faces[fi];
  if (mode === 'gnomonic') {
    const s = fd.d / V.dot(fd.n, P);
    return [V.dot(P, fd.u) * s, V.dot(P, fd.w) * s];
  }
  return triForward(fd.tris[wedge(fd, P)], P, mode);
}

/**
 * Inverse map for a fan triangle given barycentric weights (wa, wb, wc) of (centre, B, C).
 * Writes the unit vector into out[0..2]. Hot path for rasterization - avoids allocation.
 */
export function triInverseInto(fd, T, wa, wb, wc, mode, out) {
  if (mode === 'gnomonic') {
    const x = wa * T.a2[0] + wb * T.b2[0] + wc * T.c2[0];
    const y = wa * T.a2[1] + wb * T.b2[1] + wc * T.c2[1];
    const n = fd.n, u = fd.u, w = fd.w, d = fd.d;
    const qx = n[0] * d + u[0] * x + w[0] * y;
    const qy = n[1] * d + u[1] * x + w[1] * y;
    const qz = n[2] * d + u[2] * x + w[2] * y;
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
    out[0] = qx / l; out[1] = qy / l; out[2] = qz / l;
    return;
  }
  const A = T.A;
  const s = wb + wc;
  if (s < 1e-12) { out[0] = A[0]; out[1] = A[1]; out[2] = A[2]; return; }
  let t = wc / s;
  if (mode === 'equal') t = lutInv(ensureLut(T), t);
  // D = slerp(B, C, t)
  const B = T.B, C = T.C, th = T.thBC;
  const k1 = Math.sin((1 - t) * th) / T.sinBC, k2 = Math.sin(t * th) / T.sinBC;
  const Dx = B[0] * k1 + C[0] * k2, Dy = B[1] * k1 + C[1] * k2, Dz = B[2] * k1 + C[2] * k2;
  const cosAD = A[0] * Dx + A[1] * Dy + A[2] * Dz;
  let tx = Dx - cosAD * A[0], ty = Dy - cosAD * A[1], tz = Dz - cosAD * A[2];
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (tl < 1e-15) { out[0] = A[0]; out[1] = A[1]; out[2] = A[2]; return; }
  tx /= tl; ty /= tl; tz /= tl;
  let alpha;
  if (mode === 'fuller') {
    alpha = s * Math.atan2(tl, cosAD);
  } else {
    // 1 - cos(alpha) = s^2 (1 - cos AD);  half-chord form for precision
    const chord2AD = (A[0] - Dx) ** 2 + (A[1] - Dy) ** 2 + (A[2] - Dz) ** 2; // = 2(1-cosAD)
    alpha = 2 * Math.asin(Math.min(1, s * Math.sqrt(chord2AD) / 2));
  }
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  out[0] = A[0] * ca + tx * sa; out[1] = A[1] * ca + ty * sa; out[2] = A[2] * ca + tz * sa;
}

/** Local 2D point inside face fi -> unit vector (allocating convenience version). */
export function inverseInFace(G, fi, x, y, mode) {
  const fd = G.faces[fi];
  const n = fd.loc.length;
  for (let k = 0; k < n; k++) {
    const T = fd.tris[k];
    const bc = bary(T.a2, T.b2, T.c2, x, y);
    if (bc[0] >= -1e-9 && bc[1] >= -1e-9 && bc[2] >= -1e-9 || k === n - 1) {
      const out = [0, 0, 0];
      triInverseInto(fd, T, bc[0], bc[1], bc[2], mode, out);
      return out;
    }
  }
  return null;
}

export function bary(a, b, c, x, y) {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
  const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
  return [l1, l2, 1 - l1 - l2];
}

/** Full forward projection: sphere point (polyhedron frame) -> { f, x, y } local coordinates. */
export function project(G, P, mode, hint) {
  const f = locate(G, P, hint);
  const [x, y] = forwardInFace(G, f, P, mode);
  return { f, x, y };
}

/** Point where the great-circle arc p1->p2 crosses the great circle of edge e. */
export function arcEdgeCrossing(G, eid, p1, p2) {
  const e = G.edges[eid];
  let X = V.norm(V.cross(V.cross(p1, p2), e.normal));
  if (V.dot(X, V.add(p1, p2)) < 0) X = V.neg(X);
  return X;
}

/** Angular distance from unit vector P to edge arc e. */
export function edgeDistance(G, eid, P) {
  const e = G.edges[eid];
  const A = G.vdir[e.a], B = G.vdir[e.b];
  const n = e.normal;
  // projection lies within the arc iff P is on the inner side of both end planes
  const inA = V.dot(V.cross(n, A), P) >= 0 ? true : false; // A side: towards B
  const inB = V.dot(V.cross(B, n), P) >= 0 ? true : false;
  if (inA && inB) return Math.abs(Math.asin(Math.max(-1, Math.min(1, V.dot(P, n)))));
  return Math.min(V.angle(P, A), V.angle(P, B));
}
