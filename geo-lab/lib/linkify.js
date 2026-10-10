// Turn feature descriptions into hypertext:
//  - names of other features become links that fly to and select that feature;
//  - geography jargon (wadi, thermokarst, erg...) becomes a link that opens the Wikipedia panel.
//
//   const lk = new Linkifier(features, glossary);     // glossary: { term: 'Wikipedia title' }
//   el.innerHTML = lk.html(text, selfFeature);         // links carry data-fid / data-wiki
//   lk.bind(el, { onFeature: f => ..., onTerm: title => ... });

const STOP = new Set(['orange', 'white', 'black', 'blue', 'green', 'yellow', 'red', 'grand', 'great', 'little', 'big',
  'north', 'south', 'east', 'west', 'central', 'salt', 'pink', 'golden', 'silver', 'long', 'deep', 'dry', 'high', 'new',
  'snake', 'pearl', 'paradise', 'victoria', 'georgia', 'jordan', 'chad', 'niger', 'congo', 'guinea', 'sudan', 'lake', 'river',
  'island', 'islands', 'mountain', 'mountains', 'desert', 'bay', 'gulf', 'sea', 'ocean', 'plain', 'plateau', 'range', 'valley']);
const norm = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ').trim();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const km = (a, b) => {
  const R = Math.PI / 180, dLat = (b.lat - a.lat) * R, dLng = (b.lng - a.lng) * R;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

export class Linkifier {
  constructor(features, glossary = {}) {
    this.byName = new Map();  // normalized name -> [features]
    this.maxWords = 1;
    const add = (name, f) => {
      const k = norm(name);
      if (k.length < 4 || STOP.has(k)) return;
      if (!this.byName.has(k)) this.byName.set(k, []);
      const arr = this.byName.get(k);
      if (!arr.includes(f)) arr.push(f);
      this.maxWords = Math.max(this.maxWords, k.split(' ').length);
    };
    for (const f of features) {
      for (const n of [f.name, ...(f.aka || [])]) {
        add(n, f);
        add(n.replace(/\s*\([^)]*\)\s*$/, ''), f);                  // "Laguna Madre (Texas)" -> "Laguna Madre"
        const m = n.match(/^(.{4,}?) (River|Lake|Reservoir|Desert|Mountains|Range|Island)$/i);  // "Nile River" -> "Nile"
        if (m) add(m[1], f);
      }
    }
    this.gloss = new Map();
    for (const [term, title] of Object.entries(glossary)) {
      const k = norm(term);
      this.gloss.set(k, title);
      this.maxWords = Math.max(this.maxWords, k.split(' ').length);
    }
  }

  _pickFeature(cands, self) {
    const others = cands.filter(f => f !== self && f.id !== self?.id);
    if (!others.length) return null;
    if (!self || others.length === 1) return others[0];
    return others.reduce((a, b) => (km(self, a) <= km(self, b) ? a : b));  // ambiguous name: nearest one
  }

  html(text, self) {
    if (!text) return '';
    const words = [...text.matchAll(/[\p{L}\p{M}0-9][\p{L}\p{M}0-9'’-]*/gu)];
    const selfNames = new Set(self ? [self.name, ...(self.aka || [])].map(norm) : []);
    const usedF = new Set(), usedT = new Set();
    let out = '', pos = 0, i = 0;
    while (i < words.length) {
      let hit = null;
      for (let n = Math.min(this.maxWords, words.length - i); n >= 1 && !hit; n--) {
        const a = words[i], b = words[i + n - 1];
        const span = text.slice(a.index, b.index + b[0].length);
        if (/[.;:!?()]/.test(span)) continue;  // don't run across sentence punctuation
        const k = norm(span);
        if (selfNames.has(k)) { hit = { n, skip: true }; break; }
        const fs = this.byName.get(k);
        if (fs) {
          const f = this._pickFeature(fs, self);
          if (f && !usedF.has(f.id)) hit = { n, span, html: `<a class="flink" data-fid="${esc(f.id)}" title="${esc(f.name)}">${esc(span)}</a>`, mark: () => usedF.add(f.id) };
          else if (f) hit = { n, skip: true };
        }
        if (!hit) {
          const t = this.gloss.get(k) || this.gloss.get(k.replace(/(es|s)$/, '')) || this.gloss.get(k.replace(/s$/, ''));
          if (t && !usedT.has(t)) hit = { n, span, html: `<a class="glink" data-wiki="${esc(t)}" title="What is ${esc(t)}?">${esc(span)}</a>`, mark: () => usedT.add(t) };
        }
      }
      if (hit && !hit.skip) {
        const a = words[i], b = words[i + hit.n - 1];
        out += esc(text.slice(pos, a.index)) + hit.html;
        pos = b.index + b[0].length;
        hit.mark();
        i += hit.n;
      } else {
        i += hit?.skip ? hit.n : 1;
      }
    }
    return out + esc(text.slice(pos));
  }

  bind(el, { onFeature, onTerm }) {
    el.querySelectorAll('a.flink').forEach(a => a.onclick = e => { e.preventDefault(); onFeature?.(a.dataset.fid); });
    el.querySelectorAll('a.glink').forEach(a => a.onclick = e => { e.preventDefault(); onTerm?.(a.dataset.wiki); });
  }
}
