// Loads the Google Maps JS API once (key from /config.js -> window.GMAPS_KEY).
let loading = null;

export function loadMaps() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (!window.GMAPS_KEY) return reject(new Error('No GMAPS_KEY: create /config.js'));
    window.gm_authFailure = () => reject(new Error('Google Maps rejected the API key'));
    window.__mapsReady = () => resolve(window.google.maps);
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(window.GMAPS_KEY)}` +
      '&callback=__mapsReady&loading=async&v=weekly&libraries=geometry';
    s.async = true;
    s.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(s);
  });
  return loading;
}

export async function loadJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
