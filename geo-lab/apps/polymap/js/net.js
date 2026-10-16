// Nets: a net is a set of "fold" edges forming a forest on the face-adjacency graph.
// Each connected component (piece) is anchored by one face with a 2D rigid transform;
// the remaining faces hinge off it. Edges that are not folds are cuts.
//
// net = { folds: Set<edgeKey>, anchors: Map<faceKey, [angle, x, y]> }
import * as V from './vec.js';

// ---------------------------------------------------------------- rigid 2D transforms [c, s, x, y]
export const tApply = (M, p) => [M[0] * p[0] - M[1] * p[1] + M[2], M[1] * p[0] + M[0] * p[1] + M[3]];
export const tFromAnchor = (a) => [Math.cos(a[0]), Math.sin(a[0]), a[1], a[2]];
export const tToAnchor = (M) => [Math.atan2(M[1], M[0]), M[2], M[3]];
/** Rigid transform taking p1->q1 and (direction of) p2->q2. */
function tFromSegments(p1, p2, q1, q2) {
  const a = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]) - Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
  const c = Math.cos(a), s = Math.sin(a);
  return [c, s, q1[0] - (c * p1[0] - s * p1[1]), q1[1] - (s * p1[0] + c * p1[1])];
}

class UF {
  constructor(n) { this.p = Int32Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a === b) return false; this.p[a] = b; return true; }
}

export function emptyNet() { return { folds: new Set(), anchors: new Map() }; }

/** Remove fold keys that don't exist and break any cycles. */
export function sanitize(G, net) {
  const uf = new UF(G.F);
  const keep = new Set();
  for (const key of net.folds) {
    const id = G.edgeByKey.get(key);
    if (id === undefined) continue;
    const [f, g] = G.edges[id].faces;
    if (uf.union(f, g)) keep.add(key);
  }
  net.folds = keep;
  for (const k of [...net.anchors.keys()]) if (!G.faceByKey.has(k)) net.anchors.delete(k);
  return net;
}

/** Components and per-face world transforms. Creates anchors for unanchored pieces. */
export function computeLayout(G, net) {
  const F = G.F;
  const adj = Array.from({ length: F }, () => []);
  for (const key of net.folds) {
    const id = G.edgeByKey.get(key);
    if (id === undefined) continue;
    const e = G.edges[id];
    adj[e.faces[0]].push([e.faces[1], id]);
    adj[e.faces[1]].push([e.faces[0], id]);
  }
  const comp = new Int32Array(F).fill(-1);
  const comps = [];
  for (let s = 0; s < F; s++) {
    if (comp[s] >= 0) continue;
    const id = comps.length, faces = [];
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const f = stack.pop();
      faces.push(f);
      for (const [g] of adj[f]) if (comp[g] < 0) { comp[g] = id; stack.push(g); }
    }
    faces.sort((a, b) => a - b);
    comps.push({ id, faces, root: -1 });
  }
  const M = new Array(F);
  const parent = new Int32Array(F).fill(-1);
  const parentEdge = new Int32Array(F).fill(-1);
  const depth = new Int32Array(F);
  const unanchored = [];
  for (const c of comps) {
    let root = -1;
    for (const f of c.faces) {
      const k = G.faces[f].key;
      if (net.anchors.has(k)) {
        if (root < 0) root = f; else net.anchors.delete(k);
      }
    }
    if (root < 0) { root = c.faces[0]; unanchored.push(c); net.anchors.set(G.faces[root].key, [0, 0, 0]); }
    c.root = root;
    M[root] = tFromAnchor(net.anchors.get(G.faces[root].key));
    const queue = [root];
    for (let qi = 0; qi < queue.length; qi++) {
      const f = queue[qi];
      for (const [g, eid] of adj[f]) {
        if (g === parent[f] && eid === parentEdge[f]) continue;
        if (M[g]) continue;
        const e = G.edges[eid];
        const fd = G.faces[f], gd = G.faces[g];
        const ia = fd.verts.indexOf(e.a), ib = fd.verts.indexOf(e.b);
        const ja = gd.verts.indexOf(e.a), jb = gd.verts.indexOf(e.b);
        const pa = tApply(M[f], fd.loc[ia]), pb = tApply(M[f], fd.loc[ib]);
        M[g] = tFromSegments(gd.loc[ja], gd.loc[jb], pa, pb);
        parent[g] = f; parentEdge[g] = eid; depth[g] = depth[f] + 1;
        queue.push(g);
      }
    }
  }
  const L = { M, comp, comps, parent, parentEdge, depth, adj };
  if (unanchored.length) placeUnanchored(G, net, L, unanchored);
  return L;
}

export function facePolygon(G, L, f) {
  return G.faces[f].loc.map((p) => tApply(L.M[f], p));
}

