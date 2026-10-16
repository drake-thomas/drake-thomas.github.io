// Web Worker wrapper around the orientation optimizer core.
import { searchOrientation } from './optimize-core.js';

self.onmessage = (ev) => {
  if (ev.data.type !== 'run') return;
  try { searchOrientation(ev.data, (m) => postMessage(m)); } catch (e) { postMessage({ type: 'error', message: e.message }); }
};
