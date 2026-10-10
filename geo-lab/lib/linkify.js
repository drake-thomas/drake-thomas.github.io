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
const CONNECT = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'of', 'the', 'and', 'do', 'da', 'dos', 'das', 'di', 'du', 'des', 'e', 'y', 'an', 'al', 'ad', 'bin', 'van', 'von', 'au', 'aux']);
const LEADERS = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'from', 'to', 'its', 'this', 'that', 'like', 'near', 'and', 'or', 'of', 'with', 'into', 'across', 'beyond', 'past', 'along', 'unlike', 'both', 'lake', 'mount']);
const sentenceStart = (text, idx) => /(^|[.!?]\s+|[:;(]\s*)$/.test(text.slice(Math.max(0, idx - 3), idx));
const TYPE_WORDS = new Set(['island', 'islands', 'bay', 'gulf', 'sea', 'lake', 'lakes', 'river', 'mountains', 'mountain', 'range',
  'desert', 'peninsula', 'plateau', 'reservoir', 'strait', 'basin', 'delta', 'lagoon', 'valley', 'plain', 'glacier', 'ice', 'sound', 'canyon']);
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
    this.shortForm = new Set();  // keys that exist only as a type-word-stripped alias ("nile" from "Nile River")
    const add = (name, f, short = false) => {
      const k = norm(name);
      if (k.length < 4 || STOP.has(k)) return;
      if (!this.byName.has(k)) this.byName.set(k, []);
      const arr = this.byName.get(k);
      if (short && !arr.length) this.shortForm.add(k);
      if (!short) this.shortForm.delete(k);
      if (!arr.includes(f)) arr.push(f);
      this.maxWords = Math.max(this.maxWords, k.split(' ').length);
    };
    for (const f of features) {
      for (const n of [f.name, ...(f.aka || [])]) {
        add(n, f);
        add(n.replace(/\s*\([^)]*\)\s*$/, ''), f);                  // "Laguna Madre (Texas)" -> "Laguna Madre"
        const m = n.match(/^(.{4,}?) (River|Lake|Reservoir|Desert|Mountains|Range|Island)$/i);  // "Nile River" -> "Nile"
        if (m) add(m[1], f, true);
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
    if (!self) return others[0];
    // Ambiguous name: nearest one; but when the name is only a short form of several features
    // ("Kamchatka" for the river and the peninsula), prefer the biggest.
    const best = others.length > 1 && others.every(f => f.name.toLowerCase() !== (this._lastKey || ''))
      ? others.reduce((a, b) => ((a.extent_km || 0) >= (b.extent_km || 0) ? a : b))
      : others.reduce((a, b) => (km(self, a) <= km(self, b) ? a : b));
    // Descriptions mostly mention nearby things; a lone match thousands of km away is usually a namesake
    // (Montserrat the island vs Montserrat in Spain), unless either feature is continent-sized.
    const reach = Math.max(2500, 1.5 * ((best.extent_km || 0) + (self.extent_km || 0)));
    return km(self, best) <= reach ? best : null;
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
        // Feature names are proper nouns. Link only when: every significant word is capitalized ("Long island" no);
        // the span isn't glued to other capitalized words ("British Columbia", "Fort Simpson", "Barren Lands");
        // and a type-stripped short form ("Alaska" from "Alaska Range") is introduced by "the" ("the Mississippi").
        const capOk = span.split(/[\s-]+/).every(w => /^\p{Lu}/u.test(w) || CONNECT.has(w.toLowerCase()));
        const prev = i > 0 ? words[i - 1] : null, nextW = words[i + n];
        const between = (x, y) => text.slice(x.index + x[0].length, y.index);
        const glued = (prev && /^\p{Lu}/u.test(prev[0]) && !LEADERS.has(prev[0].toLowerCase()) && /^[\s-]$/.test(between(prev, a)) && !sentenceStart(text, prev.index))
          || (nextW && /^\p{Lu}/u.test(nextW[0]) && /^[\s-]$/.test(between(b, nextW)));
        const shortOk = !this.shortForm.has(k) || (prev && prev[0].toLowerCase() === 'the');
        const fs = capOk && !glued && shortOk ? this.byName.get(k) : null;
        this._lastKey = this.shortForm.has(k) ? '\u0000' : k;  // exact-name matches keep the nearest-wins rule
        // A short name followed by a type word ("Baffin" + "Island") is a different feature: don't link the fragment.
        const nextWord = words[i + n]?.[0]?.toLowerCase();
        if (fs && nextWord && TYPE_WORDS.has(nextWord) && !this.byName.has(norm(span + ' ' + nextWord))) { hit = { n: n + 1, skip: true }; break; }
        if (fs) {
          const f = this._pickFeature(fs, self);
          if (f && !usedF.has(f.id)) hit = { n, span, html: `<a class="flink" data-fid="${esc(f.id)}" title="${esc(f.name)}">${esc(span)}</a>`, mark: () => usedF.add(f.id) };
          else if (f) hit = { n, skip: true };
        }
        if (!hit) {
          // jargon is used generically, so a capitalized span ("Puna", the Hawaii district) isn't a glossary term
          const lowerOk = !/^\p{Lu}/u.test(span) || sentenceStart(text, a.index);
          const t = lowerOk && (this.gloss.get(k) || this.gloss.get(k.replace(/(es|s)$/, '')) || this.gloss.get(k.replace(/s$/, '')));
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