function compBBox(G, L, c) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of c.faces) for (const p of facePolygon(G, L, f)) {
    b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]);
    b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
  }
  return b;
}
export function layoutBBox(G, L) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of L.comps) {
    const cb = compBBox(G, L, c);
    b[0] = Math.min(b[0], cb[0]); b[1] = Math.min(b[1], cb[1]);
    b[2] = Math.max(b[2], cb[2]); b[3] = Math.max(b[3], cb[3]);
  }
  return b;
}

/** Translate a whole piece (component) by (dx, dy). */
export function movePiece(G, net, L, ci, dx, dy) {
  const c = L.comps[ci];
  const key = G.faces[c.root].key;
  const a = net.anchors.get(key);
  net.anchors.set(key, [a[0], a[1] + dx, a[2] + dy]);
  for (const f of c.faces) { const m = L.M[f]; L.M[f] = [m[0], m[1], m[2] + dx, m[3] + dy]; }
}
/** Rotate a piece by `ang` around world point p. */
export function rotatePiece(G, net, L, ci, ang, p) {
  const c = L.comps[ci];
  const cs = Math.cos(ang), sn = Math.sin(ang);
  const rot = (M) => {
    const x = M[2] - p[0], y = M[3] - p[1];
    return [M[0] * cs - M[1] * sn, M[1] * cs + M[0] * sn, p[0] + cs * x - sn * y, p[1] + sn * x + cs * y];
  };
  for (const f of c.faces) L.M[f] = rot(L.M[f]);
  net.anchors.set(G.faces[c.root].key, tToAnchor(L.M[c.root]));
}
export function pieceCentroid(G, L, ci) {
  let sx = 0, sy = 0, sa = 0;
  for (const f of L.comps[ci].faces) {
    const poly = facePolygon(G, L, f);
    const a = Math.abs(G.faces[f].area);
    const c = poly.reduce((acc, p) => [acc[0] + p[0] / poly.length, acc[1] + p[1] / poly.length], [0, 0]);
    sx += c[0] * a; sy += c[1] * a; sa += a;
  }
  return [sx / sa, sy / sa];
}

/** Shelf-pack pieces (biggest first). If `onlyThese` given, only those comps are placed (to the right). */
export function arrangePieces(G, net, L, onlyThese = null) {
  const gap = G.meanRad * 0.35;
  const list = (onlyThese || L.comps).map((c) => ({ c, b: compBBox(G, L, c) }));
  list.sort((p, q) => (q.b[2] - q.b[0]) * (q.b[3] - q.b[1]) - (p.b[2] - p.b[0]) * (p.b[3] - p.b[1]));
  let totalArea = 0;
  for (const it of list) totalArea += (it.b[2] - it.b[0] + gap) * (it.b[3] - it.b[1] + gap);
  const maxW = Math.max(Math.sqrt(totalArea) * 1.7, ...list.map((it) => it.b[2] - it.b[0]));
  let x0 = 0, y0 = 0, rowH = 0;
  if (onlyThese) {
    const others = L.comps.filter((c) => !onlyThese.includes(c));
    if (others.length) {
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const c of others) { const cb = compBBox(G, L, c); b[0] = Math.min(b[0], cb[0]); b[1] = Math.min(b[1], cb[1]); b[2] = Math.max(b[2], cb[2]); b[3] = Math.max(b[3], cb[3]); }
      x0 = b[2] + gap; y0 = b[3];
    }
  }
  const startX = x0;
  let cx = x0, cy = y0;
  for (const it of list) {
    const w = it.b[2] - it.b[0], h = it.b[3] - it.b[1];
    if (cx > startX && cx + w - startX > maxW) { cx = startX; cy -= rowH + gap; rowH = 0; }
    movePiece(G, net, L, it.c.id, cx - it.b[0], cy - it.b[3]);
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }
}

function placeUnanchored(G, net, L, comps) {
  arrangePieces(G, net, L, comps);
}

// ---------------------------------------------------------------- editing
function subtreeFaces(L, start, blockedEdge) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const f = stack.pop();
    for (const [g, eid] of L.adj[f]) if (eid !== blockedEdge && !seen.has(g)) { seen.add(g); stack.push(g); }
  }
  return seen;
}

/**
 * Toggle edge eid between cut and fold, preserving piece positions as much as possible.
 * Returns a short description of what happened.
 */
