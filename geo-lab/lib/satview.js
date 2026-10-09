// SatView: a rotated, label-free Google satellite view with smooth zoom and
// tile prefetching (ported from satellite_view_geoguessr).
//
//   const sv = new SatView(containerEl, { onZoom: z => ... });
//   await sv.show({ lat, lng, zoom, rotation, minZoom, maxZoom });  // resolves once tiles are on screen
//   await sv.show({ focus: { lat, lng, sx, sy }, zoom, ... })  // put (lat,lng) at screen offset (sx,sy) px
//                                                               // from center; zooming pivots around it
//   sv.zoomBy(-1); sv.zoomTo(9.5); sv.zoom; sv.lowestZoom
//   sv.setExplore(true, { labels: true });  // un-rotate, free pan/zoom, optional labels
//
// Why the extra machinery: the map sits in an oversized rotated square, and
// slow-loading tiles draw an axis-aligned grid that gives the rotation away.
// A hidden second map ("pre", twice the size) walks through the next zoom-out
// levels so their tiles are already cached when the player zooms out.
import { loadMaps } from './maps.js';

const LOOKAHEAD = 3, PREFETCH_TIMEOUT_MS = 1500;

export class SatView {
  constructor(container, { onZoom = null, minZoom = 2, maxZoom = 21 } = {}) {
    this.container = container;
    this.onZoom = onZoom;
    this.bounds = { min: minZoom, max: maxZoom };
    this.zCur = 3; this.zTarget = 3; this.anim = 0;
    this.locked = true;
    this.center = { lat: 0, lng: 0 };
    this.prefetched = new Set(); this.preQueue = []; this.preBusy = null; this.preTimer = 0;
    this.lowestZoom = Infinity;

    container.classList.add('satview');
    container.innerHTML = '<div class="sv-rot"><div class="sv-map sv-sat"></div><div class="sv-map sv-pre"></div></div>';
    this.rot = container.querySelector('.sv-rot');
    this.ready = this._init();
  }

  async _init() {
    const gm = await loadMaps();
    const opts = {
      center: { lat: 0, lng: 0 }, zoom: 3, mapTypeId: 'satellite', tilt: 0,
      disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false,
      clickableIcons: false, isFractionalZoomEnabled: true, backgroundColor: '#000',
    };
    this.map = new gm.Map(this.rot.querySelector('.sv-sat'), opts);
    this.pre = new gm.Map(this.rot.querySelector('.sv-pre'), { ...opts, isFractionalZoomEnabled: false });
    this.pre.addListener('tilesloaded', () => this._prefetchDone());
    this.map.addListener('zoom_changed', () => {
      if (!this.locked) { this.zCur = this.zTarget = this.map.getZoom(); this.onZoom?.(this.zCur); }
    });
    new ResizeObserver(() => this._layout()).observe(this.container);
    this._layout();
    this.container.addEventListener('wheel', e => {
      if (!this.locked) return;  // explore mode: Google handles it
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomTo(this.zTarget - px * (e.ctrlKey ? 0.02 : 0.006));
    }, { passive: false });
    return this;
  }

  _layout() {
    const W = this.container.clientWidth, H = this.container.clientHeight;
    const D = Math.ceil(Math.hypot(W, H)) + 4;
    Object.assign(this.rot.style, { width: D + 'px', height: D + 'px', left: (W - D) / 2 + 'px', top: (H - D) / 2 + 'px' });
    if (this.map) for (const m of [this.map, this.pre]) google.maps.event.trigger(m, 'resize');
  }

  get zoom() { return this.zCur; }

  /** Map center that keeps the focus point at its screen offset at zoom z. */
  centerFor(z) {
    const f = this.focus;
    if (!f) return this.center;
    const mpp = 156543.03392 * Math.cos(f.lat * Math.PI / 180) / 2 ** z;
    return {
      lat: f.lat + f.my * mpp / 111320,
      lng: f.lng - f.mx * mpp / (111320 * Math.cos(f.lat * Math.PI / 180)),
    };
  }

  /** Show a new location (hidden until tiles are loaded). */
  async show({ lat, lng, zoom, rotation = Math.random() * 360, minZoom = this.bounds.min, maxZoom = this.bounds.max, mapType = 'satellite', focus = null }) {
    await this.ready;
    this._stopAnim();
    this.setExplore(false);
    this.container.classList.add('sv-loading');
    this.bounds = { min: minZoom, max: maxZoom };
    this.zCur = this.zTarget = Math.max(minZoom, Math.min(maxZoom, zoom));
    this.rotation = rotation;
    this.focus = null;
    if (focus) {
      // Screen offset -> offset in the (rotated) map frame, in CSS px from the map center.
      const t = rotation * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      this.focus = { lat: focus.lat, lng: focus.lng, mx: focus.sx * c + focus.sy * s, my: -focus.sx * s + focus.sy * c };
    }
    this.center = this.focus ? this.centerFor(this.zCur) : { lat, lng };
    this.lowestZoom = this.zCur;
    this.prefetched = new Set(); this.preQueue = []; this.preBusy = null;
    const shown = new Promise(res => {
      const t = setTimeout(res, 8000);  // never hang the game on a stuck tile
      google.maps.event.addListenerOnce(this.map, 'tilesloaded', () => { clearTimeout(t); res(); });
    });
    this.map.setOptions({ center: this.center, zoom: this.zCur, mapTypeId: mapType });
    this.pre.setOptions({ center: this.center, mapTypeId: mapType });
    this.setRotation(rotation, false);
    this._schedulePrefetch();
    await shown;
    this.container.classList.remove('sv-loading');
    this.onZoom?.(this.zCur);
  }

