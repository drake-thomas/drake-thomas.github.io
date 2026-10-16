// Orientation optimizer core (shared by the browser Web Worker and the Node batch study).
//
// Minimizes the land crossed by cut edges over rotations of the polyhedron.
//  * fixed mode: the cut set is given (the user's net); cost = sum of cost along cut edges.
//  * free mode:  for each rotation the optimal net is found exactly — cost is additive per edge,
//                so the best cut set is the complement of a maximum spanning tree of the dual
//                graph weighted by per-edge cost. The search is then only over SO(3).
// Search: random screening -> simulated annealing from several diverse seeds -> greedy polish.
// Cost density per sample: 1 on land, and optionally w*exp(-d/d0) on ocean within d0 of a coast
// ("coast clearance"), which also gives the annealer a gradient once land crossings reach zero.

const R_KM = 6371;
let cached = { key: '', field: null, dist: null };
let rnd = Math.random;

/** Deterministic PRNG (mulberry32) for reproducible batch runs. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- quaternions
function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qnorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
function qAxisAngle(ax, ang) {
  const l = Math.hypot(ax[0], ax[1], ax[2]) || 1, s = Math.sin(ang / 2);
  return [Math.cos(ang / 2), (ax[0] / l) * s, (ax[1] / l) * s, (ax[2] / l) * s];
}
function qRandom() {
  const u1 = rnd(), u2 = rnd() * 2 * Math.PI, u3 = rnd() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}
function qAngle(a, b) { return 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))); }
function qToMat(q) {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// ---------------------------------------------------------------- cost field
/** Approximate geodesic distance (km) from every ocean pixel to land: 8-neighbour chamfer passes. */
function distanceField(mask, W, H) {
  const d = new Float32Array(W * H);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : INF;
  const px = (2 * Math.PI * R_KM) / W, py = (Math.PI * R_KM) / H;
  const hx = new Float32Array(H), dg = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) * Math.PI) / H;
    hx[y] = Math.max(0.5, px * Math.cos(lat));
    dg[y] = Math.hypot(hx[y], py);
  }
  for (let rep = 0; rep < 2; rep++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let v = d[i];
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        v = Math.min(v, d[y * W + xl] + hx[y]);
        if (y > 0) {
          const r = (y - 1) * W;
          v = Math.min(v, d[r + x] + py, d[r + xl] + dg[y], d[r + xr] + dg[y]);
        }
        d[i] = v;
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        let v = d[i];
        const xl = x === 0 ? W - 1 : x - 1, xr = x === W - 1 ? 0 : x + 1;
        v = Math.min(v, d[y * W + xr] + hx[y]);
        if (y < H - 1) {
          const r = (y + 1) * W;
          v = Math.min(v, d[r + x] + py, d[r + xl] + dg[y], d[r + xr] + dg[y]);
        }
        d[i] = v;
      }
    }
  }
  return d;
}

function costField(mask, W, H, clearanceKm, clearanceWeight) {
  const key = `${W}x${H}:${clearanceKm}:${clearanceWeight}`;
  if (cached.key === key) return cached.field;
  const f = new Float32Array(W * H);
  if (clearanceKm > 0 && clearanceWeight > 0) {
    if (!cached.dist || cached.dist.length !== W * H) cached.dist = distanceField(mask, W, H);
    const d = cached.dist;
    for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 1 : clearanceWeight * Math.exp(-d[i] / clearanceKm);
  } else {
    for (let i = 0; i < f.length; i++) f[i] = mask[i] ? 1 : 0;
  }
  cached = { key, field: f, dist: cached.dist };
  return f;
}

// ---------------------------------------------------------------- objective
function makeObjective(g, W, H) {
  const { samples, edgeStart, edgeLen, edgeFaces, F, fixedCut } = g;
  const E = edgeLen.length;
  const w = new Float64Array(E);
  const order = new Int32Array(E);
  const parent = new Int32Array(F);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  function edgeWeights(q, field, stride) {
    const m = qToMat(q);
    for (let e = 0; e < E; e++) {
      let s = 0, c = 0;
      const end = edgeStart[e + 1];
      for (let i = edgeStart[e]; i < end; i += stride) {
        const o = 3 * i, x = samples[o], y = samples[o + 1], z = samples[o + 2];
        const ex = m[0] * x + m[1] * y + m[2] * z;
        const ey = m[3] * x + m[4] * y + m[5] * z;
        const ez = m[6] * x + m[7] * y + m[8] * z;
        const lon = Math.atan2(ey, ex), lat = Math.asin(ez > 1 ? 1 : ez < -1 ? -1 : ez);
        let px = ((lon + Math.PI) / (2 * Math.PI) * W) | 0, py = ((Math.PI / 2 - lat) / Math.PI * H) | 0;
        if (px >= W) px = W - 1; if (py >= H) py = H - 1; if (px < 0) px = 0; if (py < 0) py = 0;
        s += field[py * W + px]; c++;
      }
      w[e] = (s / c) * edgeLen[e];
    }
    return w;
  }
  function cost(q, field, stride) {
    edgeWeights(q, field, stride);
    if (fixedCut) {
      let s = 0;
      for (let e = 0; e < E; e++) if (fixedCut[e]) s += w[e];
      return s;
    }
    let total = 0;
    for (let e = 0; e < E; e++) { total += w[e]; order[e] = e; }
    order.sort((a, b) => w[b] - w[a]);
    for (let f = 0; f < F; f++) parent[f] = f;
    let tree = 0;
    for (let k = 0; k < E; k++) {
      const e = order[k];
      const a = find(edgeFaces[2 * e]), b = find(edgeFaces[2 * e + 1]);
      if (a !== b) { parent[a] = b; tree += w[e]; }
    }
    return total - tree;
  }
  return { cost };
}