export function toggleEdge(G, net, L, eid) {
  const e = G.edges[eid];
  const [f, g] = e.faces;
  if (net.folds.has(e.key)) {
    // cut: the side without the anchor becomes a new piece, nudged away from the edge
    const ci = L.comp[f];
    const root = L.comps[ci].root;
    net.folds.delete(e.key);
    const sideF = subtreeFaces(L, f, eid);
    const moving = sideF.has(root) ? g : f;
    const M = L.M[moving];
    const pc = facePolygon(G, L, moving).reduce((a, p, _, arr) => [a[0] + p[0] / arr.length, a[1] + p[1] / arr.length], [0, 0]);
    const ea = tApply(L.M[f], G.faces[f].loc[G.faces[f].verts.indexOf(e.a)]);
    const eb = tApply(L.M[f], G.faces[f].loc[G.faces[f].verts.indexOf(e.b)]);
    const em = [(ea[0] + eb[0]) / 2, (ea[1] + eb[1]) / 2];
    let dx = pc[0] - em[0], dy = pc[1] - em[1];
    const dl = Math.hypot(dx, dy) || 1;
    const push = G.meanRad * 0.12;
    net.anchors.set(G.faces[moving].key, [Math.atan2(M[1], M[0]), M[2] + (dx / dl) * push, M[3] + (dy / dl) * push]);
    return 'cut';
  }
  if (L.comp[f] !== L.comp[g]) {
    // join: the smaller piece moves to attach
    const cf = L.comps[L.comp[f]], cg = L.comps[L.comp[g]];
    const mover = cf.faces.length < cg.faces.length ? cf : cg;
    for (const h of mover.faces) net.anchors.delete(G.faces[h].key);
    net.folds.add(e.key);
    return 'join';
  }
  // same piece: re-hinge. Find tree path f..g, remove the end edge whose moving side is smaller.
  const prev = new Map([[f, [-1, -1]]]);
  const queue = [f];
  for (let qi = 0; qi < queue.length && !prev.has(g); qi++) {
    const h = queue[qi];
    for (const [k, id] of L.adj[h]) if (!prev.has(k)) { prev.set(k, [h, id]); queue.push(k); }
  }
  const path = [];
  for (let h = g; h !== f; h = prev.get(h)[0]) path.push(prev.get(h)[1]);
  const root = L.comps[L.comp[f]].root;
  const options = [path[0], path[path.length - 1]].map((rem) => {
    const ed = G.edges[rem];
    const side = subtreeFaces(L, ed.faces[0], rem);
    const moving = side.has(root) ? subtreeFaces(L, ed.faces[1], rem) : side;
    return { rem, size: moving.size };
  });
  options.sort((a, b) => a.size - b.size);
  net.folds.delete(G.edges[options[0].rem].key);
  net.folds.add(e.key);
  return 'rehinge';
}

// ---------------------------------------------------------------- generators
function kruskal(G, weight) {
  const order = G.edges.map((e) => e.id).sort((a, b) => weight[b] - weight[a]);
  const uf = new UF(G.F);
  const folds = new Set();
  for (const id of order) {
    const [f, g] = G.edges[id].faces;
    if (uf.union(f, g)) folds.add(G.edges[id].key);
  }
  return folds;
}
/** Maximum spanning tree weight (used by the optimizer). */
export function maxTreeWeight(G, weight) {
  const order = Array.from(weight.keys()).sort((a, b) => weight[b] - weight[a]);
  const uf = new UF(G.F);
  let s = 0;
  for (const id of order) {
    const [f, g] = G.edges[id].faces;
    if (uf.union(f, g)) s += weight[id];
  }
  return s;
}

export function treeFromWeights(G, weight) { return kruskal(G, weight); }
export function randomTree(G) { return kruskal(G, G.edges.map(() => Math.random())); }

export function bfsTree(G, root = 0) {
  const folds = new Set();
  const seen = new Uint8Array(G.F);
  seen[root] = 1;
  const q = [root];
  for (let i = 0; i < q.length; i++) {
    const f = q[i];
    G.faceNbr[f].forEach((g, k) => {
      if (!seen[g]) { seen[g] = 1; folds.add(G.edges[G.faceEdge[f][k]].key); q.push(g); }
    });
  }
  return folds;
}
export function dfsTree(G, root = 0) {
  const folds = new Set();
  const seen = new Uint8Array(G.F);
  const rec = [root];
  seen[root] = 1;
  // iterative DFS visiting neighbours in face order -> long strips
  const stack = [[root, 0]];
  while (stack.length) {
    const top = stack[stack.length - 1];
    const [f, k] = top;
    if (k >= G.faceNbr[f].length) { stack.pop(); continue; }
    top[1]++;
    const g = G.faceNbr[f][k];
    if (!seen[g]) { seen[g] = 1; rec.push(g); folds.add(G.edges[G.faceEdge[f][k]].key); stack.push([g, 0]); }
  }
  return folds;
}

