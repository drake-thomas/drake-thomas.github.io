// Pareto study viewer: reads data/study.jsonl (streamed by tools/study.mjs) and plots
// land-cut vs distortion small multiples with Pareto frontiers.
/* global d3 */

const MODES = [
  { id: 'gnomonic', label: 'Gnomonic', color: 'var(--series-1)', symbol: d3.symbolCircle },
  { id: 'fuller', label: 'Arc-linear', color: 'var(--series-2)', symbol: d3.symbolSquare },
  { id: 'equal', label: 'Equal-area', color: 'var(--series-3)', symbol: d3.symbolTriangle },
];
const MODE = Object.fromEntries(MODES.map((m) => [m.id, m]));

const METRICS = [
  { id: 'airy', title: 'Overall scale distortion', desc: 'Airy–Kavrayskiy measure: RMS of ln(scale) over the sphere', fmt: '.3f' },
  { id: 'angMean', title: 'Mean angular distortion', desc: 'Mean maximum angular deformation ω, degrees', fmt: '.2f', unit: '°' },
  { id: 'ang95', title: 'Worst-case angular distortion', desc: '95th percentile of ω, degrees', fmt: '.1f', unit: '°' },
  { id: 'areaRms', title: 'Areal distortion', desc: 'RMS of ln(area scale); 0 = equal-area (drawn on the floor in log view)', fmt: '.3f', floor: 1e-3 },
  { id: 'areaRatio', title: 'Area scale range', desc: 'Largest ÷ smallest area scale (99th / 1st pct), as % excess over 1', fmt: '.1f', unit: '%', floor: 0.1,
    value: (r) => (r.areaRatio - 1) * 100 },
  { id: 'landAiry', title: 'Scale distortion over land', desc: 'Airy–Kavrayskiy measure on land points only (depends on orientation)', fmt: '.3f' },
  { id: 'cutKm', title: 'Interruptions', desc: 'Total length of all cut edges, km', fmt: ',.0f', unit: ' km' },
];
const XLABEL = { landKm: 'Land crossed by cuts (km)', cutKm: 'Total cut length (km)', F: 'Number of faces' };

const state = { x: 'landKm', xScale: 'symlog', yScale: 'log', front: 'mode', family: '', modesOn: new Set(MODES.map((m) => m.id)), hover: null, rows: [], lineCount: 0, sort: { key: 'landKm', dir: 1 } };
const $ = (id) => document.getElementById(id);
const tip = $('tip');

// ---------------------------------------------------------------- data
async function load() {
  try {
    const txt = await fetch('data/study.jsonl', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : ''));
    const lines = txt.split('\n').filter((l) => l.trim());
    if (lines.length === state.lineCount) return;
    state.lineCount = lines.length;
    state.rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const fams = [...new Set(state.rows.map((r) => r.family))];
    const fs = $('famSel'), cur = fs.value;
    fs.innerHTML = '<option value="">all families</option>' + fams.map((f) => `<option>${f}</option>`).join('');
    fs.value = fams.includes(cur) ? cur : '';
    const polys = new Set(state.rows.map((r) => r.id)).size;
    $('status').textContent = state.rows.length ? `${polys} polyhedra × ${MODES.length} projections` : 'No results yet — run tools/study.mjs';
    render();
  } catch (e) {
    $('status').textContent = 'Could not load data/study.jsonl';
  }
}

function visibleRows() {
  return state.rows.filter((r) => state.modesOn.has(r.mode) && (!state.family || r.family === state.family));
}

/** Points not dominated in (x, y), both minimized. */
function paretoFront(pts, x, y) {
  const s = pts.filter((p) => isFinite(p[x]) && isFinite(p[y])).sort((a, b) => a[x] - b[x] || a[y] - b[y]);
  const out = [];
  let best = Infinity;
  for (const p of s) if (p[y] < best - 1e-12) { out.push(p); best = p[y]; }
  return out;
}

