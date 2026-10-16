// Small 3-vector / quaternion / 3x3 matrix toolkit. Vectors are plain [x,y,z].
// Earth convention: x -> (lon 0, lat 0), y -> (lon 90E, lat 0), z -> north pole.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const neg = (a) => [-a[0], -a[1], -a[2]];
export function norm(a) {
  const l = len(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Angle between unit (or arbitrary) vectors, numerically stable. */
export const angle = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b));

export function centroid(pts) {
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return scale(c, 1 / pts.length);
}

/** Spherical interpolation between unit vectors. */
export function slerp(a, b, t) {
  const th = angle(a, b);
  if (th < 1e-9) return norm(lerp(a, b, t));
  const s = Math.sin(th);
  const k1 = Math.sin((1 - t) * th) / s, k2 = Math.sin(t * th) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
}

/** Area of the spherical triangle abc (unit vectors), unsigned. */
export function sphTriArea(a, b, c) {
  const num = Math.abs(dot(a, cross(b, c)));
  const den = 1 + dot(a, b) + dot(b, c) + dot(c, a);
  return 2 * Math.atan2(num, den);
}

const D2R = Math.PI / 180;
export function lonLatToVec(lon, lat) {
  const l = lon * D2R, p = lat * D2R, c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
}
export function vecToLonLat(v) {
  const n = norm(v);
  return [Math.atan2(n[1], n[0]) / D2R, Math.asin(Math.max(-1, Math.min(1, n[2]))) / D2R];
}

// ---------- quaternions [w, x, y, z] ----------
export function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];
export function qnormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qFromAxisAngle(axis, ang) {
  const a = norm(axis), s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), a[0] * s, a[1] * s, a[2] * s];
}
/** Shortest rotation taking unit vector a to unit vector b. */
export function qFromTwoVecs(a, b) {
  const d = dot(a, b);
  if (d < -0.999999) {
    let ax = cross([1, 0, 0], a);
    if (len(ax) < 1e-6) ax = cross([0, 1, 0], a);
    return qFromAxisAngle(ax, Math.PI);
  }
  const c = cross(a, b);
  return qnormalize([1 + d, c[0], c[1], c[2]]);
}
/** Row-major 3x3 rotation matrix. */
export function qToMat(q) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
export function qFromMat(m) {
  const tr = m[0] + m[4] + m[8];
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s];
  }
  return qnormalize(q);
}
export const mulMV = (m, v) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
/** Multiply by the transpose (= inverse for rotations). */
export const mulMtV = (m, v) => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** Rotation matrix whose rows are an orthonormal frame built from (p, q): p first, q's perpendicular part second. */
export function frameRows(p, q) {
  const a = norm(p);
  const b = norm(sub(q, scale(a, dot(q, a))));
  const c = cross(a, b);
  return [...a, ...b, ...c];
}
/** Quaternion rotating direction pair (p1,q1) onto (p2,q2). */
export function qAlign(p1, q1, p2, q2) {
  const A = frameRows(p1, q1), B = frameRows(p2, q2);
  // R = B^T A  (maps p1 -> p2)
  const R = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let k = 0; k < 3; k++) s += B[k * 3 + i] * A[k * 3 + j];
    R[i * 3 + j] = s;
  }
  return qFromMat(R);
}

/** Uniform random rotation (Shoemake). */
export function qRandom(rnd = Math.random) {
  const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}
