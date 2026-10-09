// Compact spaced repetition (SM-2 flavored) persisted per deck in localStorage.
//
//   const srs = new SRS('craters', ids, { newPerDay: 10 });
//   const id = srs.next();          // what to show now (or null)
//   srs.grade(id, 2);               // 0 again, 1 hard, 2 good, 3 easy
//   srs.stats()                     // { new, learning, young, mature, due }
//
// Failed cards come back a few cards later in the same session; successful
// ones get days-scale intervals that grow with an ease factor.
const DAY = 86400e3, RELEARN_GAP = 3;

export const GRADES = ['Again', 'Hard', 'Good', 'Easy'];

export class SRS {
  constructor(deck, ids, { newPerDay = 10, storage = window.localStorage } = {}) {
    this.key = `geolab.srs.${deck}`;
    this.ids = ids;  // deck order = introduction order for new cards
    this.newPerDay = newPerDay;
    this.storage = storage;
    this.data = this._load();
    this.sessionQueue = [];  // [{id, after}] failed cards to re-show
    this.shown = 0;
    this.lastId = null;
  }

  _load() {
    try { return JSON.parse(this.storage.getItem(this.key)) || { cards: {}, days: {} }; }
    catch { return { cards: {}, days: {} }; }
  }
  _save() { try { this.storage.setItem(this.key, JSON.stringify(this.data)); } catch {} }

  _today() { return new Date().toISOString().slice(0, 10); }
  newToday() { return this.data.days[this._today()] || 0; }

  card(id) { return this.data.cards[id]; }

  next({ now = Date.now(), allowExtra = true } = {}) {
    // 1. failed-in-session cards whose gap has elapsed
    const q = this.sessionQueue.findIndex(x => x.after <= this.shown && x.id !== this.lastId);
    if (q >= 0) return this.sessionQueue.splice(q, 1)[0].id;
    // 2. due reviews, most overdue first
    const due = this.ids.filter(id => { const c = this.data.cards[id]; return c && c.due <= now && id !== this.lastId; })
      .sort((a, b) => this.data.cards[a].due - this.data.cards[b].due);
    if (due.length) return due[0];
    // 3. new cards, up to the daily cap
    if (this.newToday() < this.newPerDay) {
      const fresh = this.ids.find(id => !this.data.cards[id]);
      if (fresh) return fresh;
    }
    // 4. queued relearns even if the gap hasn't elapsed
    if (this.sessionQueue.length) return this.sessionQueue.shift().id;
    if (!allowExtra) return null;
    return null;
  }

  /** Best guess at what next() will return after the current card is graded (no side effects). */
  peek(excludeId, now = Date.now()) {
    const q = this.sessionQueue.find(x => x.after <= this.shown + 1 && x.id !== excludeId);
    if (q) return q.id;
    const due = this.ids.filter(id => { const c = this.data.cards[id]; return c && c.due <= now && id !== excludeId; })
      .sort((a, b) => this.data.cards[a].due - this.data.cards[b].due);
    if (due.length) return due[0];
    const newAfter = this.newToday() + (this.data.cards[excludeId] ? 0 : 1);
    if (newAfter < this.newPerDay) return this.ids.find(id => !this.data.cards[id] && id !== excludeId) || null;
    return null;
  }

  /** Extra practice when nothing is due: weakest seen cards first, with some randomness. */
  extra() {
    const seen = this.ids.filter(id => this.data.cards[id] && id !== this.lastId);
    if (!seen.length) return null;
    seen.sort((a, b) => this._weak(b) - this._weak(a));
    return seen[Math.floor(Math.random() * Math.min(5, seen.length))];
  }
  _weak(id) { const c = this.data.cards[id]; return (c.lapses + 1) / (c.ivl + 1) + Math.random() * 0.3; }

  grade(id, g, now = Date.now()) {
    let c = this.data.cards[id];
    if (!c) {
      c = this.data.cards[id] = { ivl: 0, ease: 2.5, reps: 0, lapses: 0, due: now, seen: 0 };
      this.data.days[this._today()] = this.newToday() + 1;
    }
    c.seen++; c.last = now;
    if (g === 0) {
      c.lapses += c.reps > 0 ? 1 : 0;
      c.reps = 0; c.ivl = 0;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.due = now + 10 * 60e3;
      this.sessionQueue.push({ id, after: this.shown + RELEARN_GAP });
    } else {
      if (c.reps === 0) c.ivl = [0, 0.5, 1, 3][g];
      else if (c.reps === 1) c.ivl = [0, 2, 4, 7][g];
      else c.ivl = Math.max(c.ivl + 1, c.ivl * c.ease * [0, 0.7, 1, 1.35][g]);
      c.ease = Math.max(1.3, c.ease + [0, -0.15, 0, 0.1][g]);
      c.reps++;
      c.due = now + c.ivl * DAY * (0.95 + Math.random() * 0.1);  // fuzz so cards don't clump
    }
    this.shown++;
    this.lastId = id;
    this._save();
  }

  stats(now = Date.now()) {
    let n = 0, learning = 0, young = 0, mature = 0, due = 0;
    for (const id of this.ids) {
      const c = this.data.cards[id];
      if (!c) { n++; continue; }
      if (c.due <= now) due++;
      if (c.reps === 0) learning++; else if (c.ivl < 21) young++; else mature++;
    }
    return { new: n, learning, young, mature, due, newToday: this.newToday(), newPerDay: this.newPerDay };
  }

  export() { return JSON.stringify(this.data); }
  import(json) { this.data = JSON.parse(json); this._save(); }
  reset() { this.data = { cards: {}, days: {} }; this._save(); }
}