// ---------------------------------------------------------------- legend / controls
function buildLegend() {
  const lg = $('legend');
  lg.innerHTML = '';
  for (const m of MODES) {
    const b = document.createElement('button');
    b.className = state.modesOn.has(m.id) ? '' : 'off';
    b.setAttribute('aria-pressed', state.modesOn.has(m.id));
    b.title = 'Show / hide ' + m.label;
    b.innerHTML = `<svg width="12" height="12" viewBox="-6 -6 12 12"><path d="${d3.symbol(m.symbol, 64)()}" fill="${m.color}"></path></svg>${m.label}`;
    b.onclick = () => {
      if (state.modesOn.has(m.id)) { if (state.modesOn.size > 1) state.modesOn.delete(m.id); } else state.modesOn.add(m.id);
      buildLegend(); render();
    };
    lg.appendChild(b);
  }
}
$('xSel').onchange = (e) => { state.x = e.target.value; render(); };
$('xScale').onchange = (e) => { state.xScale = e.target.value; render(); };
$('yScale').onchange = (e) => { state.yScale = e.target.value; render(); };
$('frontSel').onchange = (e) => { state.front = e.target.value; render(); };
$('famSel').onchange = (e) => { state.family = e.target.value; render(); };

// ---------------------------------------------------------------- charts
const W = 460, H = 320, M = { top: 14, right: 16, bottom: 40, left: 54 };

function render() {
  const rows = visibleRows();
  const grid = $('grid');
  grid.innerHTML = '';
  const metrics = METRICS.filter((m) => m.id !== state.x);
  for (const met of metrics) grid.appendChild(panel(rows, met));
  renderTable(rows);
}

function xScaleFor(rows) {
  const xs = rows.map((r) => r[state.x]);
  const max = d3.max(xs) || 1;
  if (state.xScale === 'symlog') {
    const c = state.x === 'F' ? 10 : 500;
    return d3.scaleSymlog().constant(c).domain([0, max * 1.08]).range([M.left, W - M.right]);
  }
  return d3.scaleLinear().domain([0, max * 1.05]).nice().range([M.left, W - M.right]);
}

