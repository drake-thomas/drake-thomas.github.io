// RotateNav: rotation and rotation-aware navigation for a CSS-rotated Google map.
//
//   const nav = new RotateNav({ container, rotEl, getMap: () => map });
//   nav.setRotation(deg, durSeconds)  // rotate the view (CSS transform on rotEl, around the screen centre)
//   nav.setBase(deg)                  // the round's starting angle ("reset" goes back here while north is secret)
//   nav.setNorthKnown(true)           // after answering: the compass shows north and reset means north-up
//   nav.setFree(true)                 // free pan/zoom (post-answer); false = the app drives the camera
//   nav.reset()                       // N key / compass click
//   nav.attachCompass(buttonEl)       // compass needle (or an undo-rotation icon while north is secret)
//
// Cmd-drag (Ctrl-drag off Mac) anywhere on `container` rotates the view around the screen centre.
// The rotation is a CSS transform, so Google's own drag and wheel handling would move the map along the
// wrong axes once it's rotated: while free and rotated, this module does the panning (drag) and
// zooming (wheel, double-click; zoom anchored under the cursor) itself, in the map's own frame, and
// hands gestures back to Google (gestureHandling 'greedy') whenever the view is north-up again.
// `container` is the unrotated, screen-filling element; `rotEl` is the oversized square centred in it.

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';
export const isRotateGesture = e => e.metaKey || (!IS_MAC && e.ctrlKey);
const norm = d => ((d % 360) + 540) % 360 - 180;  // -> [-180, 180)
const TILE = 256, R2D = 180 / Math.PI, MIN_Z = 2, MAX_Z = 22, DEAD_PX = 24;