/** Face with minimal eccentricity in the fold forest component of f0 - a nice anchor. */
export function treeCenter(G, folds, f0 = 0) {
  const adj = Array.from({ length: G.F }, () => []);
  for (const key of folds) {
    const e = G.edges[G.edgeByKey.get(key)];
    adj[e.faces[0]].push(e.faces[1]); adj[e.faces[1]].push(e.faces[0]);
  }
  const far = (s) => {
    const dist = new Map([[s, 0]]), q = [s];
    for (let i = 0; i < q.length; i++) for (const g of adj[q[i]]) if (!dist.has(g)) { dist.set(g, dist.get(q[i]) + 1); q.push(g); }
    const last = q[q.length - 1];
    return { last, dist, q };
  };
  const a = far(f0).last;
  const { last: b, dist } = far(a);
  // walk from b towards a half way
  const target = Math.floor(dist.get(b) / 2);
  const back = far(b).dist;
  let best = b;
  for (const [f, d] of dist) if (d === dist.get(b) - target && back.get(f) === target) { best = f; break; }
  return best;
}

// ---------------------------------------------------------------- overlaps
export function findOverlaps(G, L) {
  const polys = [], boxes = [];
  for (let f = 0; f < G.F; f++) {
    const p = facePolygon(G, L, f);
    polys.push(p);
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const q of p) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }
    boxes.push(b);
  }
  const eps = G.meanRad * 1e-4;
  const out = new Set();
  const axesOf = (p) => p.map((a, i) => { const b = p[(i + 1) % p.length]; const nx = a[1] - b[1], ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; return [nx / l, ny / l]; });
  const axes = polys.map(axesOf);
  for (let i = 0; i < G.F; i++) for (let j = i + 1; j < G.F; j++) {
    const a = boxes[i], b = boxes[j];
    if (a[2] < b[0] + eps || b[2] < a[0] + eps || a[3] < b[1] + eps || b[3] < a[1] + eps) continue;
    let separated = false;
    for (const ax of [...axes[i], ...axes[j]]) {
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (const p of polys[i]) { const v = p[0] * ax[0] + p[1] * ax[1]; amin = Math.min(amin, v); amax = Math.max(amax, v); }
      for (const p of polys[j]) { const v = p[0] * ax[0] + p[1] * ax[1]; bmin = Math.min(bmin, v); bmax = Math.max(bmax, v); }
      if (amax < bmin + eps || bmax < amin + eps) { separated = true; break; }
    }
    if (!separated) { out.add(i); out.add(j); }
  }
  return out;
}

// ---------------------------------------------------------------- serialization
export function netToJSON(net) {
  return { folds: [...net.folds], anchors: Object.fromEntries(net.anchors) };
}
export function netFromJSON(o) {
  return { folds: new Set(o?.folds || []), anchors: new Map(Object.entries(o?.anchors || {})) };
}

/**
 * Carry a net across a topology change produced by face splits: old fold edges that were
 * subdivided map to their halves, new internal edges join pieces, anchors move to the
 * coplanar face now covering the old anchor face's centre.
 */
export function migrateNet(oldG, newG, net, locateFn) {
  const cand = [];
  for (const key of net.folds) {
    if (newG.edgeByKey.has(key)) { cand.push(key); continue; }
    const [a, b] = key.split('_').map(Number);
    // find a vertex m with edges a_m and m_b
    for (const e of newG.edges) {
      if (e.a !== a && e.b !== a) continue;
      const m = e.a === a ? e.b : e.a;
      const k2 = m < b ? m + '_' + b : b + '_' + m;
      if (newG.edgeByKey.has(k2)) {
        // m must lie on segment a-b
        const pa = newG.verts[a], pb = newG.verts[b], pm = newG.verts[m];
        if (V.len(V.cross(V.sub(pm, pa), V.sub(pb, pa))) < 1e-9 * V.len(V.sub(pb, pa)) ** 2) { cand.push(e.key, k2); break; }
      }
    }
  }
  // internal edges of newly created faces (faces whose key is new) join their pieces
  for (const e of newG.edges) {
    if (oldG.edgeByKey.has(e.key)) continue;
    const [f, g] = e.faces;
    if (!oldG.faceByKey.has(newG.faces[f].key) && !oldG.faceByKey.has(newG.faces[g].key)) {
      const nf = newG.faces[f].n, ng = newG.faces[g].n;
      if (V.dot(nf, ng) > 1 - 1e-9) cand.push(e.key);
    }
  }
  const uf = new UF(newG.F);
  const folds = new Set();
  for (const key of cand) {
    const id = newG.edgeByKey.get(key);
    if (id === undefined || folds.has(key)) continue;
    const [f, g] = newG.edges[id].faces;
    if (uf.union(f, g)) folds.add(key);
  }
  const anchors = new Map();
  for (const [key, a] of net.anchors) {
    if (newG.faceByKey.has(key)) { anchors.set(key, a); continue; }
    const of = oldG.faceByKey.get(key);
    if (of === undefined) continue;
    const nf = locateFn(newG, oldG.faces[of].A);
    if (!anchors.has(newG.faces[nf].key)) anchors.set(newG.faces[nf].key, a);
  }
  return { folds, anchors };
}