function panel(rows, met) {
  const div = document.createElement('div');
  div.className = 'panel';
  div.innerHTML = `<h2>${met.title}</h2><p>${met.desc}</p>`;
  const svg = d3.select(div).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `${met.title} versus ${XLABEL[state.x]}`);
  const val = met.value || ((r) => r[met.id]);
  const data = rows.filter((r) => isFinite(val(r))).map((r) => ({ ...r, _y: val(r) }));
  const x = xScaleFor(data.length ? data : rows);
  const yv = data.map((r) => r._y);
  const yMax = d3.max(yv) || 1;
  let y;
  if (state.yScale === 'log') {
    const pos = yv.filter((v) => v > 0);
    const lo = Math.max(met.floor || 1e-4, (d3.min(pos) || 1) * 0.8);
    y = d3.scaleLog().domain([lo, yMax * 1.25]).range([H - M.bottom, M.top]);
  } else {
    // 'zoom' fits the union of the frontiers; 'linear' fits every point
    let top = yMax;
    if (state.yScale === 'zoom') {
      const groupsZ = state.front === 'mode' ? MODES.map((m) => data.filter((r) => r.mode === m.id)) : [data];
      top = d3.max(groupsZ.flatMap((g) => paretoFront(g, state.x, '_y').map((p) => p._y))) || yMax;
      top = Math.max(top, d3.quantile([...yv].sort(d3.ascending), 0.5) || 0); // always show at least half the points
    }
    y = d3.scaleLinear().domain([0, top * 1.12]).nice().range([H - M.bottom, M.top]);
  }
  const [d0, d1] = y.domain();
  const yc = (v) => y(Math.min(d1, Math.max(d0, v))); // clamp off-scale points to the plot edge
  const clipped = data.filter((r) => r._y > d1).length;
  if (clipped) div.querySelector('p').textContent += ` · ${clipped} point${clipped > 1 ? 's' : ''} above the visible range (pinned to the top)`;

  // grid + axes
  const yTicks = state.yScale === 'log'
    ? [1e-3, 2e-3, 5e-3, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5].filter((t) => t >= d0 && t <= d1)
    : null;
  const yAxis = (ax) => (yTicks ? ax.tickValues(yTicks).tickFormat((v) => (v >= 1000 ? d3.format('~s')(v) : d3.format('~g')(v))) : ax.ticks(5, met.id === 'cutKm' ? '~s' : undefined));
  svg.append('g').attr('class', 'gridline').attr('transform', `translate(${M.left},0)`)
    .call(yAxis(d3.axisLeft(y)).tickSize(-(W - M.left - M.right)).tickFormat(''));
  const xt = state.xScale === 'symlog' && state.x !== 'F' ? [0, 1000, 3000, 10000, 30000, 100000, 300000].filter((t) => t <= x.domain()[1]) : null;
  const xa = d3.axisBottom(x).tickSizeOuter(0);
  if (xt) xa.tickValues(xt);
  xa.tickFormat(state.x === 'F' ? d3.format('d') : (v) => (v >= 1000 ? d3.format('~s')(v).replace('k', 'k') : v));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - M.bottom})`).call(xa);
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${M.left},0)`)
    .call(yAxis(d3.axisLeft(y)).tickSizeOuter(0)).call((g) => g.select('.domain').remove());
  svg.append('text').attr('class', 'axlabel').attr('x', (M.left + W - M.right) / 2).attr('y', H - 6).attr('text-anchor', 'middle').text(XLABEL[state.x]);

  // frontiers
  const groups = state.front === 'mode' ? MODES.filter((m) => state.modesOn.has(m.id)).map((m) => [m, data.filter((r) => r.mode === m.id)]) : [[null, data]];
  const onFront = new Set();
  const step = d3.line().curve(d3.curveStepAfter).x((p) => x(p[state.x])).y((p) => yc(p._y));
  for (const [m, pts] of groups) {
    const fr = paretoFront(pts, state.x, '_y');
    fr.forEach((p) => onFront.add(p));
    if (fr.length) {
      const ext = [...fr, { ...fr[fr.length - 1], [state.x]: x.domain()[1] }];
      svg.append('path').attr('class', 'front').attr('d', step(ext)).attr('stroke', m ? m.color : 'var(--text-secondary)');
    }
  }
  // dots: dominated first, frontier on top
  const sorted = [...data].sort((a, b) => onFront.has(a) - onFront.has(b));
  const key = (r) => r.id + '|' + r.mode;
  svg.append('g').selectAll('path').data(sorted).join('path')
    .attr('class', (r) => 'dot' + (onFront.has(r) ? '' : ' dim') + (state.hover && key(r) === state.hover ? ' hl' : ''))
    .attr('data-key', key)
    .attr('transform', (r) => `translate(${x(r[state.x])},${yc(r._y)})`)
    .attr('d', (r) => d3.symbol(MODE[r.mode].symbol, onFront.has(r) ? 80 : 56)())
    .attr('fill', (r) => MODE[r.mode].color);
  // selective direct labels: frontier points only, skipping ones that would collide
  const placed = [];
  const labels = [...onFront].sort((a, b) => a[state.x] - b[state.x]);
  const lg = svg.append('g');
  for (const r of labels) {
    const right = x(r[state.x]) > W - M.right - 40;
    const px = x(r[state.x]) + (right ? -7 : 7), py = yc(r._y) - 6;
    if (placed.some(([qx, qy]) => Math.abs(qx - px) < 30 && Math.abs(qy - py) < 12)) continue;
    placed.push([px, py]);
    lg.append('text').attr('class', 'flabel').attr('x', px).attr('y', py).attr('text-anchor', right ? 'end' : 'start').text(r.id);
  }
  // hover via nearest point (hit area bigger than the marks)
  const pts = data.map((r) => [x(r[state.x]), yc(r._y), r]);
  const delaunay = d3.Delaunay.from(pts, (p) => p[0], (p) => p[1]);
  svg.append('rect').attr('x', M.left).attr('y', M.top).attr('width', W - M.left - M.right).attr('height', H - M.top - M.bottom)
    .attr('fill', 'transparent').style('cursor', 'pointer')
    .on('pointermove', (ev) => {
      const [mx, my] = d3.pointer(ev);
      const i = delaunay.find(mx, my);
      const p = pts[i];
      if (!p || Math.hypot(p[0] - mx, p[1] - my) > 22) { setHover(null); hideTip(); return; }
      setHover(key(p[2]));
      showTip(ev, p[2], met, onFront.has(p[2]));
    })
    .on('pointerleave', () => { setHover(null); hideTip(); })
    .on('click', (ev) => {
      const [mx, my] = d3.pointer(ev);
      const p = pts[delaunay.find(mx, my)];
      if (p && Math.hypot(p[0] - mx, p[1] - my) <= 22) openInLab(p[2]);
    });
  return div;
}