  setRotation(deg, animate = true) {
    this.rotation = deg;
    this.rot.style.transition = animate ? 'transform 1.2s ease' : 'none';
    this.rot.style.transform = `rotate(${deg}deg)`;
  }

  // ----- zoom -----
  zoomBy(d) {
    if (!this.locked) { this.map.setZoom(Math.round(this.map.getZoom()) + d); return; }
    this.zoomTo(Math.round(this.zTarget) + d);
  }

  zoomTo(z) {
    this.zTarget = Math.max(this.bounds.min, Math.min(this.bounds.max, z));
    if (!this.anim) this.anim = requestAnimationFrame(() => this._frame());
  }

  _frame() {
    const d = this.zTarget - this.zCur;
    this.zCur = Math.abs(d) < 0.003 ? this.zTarget : this.zCur + d * 0.18;
    this.map.moveCamera(this.focus ? { zoom: this.zCur, center: this.centerFor(this.zCur) } : { zoom: this.zCur });
    this.lowestZoom = Math.min(this.lowestZoom, this.zCur);
    this.onZoom?.(this.zCur);
    this._schedulePrefetch();
    this.anim = this.zCur === this.zTarget ? 0 : requestAnimationFrame(() => this._frame());
  }

  _stopAnim() { cancelAnimationFrame(this.anim); this.anim = 0; }

  // ----- prefetch: walk the hidden map through upcoming zoom-out levels -----
  _schedulePrefetch() {
    if (!this.locked) return;
    const base = Math.ceil(this.zCur - 1e-6);  // tile level currently drawn
    this.preQueue = [];
    for (let k = 0; k <= LOOKAHEAD; k++) {
      const z = base - k;
      if (z >= this.bounds.min && !this.prefetched.has(z) && z !== this.preBusy) this.preQueue.push(z);
    }
    this._pump();
  }

  _pump() {
    if (this.preBusy !== null || !this.preQueue.length || !this.locked) return;
    this.preBusy = this.preQueue.shift();
    clearTimeout(this.preTimer);
    this.preTimer = setTimeout(() => this._prefetchDone(), PREFETCH_TIMEOUT_MS);
    if (this.focus) this.pre.setCenter(this.centerFor(this.preBusy));  // zoom pivots around the focus
    if (this.pre.getZoom() === this.preBusy) this._prefetchDone();
    else this.pre.setZoom(this.preBusy);  // (moveCamera doesn't fire tilesloaded)
  }

  _prefetchDone() {
    clearTimeout(this.preTimer);
    if (this.preBusy === null) return;
    this.prefetched.add(this.preBusy);
    this.preBusy = null;
    this._pump();
  }

  // ----- preload an upcoming view (e.g. the next quiz card) -----
  async preload({ lat, lng, zoom, focus = null, rotation = 0 }) {
    await this.ready;
    if (!this.warm) {
      const el = document.createElement('div');
      el.className = 'sv-map sv-warm';
      el.style.zIndex = '-1';  // under the visible map: laid out (so tiles load) but covered
      this.rot.appendChild(el);
      this.warm = new google.maps.Map(el, { center: { lat: 0, lng: 0 }, zoom: 3, mapTypeId: 'satellite', tilt: 0,
        disableDefaultUI: true, gestureHandling: 'none', clickableIcons: false, backgroundColor: '#000' });
    }
    let center = { lat, lng };
    if (focus) {
      const t = rotation * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      const mx = focus.sx * c + focus.sy * s, my = -focus.sx * s + focus.sy * c;
      const mpp = 156543.03392 * Math.cos(focus.lat * Math.PI / 180) / 2 ** Math.ceil(zoom);
      center = { lat: focus.lat + my * mpp / 111320, lng: focus.lng - mx * mpp / (111320 * Math.cos(focus.lat * Math.PI / 180)) };
    }
    this.warm.setOptions({ center, zoom: Math.ceil(zoom) });
  }

  // ----- explore mode (after answering) -----
  setExplore(on, { labels = true } = {}) {
    if (!this.map) return;
    this.locked = !on;
    if (on) {
      this._stopAnim();
      this.setRotation(0, true);
      this.map.setOptions({ gestureHandling: 'greedy', mapTypeId: labels ? 'hybrid' : 'satellite' });
    } else {
      this.map.setOptions({ gestureHandling: 'none', mapTypeId: 'satellite' });
    }
  }
}
