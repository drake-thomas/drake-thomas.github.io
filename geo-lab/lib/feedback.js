// Shared feedback plumbing (explorer corrections, review verdicts).
// Locally the dev server (tools/dev/serve.py) stores items in data/feedback/*.jsonl; on the site they go to the feedback
// Worker (tools/feedback_worker), pulled into data/feedback/ by tools/feedback_pull.py. Items that fail to send are
// queued in localStorage (FB_KEY) by the caller, to be re-sent, edited or copied.
export const FB_KEY = 'geolab.feedback.queue', FB_NAME = 'geolab.feedback.name', FB_OWNER = 'geolab.feedback.key';
export const FB_URL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? new URL('../api/feedback', import.meta.url).href
  : 'https://geolab-feedback.grahamsnumberisbig.workers.dev/feedback';
export const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// ?fbkey=… (given to the site owner) marks this browser's feedback as verified; stripped from the URL once stored.
(() => {
  const u = new URL(location.href), k = u.searchParams.get('fbkey');
  if (k) { lsSet(FB_OWNER, k); u.searchParams.delete('fbkey'); history.replaceState(null, '', u); }
})();

// -> 'ok' | 'limited' (rate limited) | 'fail'
export async function fbPost(item) {
  try {
    const r = await fetch(FB_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...item, name: lsGet(FB_NAME) || item.name || '', key: lsGet(FB_OWNER) || undefined }) });
    return r.ok ? 'ok' : r.status === 429 ? 'limited' : 'fail';
  } catch { return 'fail'; }
}
export const fbQueue = () => { try { return JSON.parse(localStorage.getItem(FB_KEY) || '[]'); } catch { return []; } };
export const fbSave = q => { try { localStorage.setItem(FB_KEY, JSON.stringify(q)); } catch {} };