function setHover(k) {
  if (state.hover === k) return;
  state.hover = k;
  document.querySelectorAll('.dot').forEach((el) => el.classList.toggle('hl', el.getAttribute('data-key') === k));
}

function showTip(ev, r, met, front) {
  const f = (v, fmt) => d3.format(fmt)(v);
  const faces = Object.entries(r.faces).map(([n, c]) => `${c}×${n}-gon`).join(', ');
  tip.innerHTML = `<div class="t">${r.label} · ${MODE[r.mode].label}</div>
    <div class="r"><span>Faces</span><b>${r.F} (${faces})</b></div>
    <div class="r"><span>Land crossed by cuts</span><b>${f(r.landKm, ',')} km</b></div>
    <div class="r"><span>Total cut length</span><b>${f(r.cutKm, ',')} km</b></div>
    ${['cutKm', 'airy', 'angMean'].includes(met.id) ? '' : `<div class="r"><span>${met.title}</span><b>${f(r._y ?? r[met.id], met.fmt)}${met.unit || ''}</b></div>`}
    <div class="r"><span>Scale distortion (Airy)</span><b>${f(r.airy, '.3f')}</b></div>
    <div class="r"><span>Mean angular distortion</span><b>${f(r.angMean, '.2f')}°</b></div>
    <div class="hint">${front ? 'On the Pareto frontier · ' : ''}click to open in the lab</div>`;
  tip.style.display = 'block';
  const bw = tip.offsetWidth, bh = tip.offsetHeight;
  let lx = ev.clientX + 14, ly = ev.clientY + 14;
  if (lx + bw > innerWidth - 8) lx = ev.clientX - bw - 14;
  if (ly + bh > innerHeight - 8) ly = ev.clientY - bh - 14;
  tip.style.left = lx + 'px'; tip.style.top = ly + 'px';
}
function hideTip() { tip.style.display = 'none'; }

function openInLab(r) {
  const payload = { cfg: r.cfg, mode: r.mode, qR: r.qR };
  window.open('index.html#load=' + encodeURIComponent(JSON.stringify(payload)), '_blank');
}

// ---------------------------------------------------------------- table
const COLS = [
  ['id', 'Id'], ['label', 'Polyhedron'], ['mode', 'Projection'], ['F', 'Faces'], ['landKm', 'Land cut km'], ['cutKm', 'Cut length km'],
  ['airy', 'Airy'], ['angMean', 'Mean ω°'], ['ang95', 'ω° p95'], ['areaRms', 'Area RMS ln'], ['areaRatio', 'Area range ×'], ['landAiry', 'Airy (land)'],
];
function renderTable(rows) {
  const { key, dir } = state.sort;
  const sorted = [...rows].sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : 0));
  const fmt = (k, v) => (typeof v !== 'number' ? (k === 'mode' ? MODE[v].label : v) : ['landKm', 'cutKm', 'F'].includes(k) ? d3.format(',')(v) : d3.format('.3~f')(v));
  $('table').innerHTML = `<thead><tr>${COLS.map(([k, l]) => `<th data-k="${k}">${l}${k === key ? (dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>` +
    `<tbody>${sorted.map((r) => `<tr>${COLS.map(([k]) => `<td>${fmt(k, r[k])}</td>`).join('')}</tr>`).join('')}</tbody>`;
  $('table').querySelectorAll('th').forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : 1 };
    renderTable(visibleRows());
  }));
}

buildLegend();
load();
setInterval(load, 10000); // picks up new results while the batch study is still running
