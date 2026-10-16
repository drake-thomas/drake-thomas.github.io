// Distortion statistics of a polyhedral projection, from the Jacobian of the sphere -> net map
// evaluated at quasi-uniform sample points (Fibonacci sphere). Singular values a >= b of the
// Jacobian are normalized by the global scale sqrt(planar area / 4π), so a = b = 1 is distortion-free.
//
//   areaRms   RMS of ln(a·b)                         (0 for equal-area maps)
//   areaRatio 99th / 1st percentile of a·b          (largest vs smallest areal scale)
//   angMean   mean max angular deformation ω, degrees, ω = 2·asin((a-b)/(a+b))
//   ang95     95th percentile of ω
//   airy      Airy–Kavrayskiy: sqrt(mean((ln a)² + (ln b)²) / 2)
//   land*     the same, restricted to points on land (depends on orientation)
import * as V from './vec.js';
import { locate, forwardInFace } from './geometry.js';

function fibonacciSphere(n) {
  const pts = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - z * z), t = ga * i;
    pts.push([r * Math.cos(t), r * Math.sin(t), z]);
  }
  return pts;
}

function svd2(j00, j01, j10, j11) {
  // singular values of [[j00, j01], [j10, j11]]
  const E = (j00 + j11) / 2, F = (j00 - j11) / 2, G = (j10 + j01) / 2, H = (j10 - j01) / 2;
  const Q = Math.hypot(E, H), R = Math.hypot(F, G);
  return [Q + R, Math.abs(Q - R)];
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * @param G      geometry from buildGeometry
 * @param mode   'gnomonic' | 'fuller' | 'equal'
 * @param opts   { n = 20000, R (poly->earth matrix), isLand(E) -> 0/1 }
 */
export function distortionStats(G, mode, { n = 20000, R = null, isLand = null } = {}) {
  let planeArea = 0;
  for (const fd of G.faces) planeArea += Math.abs(fd.area);
  const s = Math.sqrt(planeArea / (4 * Math.PI));
  const h = 1e-5;
  const pts = fibonacciSphere(n);
  const acc = () => ({ la: [], om: [], airy: 0, n: 0 });
  const all = acc(), land = acc();
  let hint = 0;
  for (const P of pts) {
    const f = locate(G, P, hint);
    hint = f;
    const t1 = V.norm(Math.abs(P[2]) < 0.9 ? V.cross([0, 0, 1], P) : V.cross([1, 0, 0], P));
    const t2 = V.cross(P, t1);
    const fw = (d, k) => forwardInFace(G, f, V.norm(V.add(P, V.scale(d, k))), mode);
    const xp = fw(t1, h), xm = fw(t1, -h), yp = fw(t2, h), ym = fw(t2, -h);
    const j00 = (xp[0] - xm[0]) / (2 * h), j10 = (xp[1] - xm[1]) / (2 * h);
    const j01 = (yp[0] - ym[0]) / (2 * h), j11 = (yp[1] - ym[1]) / (2 * h);
    let [a, b] = svd2(j00, j01, j10, j11);
    a /= s; b /= s;
    if (!(b > 1e-9)) continue;
    const la = Math.log(a * b), om = 2 * Math.asin((a - b) / (a + b));
    const ai = (Math.log(a) ** 2 + Math.log(b) ** 2) / 2;
    const targets = [all];
    if (R && isLand && isLand(V.mulMV(R, P))) targets.push(land);
    for (const t of targets) { t.la.push(la); t.om.push(om); t.airy += ai; t.n++; }
  }
  const summarize = (t) => {
    if (!t.n) return null;
    const la = Float64Array.from(t.la).sort(), om = Float64Array.from(t.om).sort();
    let sl = 0, so = 0;
    for (let i = 0; i < t.n; i++) { sl += la[i] * la[i]; so += om[i]; }
    const deg = 180 / Math.PI;
    return {
      areaRms: Math.sqrt(sl / t.n),
      areaRatio: Math.exp(quantile(la, 0.99) - quantile(la, 0.01)),
      angMean: (so / t.n) * deg,
      ang95: quantile(om, 0.95) * deg,
      airy: Math.sqrt(t.airy / t.n),
    };
  };
  const out = summarize(all);
  const L = summarize(land);
  if (L) for (const [k, v] of Object.entries(L)) out['land' + k[0].toUpperCase() + k.slice(1)] = v;
  return out;
}