// ---------------------------------------------------------------- search
/**
 * Search rotations minimizing land under cuts. `emit` receives progress / done messages.
 * Returns { best, bestCost (objective, km), landKm, startLand }.
 */
export function searchOrientation(msg, emit = () => {}, random = Math.random) {
  rnd = random;
  const { geom, mask, maskW: W, maskH: H, start, effort, clearanceKm, spinOnly } = msg;
  const landField = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) landField[i] = mask[i];
  const fieldUse = clearanceKm > 0 ? costField(mask, W, H, clearanceKm, 0.25) : landField;
  const obj = makeObjective(geom, W, H);
  const C = (q, stride) => obj.cost(q, fieldUse, stride);
  const landKm = (q) => obj.cost(q, landField, 1) * R_KM;

  const budget = effort;
  let evals = 0;
  let best = start, bestC = C(start, 1);
  const startLand = landKm(start);
  let lastPost = 0;
  const post = (phase, force = false) => {
    const now = Date.now();
    if (!force && now - lastPost < 120) return;
    lastPost = now;
    emit({ type: 'progress', phase, frac: Math.min(1, evals / budget), best, bestCost: bestC * R_KM, landKm: landKm(best), startLand });
  };
  const propose = (q, sigma) => {
    if (spinOnly) return qmul(qAxisAngle([0, 0, 1], sigma * gauss()), q);
    return qnorm(qmul(qAxisAngle([gauss(), gauss(), gauss()], sigma * Math.abs(gauss())), q));
  };
  const consider = (q, c) => { if (c < bestC) { bestC = c; best = q; } };

  // 1. screening
  const nScreen = Math.round(budget * 0.3);
  const pool = [];
  for (let i = 0; i < nScreen; i++) {
    const q = spinOnly ? qmul(qAxisAngle([0, 0, 1], rnd() * 2 * Math.PI), start) : qRandom();
    const c = C(q, 4);
    evals++;
    pool.push([c, q]);
    if (i % 200 === 0) post('Screening random orientations');
  }
  pool.sort((a, b) => a[0] - b[0]);
  const costs = pool.map((p) => p[0]);
  const spread = Math.max(1e-6, costs[Math.floor(costs.length * 0.5)] - costs[0]);
  // diverse seeds (plus the current orientation)
  const K = 6;
  const seeds = [start];
  const minSep = spinOnly ? 0.35 : 0.5;
  for (const [, q] of pool) {
    if (seeds.length >= K + 1) break;
    if (seeds.every((s) => qAngle(s, q) > minSep)) seeds.push(q);
  }

  // 2. simulated annealing from each seed
  const saBudget = Math.round(budget * 0.55);
  const per = Math.max(50, Math.floor(saBudget / seeds.length));
  const T0 = spread * 0.3, T1 = T0 * 1e-3;
  for (let s = 0; s < seeds.length; s++) {
    let cur = seeds[s], curC = C(cur, 2);
    evals++;
    consider(cur, curC);
    for (let i = 0; i < per; i++) {
      const frac = i / per;
      const T = T0 * Math.pow(T1 / T0, frac);
      const sigma = Math.max(0.003, 0.35 * Math.pow(1 - frac, 1.5));
      const q = propose(cur, sigma);
      const c = C(q, 2);
      evals++;
      if (c < curC || rnd() < Math.exp(-(c - curC) / T)) { cur = q; curC = c; }
      if (c < bestC) {
        const exact = C(q, 1); // confirm at full sampling
        consider(q, exact);
      }
      if (i % 100 === 0) post(`Annealing from seed ${s + 1}/${seeds.length}`);
    }
  }

  // 3. greedy polish at full resolution
  const nPolish = Math.max(100, budget - evals);
  bestC = C(best, 1);
  let sigma = 0.03;
  for (let i = 0; i < nPolish; i++) {
    const q = propose(best, sigma);
    const c = C(q, 1);
    evals++;
    if (c < bestC) { bestC = c; best = q; } else sigma = Math.max(0.0005, sigma * 0.997);
    if (i % 100 === 0) post('Polishing');
  }
  post('Done', true);
  const result = { type: 'done', best, bestCost: bestC * R_KM, landKm: landKm(best), startLand };
  emit(result);
  return result;
}

/** Flatten polyhedron geometry (from geometry.js) into transferable arrays. folds = Set of fold edge keys for fixed-net mode. */
export function flattenGeometry(G, folds = null) {
  let nS = 0;
  for (const e of G.edges) nS += e.samples.length;
  const samples = new Float32Array(3 * nS), edgeStart = new Int32Array(G.edges.length + 1);
  const edgeLen = new Float64Array(G.edges.length), edgeFaces = new Int32Array(2 * G.edges.length);
  const fixedCut = folds ? new Uint8Array(G.edges.length) : null;
  let o = 0;
  G.edges.forEach((e, i) => {
    edgeStart[i] = o;
    for (const p of e.samples) { samples.set(p, 3 * o); o++; }
    edgeLen[i] = e.len;
    edgeFaces[2 * i] = e.faces[0]; edgeFaces[2 * i + 1] = e.faces[1];
    if (fixedCut) fixedCut[i] = folds.has(e.key) ? 0 : 1;
  });
  edgeStart[G.edges.length] = o;
  return { samples, edgeStart, edgeLen, edgeFaces, F: G.F, fixedCut };
}
