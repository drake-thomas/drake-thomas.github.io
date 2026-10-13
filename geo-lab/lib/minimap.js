// Minimap: lets a guess/answer map collapse to a small tab at the right edge of the screen.
//
//   const mm = new Minimap({ storageKey: 'geolab.x.minimap', targets: { guess: elA, reveal: elB } });
//   mm.attachMap(googleMap)    // adds a collapse button inside the map; re-lays it out on expand
//   mm.setPhase('guess')       // or 'reveal'; a phase with no target (or null) has no minimap: no tab
//   mm.toggle()                // M key; returns false when there is nothing to toggle
//   mm.fitOnce(() => map.fitBounds(b))  // reveal camera fit: runs once, deferred until the map is visible
//
// The collapsed state is remembered per phase (guessing vs. answer), so "keep the map out of the way
// while I look" and "show me the answer on the map" can both stick. While collapsed, the target gets
// .mm-hide and <body> gets .mm-collapsed (for app-specific layout tweaks). The tab sits mid-height on the
// right edge; an app can move it with the CSS variables --mm-top / --mm-shift.

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
.mm-hide { display: none !important; }
button.mm-chip { position: fixed; right: 0; top: var(--mm-top, 50%); transform: translateY(var(--mm-shift, -50%)); z-index: 40; display: none;
  flex-direction: column; align-items: center; gap: 6px; padding: 10px 5px 8px; margin: 0;
  border: 1px solid #3a414c; border-right: 0; border-radius: 10px 0 0 10px; background: rgba(18,21,26,.82);
  color: #eef0f3; font: 12px/1.2 system-ui, -apple-system, sans-serif; cursor: pointer; opacity: .72;
  box-shadow: -2px 2px 12px rgba(0,0,0,.4); backdrop-filter: blur(4px); }
button.mm-chip.mm-show { display: flex; }
button.mm-chip:hover:not(:disabled) { opacity: 1; background: rgba(32,37,45,.95); }
button.mm-chip .mm-t { writing-mode: vertical-rl; letter-spacing: .04em; }
button.mm-chip .mm-note { writing-mode: vertical-rl; color: #ffe27a; }
button.mm-chip .mm-note:empty { display: none; }
button.mm-chip kbd { background: #2a2f37; border: 1px solid #3a414c; border-radius: 4px; padding: 0 4px; font-size: 11px; }
button.mm-collapse, button.mm-collapse:hover:not(:disabled) { margin: 6px; width: 28px; height: 28px; padding: 0;
  background: #fff; color: #444; border: 0; border-radius: 4px; box-shadow: 0 1px 4px rgba(0,0,0,.3);
  font: 600 15px/28px system-ui, sans-serif; cursor: pointer; }
button.mm-collapse:hover:not(:disabled) { color: #000; }`;
  document.head.appendChild(st);
}

const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M1.5 3.5l4-1.5 5 2 4-1.5v10l-4 1.5-5-2-4 1.5z"/><path d="M5.5 2v10M10.5 4v10"/></svg>';

export class Minimap {
  constructor({ storageKey, targets = {}, label = 'Map', key = 'M', onChange = null, onExpand = null }) {
    injectCss();
    Object.assign(this, { storageKey, targets, key, onChange, onExpand });
    this.maps = []; this.phase = null; this._pending = null;
    try { this.state = JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { this.state = {}; }
    const chip = this.chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mm-chip';
    chip.title = `Show the map (${key})`;
    chip.innerHTML = `${ICON}<span class="mm-t">${label}</span><span class="mm-note"></span><kbd>${key}</kbd>`;
    chip.addEventListener('click', e => { e.stopPropagation(); this.expand(); });
    document.body.appendChild(chip);
    this._apply();
  }

  attachMap(map) {
    this.maps.push(map);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mm-collapse';
    b.title = `Collapse the map to the side (${this.key})`;
    b.textContent = '⇥';
    b.addEventListener('click', e => { e.stopPropagation(); this.collapse(); });
    map.controls[google.maps.ControlPosition.TOP_RIGHT].push(b);
  }

  get collapsed() { return !!(this.phase && this.state[this.phase]); }
  setPhase(p) { this.phase = this.targets[p] ? p : null; this._pending = null; this._apply(); }
  toggle() { if (!this.phase) return false; this.set(!this.collapsed); return true; }
  collapse() { this.set(true); }
  expand() { this.set(false); }
  set(c) {
    if (!this.phase) return;
    const was = this.collapsed;
    this.state[this.phase] = !!c;
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.state)); } catch {}
    this._apply();
    if (was && !c) this._expanded();
  }
  /** Short text on the tab while collapsed (e.g. "pin placed"). */
  setNote(t) { this.chip.querySelector('.mm-note').textContent = t || ''; }

  /** Run a camera fit once the map is visible (now, or on the next expand); never again after that. */
  fitOnce(fn, delay = 250) {
    if (this.collapsed) { this._pending = fn; return; }
    this._pending = null;
    setTimeout(fn, delay);
  }

  _apply() {
    const c = this.collapsed, hide = c ? this.targets[this.phase] : null;
    for (const el of new Set(Object.values(this.targets))) el?.classList.toggle('mm-hide', el === hide);
    document.body.classList.toggle('mm-collapsed', c);
    this.chip.classList.toggle('mm-show', c);
    this.onChange?.(c, this.phase);
  }
  _expanded() {
    requestAnimationFrame(() => {
      for (const m of this.maps) google.maps.event.trigger(m, 'resize');
      this.onExpand?.(this.phase);
      const f = this._pending;
      this._pending = null;
      if (f) setTimeout(f, 60);
    });
  }
}
