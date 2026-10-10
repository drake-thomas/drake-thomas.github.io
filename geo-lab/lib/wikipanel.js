// A right-hand slide-out panel that explains a term or feature from Wikipedia:
// the full article (mobile skin) in an iframe, with a Back button.
// The frame is cross-origin, so we can't read its URL; but the host pages only ever replaceState, so every
// joint-history entry made while the panel is open is a frame navigation (a link clicked inside it, or a new
// term opened from a card). We count those and let Back step through them with history.back(), never further.
//
//   import { openWiki } from '../../lib/wikipanel.js';
//   openWiki('Thermokarst');

let panel = null;
let depth = 0, loads = 0, goingBack = false, ours = false, ourTitle = '';
const titles = [];  // title shown at each history depth
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function ensure() {
  if (panel) return panel;
  panel = document.createElement('aside');
  panel.className = 'wikipanel';
  panel.innerHTML = `<div class="wp-head"><button class="wp-back" title="Back" disabled>‹ Back</button><b class="wp-title"></b><a class="wp-open btn" target="_blank" rel="noopener">Open ↗</a><button class="wp-close" title="Close (Esc)">✕</button></div>
<iframe class="wp-frame" referrerpolicy="no-referrer" loading="lazy"></iframe>`;
  document.body.appendChild(panel);
  panel.querySelector('.wp-close').onclick = closeWiki;
  const back = panel.querySelector('.wp-back');
  panel.querySelector('.wp-frame').addEventListener('load', () => {
    loads++;
    if (goingBack) { goingBack = false; p_title(titles[depth] || 'Wikipedia'); }
    else {
      if (loads > 1) depth++;  // the first load replaces about:blank and adds no history entry
      titles[depth] = ours ? ourTitle : 'Wikipedia';  // after an in-frame click we can't know the article's name
      titles.length = depth + 1;
      p_title(titles[depth]);
    }
    ours = false;
    back.disabled = depth === 0;
  });
  back.onclick = () => {
    if (depth === 0) return;
    depth--; goingBack = true; back.disabled = depth === 0;
    history.back();
  };
  addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) { e.stopPropagation(); closeWiki(); } }, true);
  return panel;
}

function p_title(t) { if (panel) panel.querySelector('.wp-title').textContent = t; }

export function closeWiki() { panel?.classList.remove('open'); }

export async function openWiki(title) {
  const p = ensure();
  const page = title.replace(/ /g, '_');
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(page)}`;
  p.querySelector('.wp-title').textContent = title;
  ours = true; ourTitle = title;
  p.querySelector('.wp-open').href = url;
  p.querySelector('.wp-frame').src = `${url}?useskin=minerva`;
  p.classList.add('open');
}
