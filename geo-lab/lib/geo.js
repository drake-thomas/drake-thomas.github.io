// Small geo helpers shared by the apps.
const R = 6371, RAD = Math.PI / 180;

export function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Web-mercator meters per CSS pixel at a zoom level and latitude.
export const metersPerPx = (lat, zoom) => 156543.03392 * Math.cos(lat * RAD) / 2 ** zoom;

// Zoom at which `km` spans `px` screen pixels.
export const zoomForKm = (lat, km, px) => Math.log2(px * 156543.03392 * Math.cos(lat * RAD) / (km * 1000));

// Move a point by (dxKm east, dyKm north).
export function offsetKm(p, dxKm, dyKm) {
  return { lat: p.lat + dyKm / 111.32, lng: p.lng + dxKm / (111.32 * Math.max(0.05, Math.cos(p.lat * RAD))) };
}

export const fmtKm = km => km < 1 ? `${Math.round(km * 1000)} m` : km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString()} km`;

// ----- point in polygon (GeoJSON coordinates: [lng, lat]) -----
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPoly = (x, y, rings) => inRing(x, y, rings[0]) && !rings.slice(1).some(h => inRing(x, y, h));

export function geometryContains(geom, lng, lat) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return inPoly(lng, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => inPoly(lng, lat, p));
  return false;
}

export function bboxOf(geom) {
  let w = 180, s = 90, e = -180, n = -90;
  const walk = c => {
    if (typeof c[0] === 'number') { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return [w, s, e, n];
}

// Index of polygons for fast "which polygon contains this point" lookups.
export class PolygonIndex {
  constructor(features, keyFn) {
    this.items = features.filter(f => f.geometry && /Polygon/.test(f.geometry.type))
      .map(f => ({ f, key: keyFn ? keyFn(f) : f, bbox: bboxOf(f.geometry) }));
  }
  find(lng, lat) {
    for (const it of this.items) {
      const [w, s, e, n] = it.bbox;
      if (lng < w || lng > e || lat < s || lat > n) continue;
      if (geometryContains(it.f.geometry, lng, lat)) return it.key;
    }
    return null;
  }
}

// Distance (km) from a point to the nearest vertex of a line/polygon (cheap approximation).
export function nearestVertexKm(geom, p) {
  let best = Infinity;
  const walk = c => {
    if (typeof c[0] === 'number') { const d = haversineKm(p, { lat: c[1], lng: c[0] }); if (d < best) best = d; }
    else c.forEach(walk);
  };
  walk(geom.coordinates);
  return best;
}

export const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const pick = a => a[Math.floor(Math.random() * a.length)];
export const rand = (lo, hi) => lo + Math.random() * (hi - lo);
