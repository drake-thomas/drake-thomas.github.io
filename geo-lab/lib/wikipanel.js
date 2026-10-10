// A right-hand slide-out panel that explains a term or feature from Wikipedia:
// summary card (REST API) on top, the full article (mobile skin, in an iframe) below.
//
//   import { openWiki } from '../../lib/wikipanel.js';
//   openWiki('Thermokarst');

let panel = null;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ensure() {
  if (panel) return panel;
  panel = document.createElement('aside');
  panel.className = 'wikipanel';
  panel.innerHTML = `<div class="wp-head"><b class="wp-title"></b><a class="wp-open btn" target="_blank" rel="noopener">Open ↗</a><button class="wp-close" title="Close (Esc)">✕</button></div>
    <div class="wp-summary"></div><iframe class="wp-frame" referrerpolicy="no-referrer" loading="lazy"></iframe>`;
  document.body.appendChild(panel);
  panel.querySelector('.wp-close').onclick = closeWiki;
  addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) { e.stopPropagation(); closeWiki(); } }, true);
  return panel;
}

export function closeWiki() { panel?.classList.remove('open'); }

export async function openWiki(title) {
  const p = ensure();
  const page = title.replace(/ /g, '_');
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}`;
  p.querySelector('.wp-title').textContent = title;
  p.querySelector('.wp-open').href = url;
  p.querySelector('.wp-summary').innerHTML = '<span class="muted small">Loading…</span>';
  p.querySelector('.wp-frame').src = `${url}?useskin=minerva`;
  p.classList.add('open');
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}`);
    const j = await r.json();
    p.querySelector('.wp-title').textContent = j.title || title;
    p.querySelector('.wp-summary').innerHTML =
      (j.thumbnail ? `<img src="${esc(j.thumbnail.source)}" alt="">` : '') +
      `<div>${esc(j.extract || '')}</div>`;
  } catch {
    p.querySelector('.wp-summary').innerHTML = '';
  }
}
