// Card source lists: a readable title and a small icon for the kind of reference, not just the host name.
//
//   import { sourceListHtml, bindSources } from '../../lib/sources.js';
//   el.innerHTML = sourceListHtml(f.sources, titles);   // titles: {url: {t, k}} from features.json "source_titles"
//   bindSources(el, { onWiki: (title, lang) => openWiki(title, lang) });
//
// Wikipedia, OpenStreetMap and plain-text dataset notes are labelled from the URL/text itself; papers, agency pages
// and databases get titles resolved at build time by tools/source_titles.py.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svg = (body, label) => `<svg class="src-ic" viewBox="0 0 16 16" aria-label="${label}" role="img">${body}</svg>`;
const ICONS = {
  wikipedia: svg('<circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" stroke-width="1.2"/><text x="8" y="11.4" text-anchor="middle" font-family="Georgia,serif" font-size="9.5" fill="currentColor">W</text>', 'Wikipedia'),
  osm: svg('<path d="M8 1.5c-2.6 0-4.6 2-4.6 4.5 0 3.4 4.6 8.5 4.6 8.5s4.6-5.1 4.6-8.5c0-2.5-2-4.5-4.6-4.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="6" r="1.6" fill="currentColor"/>', 'OpenStreetMap'),
  paper: svg('<path d="M4 1.5h5.5L12.5 4.5v10h-8.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 7.5h4.5M6 9.7h4.5M6 11.9h3" stroke="currentColor" stroke-width="1"/>', 'Paper'),
  agency: svg('<path d="M2 6.2 8 2.5l6 3.7zM3.2 7.2v5.3M6.4 7.2v5.3M9.6 7.2v5.3M12.8 7.2v5.3M2 13.5h12" fill="none" stroke="currentColor" stroke-width="1.2"/>', 'Agency or survey'),
  database: svg('<ellipse cx="8" cy="3.8" rx="5" ry="1.9" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 3.8v8.4c0 1 2.2 1.9 5 1.9s5-.9 5-1.9V3.8M3 8c0 1 2.2 1.9 5 1.9s5-.9 5-1.9" fill="none" stroke="currentColor" stroke-width="1.2"/>', 'Database'),
  dataset: svg('<path d="M8 2 14 5 8 8 2 5zM2 8l6 3 6-3M2 11l6 3 6-3" fill="none" stroke="currentColor" stroke-width="1.2"/>', 'Dataset'),
  news: svg('<rect x="2" y="3" width="12" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 6h7M4.5 8.3h7M4.5 10.6h4" stroke="currentColor" stroke-width="1"/>', 'News'),
  web: svg('<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M1.8 8h12.4M8 1.8c2 2 2 10.4 0 12.4M8 1.8c-2 2-2 10.4 0 12.4" fill="none" stroke="currentColor" stroke-width="1"/>', 'Web page'),
};
const KIND_LABEL = { paper: 'Paper', agency: 'Agency', database: 'Database', news: 'News', web: 'Web', dataset: 'Dataset', osm: 'OpenStreetMap', wikipedia: 'Wikipedia' };
const LANG = { de: 'German', ru: 'Russian', es: 'Spanish', pt: 'Portuguese', zh: 'Chinese', fr: 'French', ja: 'Japanese', fa: 'Persian',
  sv: 'Swedish', no: 'Norwegian', tr: 'Turkish', it: 'Italian', pl: 'Polish', fi: 'Finnish', nl: 'Dutch', is: 'Icelandic', mn: 'Mongolian', kk: 'Kazakh' };

export function describeSource(u, titles = {}) {
  const t = String(u ?? '').trim();
  if (!/^https?:\/\//.test(t)) {
    if (/natural earth/i.test(t)) return { kind: 'dataset', title: 'Natural Earth', sub: 'outline data', key: 'natural-earth' };
    if (/^openstreetmap$/i.test(t)) return { kind: 'osm', title: 'OpenStreetMap', sub: 'outline data', key: 'osm-text' };
    return { kind: 'dataset', title: t.length > 60 ? t.slice(0, 60) + '…' : t, key: t };
  }
  let url; try { url = new URL(t); } catch { return { kind: 'web', title: t, href: t, key: t }; }
  const host = url.hostname.replace(/^www\./, '');
  const wiki = host.match(/^([a-z-]+)\.(?:m\.)?wikipedia\.org$/);
  if (wiki && url.pathname.startsWith('/wiki/')) {
    const title = decodeURIComponent(url.pathname.slice(6)).replace(/_/g, ' ');
    const lang = wiki[1];
    return { kind: 'wikipedia', title, sub: lang === 'en' ? '' : `${LANG[lang] || lang} Wikipedia`, href: t, wiki: { title, lang }, key: t };
  }
  const osm = host === 'openstreetmap.org' && url.pathname.match(/^\/(relation|way|node)\/(\d+)/);
  if (osm) return { kind: 'osm', title: 'OpenStreetMap outline', sub: `${osm[1]} ${osm[2]}`, href: t, key: t };
  const m = titles[t];
  if (m && m.t && !/^[\w.-]+\.\w+$/.test(m.t)) return { kind: m.k || 'web', title: m.t, sub: host, href: t, key: t };
  const kind = m?.k || 'web';
  return { kind, title: `${KIND_LABEL[kind]} · ${host}`, href: t, key: t };
}

export function sourceListHtml(sources, titles = {}, { max = 5 } = {}) {
  const seen = new Set(), items = [];
  for (const s of sources || []) {
    const d = describeSource(s, titles);
    if (seen.has(d.key)) continue;
    seen.add(d.key); items.push(d);
  }
  if (!items.length) return '';
  // references first, outline-data provenance last
  items.sort((a, b) => (a.kind === 'dataset' || a.sub === 'outline data') - (b.kind === 'dataset' || b.sub === 'outline data'));
  const li = d => {
    const inner = `${ICONS[d.kind] || ICONS.web}<span class="src-t">${esc(d.title)}</span>${d.sub ? `<span class="src-sub">${esc(d.sub)}</span>` : ''}`;
    const attrs = d.wiki ? ` data-wiki="${esc(d.wiki.title)}" data-lang="${esc(d.wiki.lang)}"` : '';
    return `<li class="src-${d.kind}">${d.href ? `<a href="${esc(d.href)}" target="_blank" rel="noopener"${attrs} title="${esc(d.href)}">${inner}</a>` : `<span>${inner}</span>`}</li>`;
  };
  const shown = items.slice(0, max), rest = items.slice(max);
  return `<ul class="srcs">${shown.map(li).join('')}${rest.length ? `<li class="src-more"><details><summary>${rest.length} more</summary><ul class="srcs">${rest.map(li).join('')}</ul></details></li>` : ''}</ul>`;
}

export function bindSources(el, { onWiki } = {}) {
  if (!onWiki) return;
  el.querySelectorAll('a[data-wiki]').forEach(a => a.onclick = e => { e.preventDefault(); onWiki(a.dataset.wiki, a.dataset.lang); });
}