/** Web Mercator world coordinates (0..256) at zoom 0. */
export function toWorld({ lat, lng }) {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin(lat / R2D)));
  return { x: (lng + 180) / 360 * TILE, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE };
}
export function fromWorld({ x, y }) {
  y = Math.max(0, Math.min(TILE, y));
  const n = Math.PI - 2 * Math.PI * y / TILE;
  const lng = ((x / TILE * 360 - 180) % 360 + 540) % 360 - 180;
  return { lat: R2D * Math.atan(Math.sinh(n)), lng };
}

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
.rn-pan, .rn-pan * { cursor: grab !important; }
.rn-panning, .rn-panning *, .rn-rotating, .rn-rotating * { cursor: grabbing !important; }
.rn-compass svg { display: block; margin: auto; pointer-events: none; }
.rn-compass .rn-free { display: none; }
.rn-compass:not(.rn-north) .rn-needle { display: none; }
.rn-compass:not(.rn-north) .rn-free { display: inline; }
.rn-compass.rn-idle { opacity: .45; }`;
  document.head.appendChild(st);
}

export class RotateNav {
  constructor({ container, rotEl, getMap, freeGestures = 'greedy', onChange = null }) {
    injectCss();
    Object.assign(this, { container, rotEl, getMap, freeGestures, onChange });
    this.deg = 0; this.base = 0; this.northKnown = false; this.free = false;
    this.compasses = []; this.drag = null; this.zAnim = 0; this._gh = null;
    const cap = { capture: true };
    container.addEventListener('pointerdown', e => this._down(e), cap);
    // Keep Google's own drag from starting under a rotate/pan we own.
    container.addEventListener('mousedown', e => {
      if (this.drag || (e.button === 0 && (isRotateGesture(e) || (this.free && this.rotated)))) { e.stopPropagation(); e.preventDefault(); }
    }, cap);
    container.addEventListener('wheel', e => this._wheel(e), { capture: true, passive: false });
    container.addEventListener('dblclick', e => {
      if (!(this.free && this.rotated)) return;
      e.stopPropagation(); e.preventDefault();
      this._zoomAround(e.clientX, e.clientY, e.shiftKey ? -1 : 1);
    }, cap);
    container.addEventListener('contextmenu', e => { if (this._noCtx) { e.preventDefault(); this._noCtx = false; } }, cap);
    addEventListener('pointermove', e => this._move(e));
    addEventListener('pointerup', e => this._up(e));
    addEventListener('pointercancel', e => this._up(e));
  }

  get map() { return this.getMap(); }
  get rotated() { return Math.abs(norm(this.deg)) > 0.05; }

  setRotation(deg, dur = 0) {
    const was = this.rotated;
    this.deg = deg;
    this.rotEl.style.transition = dur ? `transform ${dur}s ease` : 'none';
    this.rotEl.style.transform = `rotate(${deg}deg)`;
    if (was !== this.rotated) this._syncGestures();
    this._updateCompass(dur);
    this.onChange?.(deg);
  }
  /** Turn to `target` the short way round. */
  rotateTo(target, dur = 0.6) { this.setRotation(this.deg - norm(this.deg - target), dur); }
  /** North-up once the answer is known; before that, back to the round's own (secret) angle. */
  reset(dur = 0.6) { this.rotateTo(this.northKnown ? 0 : this.base, dur); }
  setBase(deg) { this.base = deg; this._updateCompass(0); }
  setNorthKnown(on) { this.northKnown = on; this._updateCompass(0); }
  setFree(on) { this.free = on; this._gh = null; this._stopZoom(); this._syncGestures(); }

  _syncGestures() {
    const m = this.map;
    this.container.classList.toggle('rn-pan', this.free && this.rotated);
    if (!m) return;
    const want = this.free && !this.rotated ? this.freeGestures : 'none';
    if (want !== this._gh) { this._gh = want; m.setOptions({ gestureHandling: want }); }
  }

  // ----- geometry -----
  _centre() { const r = this.container.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  /** Screen-pixel vector -> the same vector in the (rotated) map's own pixel frame. */
  toMapFrame(dx, dy) {
    const t = this.deg / R2D, c = Math.cos(t), s = Math.sin(t);
    return [dx * c + dy * s, -dx * s + dy * c];
  }
  /** lat/lng under a client point, accounting for the rotation. */
  latLngAt(clientX, clientY) {
    const m = this.map, [cx, cy] = this._centre(), sc = 2 ** m.getZoom();
    const [qx, qy] = this.toMapFrame(clientX - cx, clientY - cy), w = toWorld(m.getCenter().toJSON());
    return fromWorld({ x: w.x + qx / sc, y: w.y + qy / sc });
  }
  panBy(dx, dy) {
    const m = this.map, sc = 2 ** m.getZoom();
    const [mx, my] = this.toMapFrame(dx, dy), w = toWorld(m.getCenter().toJSON());
    m.moveCamera({ center: fromWorld({ x: w.x - mx / sc, y: w.y - my / sc }) });
  }

  // ----- pointer: Cmd-drag rotates; plain drag pans while free + rotated -----
  _down(e) {
    if (e.button !== 0) return;
    const rot = isRotateGesture(e);
    if (!rot && !(this.free && this.rotated)) return;  // Google (or the app) handles it
    e.preventDefault(); e.stopPropagation();
    try { this.container.setPointerCapture(e.pointerId); } catch {}
    const [cx, cy] = this._centre();
    this.drag = { id: e.pointerId, mode: rot ? 'rotate' : 'pan', x: e.clientX, y: e.clientY, cx, cy,
                  last: Math.atan2(e.clientY - cy, e.clientX - cx) };
    if (e.ctrlKey) this._noCtx = true;
    this._stopZoom();
    this.container.classList.add(rot ? 'rn-rotating' : 'rn-panning');
  }
  _move(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    e.preventDefault();
    if (d.mode === 'rotate') {
      const a = Math.atan2(e.clientY - d.cy, e.clientX - d.cx);
      const near = Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < DEAD_PX;  // angle is jumpy at the centre
      const da = norm((a - d.last) * R2D);
      d.last = a;
      if (!near) this.setRotation(this.deg + da, 0);
    } else {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      if (this.map) this.panBy(dx, dy);
    }
  }
  _up(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.container.classList.remove('rn-rotating', 'rn-panning');
    // Snap to north-up when close (only once north is no longer a secret).
    if (d.mode === 'rotate' && this.northKnown && this.rotated && Math.abs(norm(this.deg)) < 4) this.rotateTo(0, 0.2);
  }

  // ----- wheel / double-click zoom while free + rotated (anchored under the cursor) -----
  _wheel(e) {
    if (!(this.free && this.rotated) || !this.map) return;
    e.preventDefault(); e.stopPropagation();
    const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this._zoomAround(e.clientX, e.clientY, -px * (e.ctrlKey ? 0.02 : 0.006));
  }
  _zoomAround(clientX, clientY, dz) {
    const m = this.map, [cx, cy] = this._centre(), z = m.getZoom();
    const q = this.toMapFrame(clientX - cx, clientY - cy), w = toWorld(m.getCenter().toJSON()), sc = 2 ** z;
    this.anchor = { q, P: { x: w.x + q[0] / sc, y: w.y + q[1] / sc } };  // world point under the cursor
    this.zCur = z;
    this.zt = Math.max(MIN_Z, Math.min(MAX_Z, (this.zAnim ? this.zt : z) + dz));
    if (!this.zAnim) this.zAnim = requestAnimationFrame(() => this._zoomFrame());
  }
  _zoomFrame() {
    const m = this.map, { q, P } = this.anchor;
    const d = this.zt - this.zCur;
    this.zCur = Math.abs(d) < 0.003 ? this.zt : this.zCur + d * 0.25;
    const at = z => fromWorld({ x: P.x - q[0] / 2 ** z, y: P.y - q[1] / 2 ** z });
    m.moveCamera({ zoom: this.zCur, center: at(this.zCur) });
    const actual = m.getZoom();
    if (Math.abs(actual - this.zCur) > 0.05) {  // clamped by the max zoom (fractional zoom is only quantized to 1/32)
      this.zCur = this.zt = actual;
      m.moveCamera({ center: at(actual) });
    }
    this.zAnim = this.zCur === this.zt ? 0 : requestAnimationFrame(() => this._zoomFrame());
  }
  _stopZoom() { cancelAnimationFrame(this.zAnim); this.zAnim = 0; }

  // ----- compass -----
  attachCompass(btn) {
    btn.classList.add('rn-compass');
    btn.innerHTML = `<svg viewBox="-12 -12 24 24" width="24" height="24" aria-hidden="true">
      <g class="rn-needle"><path d="M0,-10 L4,0 L-4,0Z" fill="#ff5a5a"/><path d="M0,10 L4,0 L-4,0Z" fill="#dfe3e8"/></g>
      <g class="rn-free" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M-6.5,3.5 A7.5,7.5 0 1 0 -3,-6.8"/><path d="M-7.5,-8 L-3,-6.8 L-4.4,-2.4"/></g></svg>`;
    btn.addEventListener('click', () => this.reset());
    this.compasses.push(btn);
    this._updateCompass(0);
  }
  _updateCompass(dur) {
    for (const b of this.compasses) {
      b.classList.toggle('rn-north', this.northKnown);
      b.classList.toggle('rn-idle', !this.northKnown && Math.abs(norm(this.deg - this.base)) < 0.5);
      b.title = this.northKnown ? `North up (N) · ${MOD_LABEL}-drag the view to rotate`
                                : `Undo your rotation (N) · ${MOD_LABEL}-drag the view to rotate`;
      const n = b.querySelector('.rn-needle');
      if (n) { n.style.transition = dur ? `transform ${dur}s ease` : 'none'; n.style.transform = `rotate(${this.deg}deg)`; }
    }
  }
}
