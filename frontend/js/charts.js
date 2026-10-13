/**
 * charts.js — the pure figure builders, shared by the dashboard and the landing page.
 * -----------------------------------------------------------------------------
 * Every function here is a PURE function from a data snapshot to an SVG string.
 * No DOM, no state, no charting library: this project has no build step and no
 * dependencies, so the figures are generated as markup and injected with
 * innerHTML. A fixed `viewBox` plus `width:100%` in CSS keeps them crisp and
 * responsive with no resize listener.
 *
 * Sharing them matters: the landing page's scoreboard and the live dashboard's
 * evaluation panel show the SAME quantities, so they must be drawn by the same
 * code or they will quietly drift apart as the numbers change.
 *
 * The figures:
 *   entropyChart      posterior uncertainty over time (the filter converging)
 *   informationChart  how many nats each observation actually bought
 *   reliabilityChart  calibration: the agent's stated trust vs its hit rate
 *   rocChart          how well posterior mass ranks the true cell
 *   confusionChart    the per-step "am I within one cell?" detection matrix
 *   actionRadar       behavioural fingerprint (moves / scans / blocks / recharges)
 */

/* ---------------------------------------------------------------- geometry */
/** Line-chart box in viewBox units (scaled by CSS, not by JS). */
const L = { w: 540, h: 214, padL: 40, padR: 16, padT: 16, padB: 28 };
/** Radar box in viewBox units. */
const R = { w: 300, h: 232, cx: 122, cy: 118, radius: 74, labelGap: 20 };
/** Small square box shared by the reliability diagram and the ROC curve. */
const S = { w: 268, h: 226, padL: 34, padR: 18, padT: 16, padB: 28 };

/** Radar spokes: index.html order is clockwise from the top. */
const SPOKES = [
  { key: 'move', label: 'MOVES', angle: -Math.PI / 2 },
  { key: 'scan', label: 'SCANS', angle: 0 },
  { key: 'blocked', label: 'BLOCKED', angle: Math.PI / 2 },
  { key: 'recharge', label: 'RECHARGE', angle: Math.PI },
];

/** Round to `d` decimals (keeps generated SVG tidy and diff-friendly). */
const r = (v, d = 1) => Number(v.toFixed(d));

/** Down-sample a very long series so the path stays light (150 steps is typical). */
function thin(series, cap = 320) {
  if (series.length <= cap) return series;
  const stride = Math.ceil(series.length / cap);
  return series.filter((_, i) => i % stride === 0 || i === series.length - 1);
}

/* ------------------------------------------------------------ chart builders */

/**
 * Entropy line chart.
 * @param {{step:number, entropy:number}[]} series
 * @param {{done:boolean, status:string}} meta
 * @returns {string} SVG markup
 */
function entropyChart(series, meta) {
  const plotW = L.w - L.padL - L.padR;
  const plotH = L.h - L.padT - L.padB;
  const xMax = Math.max(10, series.length ? series[series.length - 1].step : 10);
  const sx = (step) => L.padL + (step / xMax) * plotW;
  const sy = (e) => L.padT + (1 - Math.min(1, Math.max(0, e))) * plotH;   // 0..1 fixed domain

  // Horizontal gridlines every 0.25 of the entropy range, labelled on the left.
  let grid = '';
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
    const y = r(sy(v));
    grid += `<line class="chart-gridline" x1="${L.padL}" y1="${y}" x2="${L.w - L.padR}" y2="${y}"/>`;
    grid += `<text class="chart-axis" x="${L.padL - 7}" y="${y + 3}" text-anchor="end">${v.toFixed(2)}</text>`;
  });

  // X ticks: start, midpoint, current step (the axis grows with the mission).
  grid += [0, Math.round(xMax / 2), xMax].map((t) =>
    `<text class="chart-axis" x="${r(sx(t))}" y="${L.h - 8}" text-anchor="middle">${t}</text>`).join('');

  const pts = thin(series);
  if (pts.length === 0) {
    return wrap(`<text class="chart-axis" x="${L.w / 2}" y="${L.h / 2}" text-anchor="middle">no data — waiting for the first step</text>`);
  }

  // Line path + area fill (same points closed down to the baseline).
  const coords = pts.map((p) => [sx(p.step), sy(p.entropy)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)},${r(y)}`).join(' ');
  const baseline = L.padT + plotH;
  const area = `${line} L${r(coords[coords.length - 1][0])},${baseline} L${r(coords[0][0])},${baseline} Z`;

  const [lx, ly] = coords[coords.length - 1];
  const first = pts[0].entropy;
  const last = pts[pts.length - 1].entropy;
  const trend = meta.done ? `final ${last.toFixed(2)}` : `Δ ${(last - first >= 0 ? '+' : '')}${(last - first).toFixed(2)}`;

  return wrap(`
    <defs>
      <!-- Vertical fade so the area reads as "probability mass of uncertainty". -->
      <linearGradient id="entropy-area" x1="0" y1="0" x2="0" y2="1">          <stop offset="0%" stop-color="#e8895c" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="#e8895c" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    <path class="chart-area" d="${area}"/>
    <path class="chart-line" d="${line}"/>
    <circle class="chart-marker-ring" cx="${r(lx)}" cy="${r(ly)}" r="7"/>
    <circle class="chart-marker" cx="${r(lx)}" cy="${r(ly)}" r="3.4"/>
    <text class="chart-axis" x="${L.w - L.padR}" y="${L.padT + 2}" text-anchor="end">${trend}</text>`);
}

/**
 * Action-frequency radar chart.
 * @param {{move:number, scan:number, recharge:number, blocked:number}} counts
 * @returns {string} SVG markup
 */
function actionRadar(counts) {
  // Normalise against the largest count (with a floor of 1) so the polygon always
  // uses the full radius for whichever behaviour dominates.
  const values = SPOKES.map((s) => counts[s.key] || 0);
  const max = Math.max(1, ...values);

  // Background rings at 25/50/75/100% of the radius.
  let rings = '';
  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const pts = SPOKES.map((s) => {
      const ang = s.angle;
      return `${r(R.cx + Math.cos(ang) * R.radius * f)},${r(R.cy + Math.sin(ang) * R.radius * f)}`;
    }).join(' ');
    rings += `<polygon class="radar-grid" points="${pts}"/>`;
  });

  // Spokes + labels.
  const spokes = SPOKES.map((s) => {
    const x = R.cx + Math.cos(s.angle) * R.radius;
    const y = R.cy + Math.sin(s.angle) * R.radius;
    const lx = R.cx + Math.cos(s.angle) * (R.radius + R.labelGap);
    const ly = R.cy + Math.sin(s.angle) * (R.radius + R.labelGap);
    const dx = Math.cos(s.angle);
    const dy = Math.sin(s.angle);
    const anchor = Math.abs(dx) < 0.2 ? 'middle' : (dx > 0 ? 'start' : 'end');
    const shift = Math.abs(dy) < 0.2 ? 3 : (dy > 0 ? 8 : 0);
    return `<line class="radar-spoke" x1="${R.cx}" y1="${R.cy}" x2="${r(x)}" y2="${r(y)}"/>` +
      `<text class="radar-label" x="${r(lx)}" y="${r(ly + shift)}" text-anchor="${anchor}">${s.label}</text>`;
  }).join('');

  // The data polygon: one vertex per spoke, scaled by count / max.
  // A count of 0 sits exactly at the centre (honest "never happened"), while a
  // non-zero count gets a small floor so a rare action is still visible.
  const radiusOf = (v) => R.radius * (v === 0 ? 0 : 0.18 + 0.82 * (v / max));
  const vertex = (s, v) => [
    R.cx + Math.cos(s.angle) * radiusOf(v),
    R.cy + Math.sin(s.angle) * radiusOf(v),
  ];
  const poly = SPOKES.map((s, i) => vertex(s, values[i]).map((n) => r(n)).join(',')).join(' ');
  const dots = SPOKES.map((s, i) => {
    const [x, y] = vertex(s, values[i]);
    return `<circle class="radar-dot" cx="${r(x)}" cy="${r(y)}" r="2.6"/>`;
  }).join('');

  return wrap(`
    ${rings}
    ${spokes}
    <polygon class="radar-poly" points="${poly}"/>
    ${dots}`, R.w, R.h);
}

/**
 * Information gain per step: D_KL(posterior || prior) for each observation, in
 * nats. This is the ONLY chart here that shows what the agent bought rather than
 * what it believes — a tall bar is a reading that actually moved the posterior,
 * and a run of near-zero bars means the sensor was talking and saying nothing
 * (which is exactly what happens near a decoy beacon).
 *
 * @param {number[]} series nan-free KL values, one per scored step
 * @returns {string} SVG markup
 */
function informationChart(series) {
  const pts = series || [];
  const plotW = L.w - L.padL - L.padR;
  const plotH = L.h - L.padT - L.padB;
  const n = Math.max(1, pts.length);
  const yMax = Math.max(0.25, ...pts);
  const sx = (i) => L.padL + (i / Math.max(1, n - 1)) * plotW;
  const sy = (v) => L.padT + (1 - Math.min(1, Math.max(0, v / yMax))) * plotH;

  let grid = '';
  [0, 0.5, 1].forEach((f) => {
    const y = r(sy(yMax * f));
    grid += `<line class="chart-gridline" x1="${L.padL}" y1="${y}" x2="${L.w - L.padR}" y2="${y}"/>`;
    grid += `<text class="chart-axis" x="${L.padL - 7}" y="${y + 3}" text-anchor="end">${(yMax * f).toFixed(2)}</text>`;
  });
  const xTicks = n < 3 ? [n - 1] : [0, Math.round((n - 1) / 2), n - 1];
  grid += xTicks.map((t) =>
    `<text class="chart-axis" x="${r(sx(t))}" y="${L.h - 8}" text-anchor="middle">${t + 1}</text>`).join('');

  if (!pts.length) {
    return wrap(`<text class="chart-axis" x="${L.w / 2}" y="${L.h / 2}" text-anchor="middle">no observations scored yet</text>`);
  }

  const coords = pts.map((v, i) => [sx(i), sy(v)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)},${r(y)}`).join(' ');
  const baseline = L.padT + plotH;
  const area = `${line} L${r(coords[coords.length - 1][0])},${baseline} L${r(coords[0][0])},${baseline} Z`;
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const my = r(sy(mean));

  return wrap(`
    <defs>
      <linearGradient id="gain-area" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#59e3ec" stop-opacity="0.22"/>
        <stop offset="100%" stop-color="#59e3ec" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    ${grid}
    <path class="chart-area chart-area--gain" d="${area}"/>
    <path class="chart-line chart-line--gain" d="${line}"/>
    <line class="chart-mean" x1="${L.padL}" y1="${my}" x2="${L.w - L.padR}" y2="${my}"/>
    <text class="chart-axis" x="${L.w - L.padR}" y="${my - 4}" text-anchor="end">mean ${mean.toFixed(3)}</text>`);
}

/**
 * Reliability diagram (calibration curve).
 *
 * For every bin of the agent's own neighbourhood belief (how sure it was that
 * EVE was next to it), we plot how often that was actually true. A perfectly
 * calibrated filter lies on y = x. Above the line = under-confident, below = the
 * classic failure mode of a Bayesian filter with a misspecified sensor model:
 * certain, and wrong. Dot area is proportional to how many steps fell in the bin,
 * so a sparse bin cannot dominate the picture.
 */
function reliabilityChart(bins) {
  const B = S.w - S.padL - S.padR;
  const Hh = S.h - S.padT - S.padB;
  const sx = (p) => S.padL + p * B;
  const sy = (p) => S.padT + (1 - p) * Hh;
  const maxN = Math.max(1, ...bins.map((b) => b.n));

  let body = '';
  [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
    body += `<line class="chart-gridline" x1="${S.padL}" y1="${r(sy(v))}" x2="${S.w - S.padR}" y2="${r(sy(v))}"/>`;
    body += `<line class="chart-gridline" x1="${r(sx(v))}" y1="${S.padT}" x2="${r(sx(v))}" y2="${S.padT + Hh}"/>`;
  });
  // The diagonal a perfectly calibrated filter would follow.
  body += `<line class="reliability-ideal" x1="${r(sx(0))}" y1="${r(sy(0))}" x2="${r(sx(1))}" y2="${r(sy(1))}"/>`;
  body += `<text class="chart-axis" x="${S.padL}" y="${S.h - 6}">0</text>`;
  body += `<text class="chart-axis" x="${S.w - S.padR}" y="${S.h - 6}" text-anchor="end">1.0 trust</text>`;
  body += `<text class="chart-axis" x="${S.padL - 6}" y="${S.padT + 8}" text-anchor="end">1</text>`;
  body += `<text class="chart-axis" x="${S.padL - 6}" y="${S.padT + Hh}" text-anchor="end">0</text>`;

  bins.forEach((b) => {
    if (!b.n) return;
    const radius = 2.2 + 6.4 * Math.sqrt(b.n / maxN);
    body += `<circle class="reliability-dot" cx="${r(sx(b.predicted))}" cy="${r(sy(b.observed))}" r="${r(radius, 2)}">` +
      `<title>trust ${b.predicted.toFixed(2)} → hit ${b.observed.toFixed(2)} (${b.n} steps)</title></circle>`;
  });
  return wrap(body, S.w, S.h);
}

/**
 * ROC curve. Positives are pooled per-step cells that ARE the true cell; the
 * score is that cell's posterior. With one true cell per step this is really
 * asking "how well does posterior mass rank the truth?", which is the question
 * AUC answers. The diagonal is a filter that knows nothing.
 */
function rocChart(roc) {
  const pts = (roc && roc.points) || [];
  const B = S.w - S.padL - S.padR;
  const Hh = S.h - S.padT - S.padB;
  const sx = (f) => S.padL + f * B;
  const sy = (t) => S.padT + (1 - t) * Hh;

  let body = '';
  [0, 0.5, 1].forEach((v) => {
    body += `<line class="chart-gridline" x1="${S.padL}" y1="${r(sy(v))}" x2="${S.w - S.padR}" y2="${r(sy(v))}"/>`;
    body += `<line class="chart-gridline" x1="${r(sx(v))}" y1="${S.padT}" x2="${r(sx(v))}" y2="${S.padT + Hh}"/>`;
  });
  body += `<line class="reliability-ideal" x1="${r(sx(0))}" y1="${r(sy(0))}" x2="${r(sx(1))}" y2="${r(sy(1))}"/>`;
  if (pts.length) {
    const d = pts.map(([f, t], i) => `${i ? 'L' : 'M'}${r(sx(f))},${r(sy(t))}`).join(' ');
    body += `<path class="roc-line" d="${d}"/>`;
  }
  body += `<text class="chart-axis" x="${S.padL}" y="${S.h - 6}">0</text>`;
  body += `<text class="chart-axis" x="${S.w - S.padR}" y="${S.h - 6}" text-anchor="end">false +</text>`;
  body += `<text class="chart-axis" x="${S.padL - 6}" y="${S.padT + Hh}" text-anchor="end">0</text>`;
  body += `<text class="chart-axis" x="${S.padL - 6}" y="${S.padT + 10}" text-anchor="end">1</text>`;
  const auc = roc && typeof roc.auc === 'number' ? roc.auc : 0;
  body += `<text class="chart-value" x="${S.w - S.padR}" y="${S.padT + 12}" text-anchor="end">AUC ${auc.toFixed(3)}</text>`;
  return wrap(body, S.w, S.h);
}

/**
 * Detection confusion matrix.
 *
 * The task: "am I within one cell of EVE?", predicted yes when the agent's own
 * 3×3 neighbourhood holds at least half the posterior mass. This is a real,
 * falsifiable claim the agent makes every step, and unlike the localisation
 * metrics it has a meaningful base rate. A wall of false positives means the
 * filter is bluffing; false negatives mean it is leaving contact on the table.
 */
function confusionChart(det) {
  const d = det || { tp: 0, fp: 0, tn: 0, fn: 0, precision: 0, recall: 0 };
  const total = Math.max(1, d.tp + d.fp + d.tn + d.fn);
  const cell = (label, value, cls) =>
    `<div class="cm-cell ${cls}"><b class="mono">${value}</b><span>${label}</span>` +
    `<i style="width:${(100 * value / total).toFixed(1)}%"></i></div>`;
  return `<div class="cm">
      <div class="cm-corner"></div>
      <div class="cm-head">predicted near</div>
      <div class="cm-head">predicted far</div>
      <div class="cm-side">actually near</div>
      ${cell('true positive', d.tp, 'cm-tp')}
      ${cell('false negative', d.fn, 'cm-fn')}
      <div class="cm-side">actually far</div>
      ${cell('false positive', d.fp, 'cm-fp')}
      ${cell('true negative', d.tn, 'cm-tn')}
    </div>
    <div class="cm-foot">
      <span>precision <b class="mono">${(d.precision ?? 0).toFixed(2)}</b></span>
      <span>recall <b class="mono">${(d.recall ?? 0).toFixed(2)}</b></span>
      <span>steps scored <b class="mono">${total}</b></span>
    </div>`;
}

/**
 * Wrap chart body markup in an SVG with the given viewBox. Each chart has its own
 * coordinate box, so the radar keeps its proportions when the grid reflows.
 */
function wrap(body, w = L.w, h = L.h) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img">${body}</svg>`;
}

/* The public surface: every figure is a pure data -> SVG string function. */
export { entropyChart, informationChart, reliabilityChart, rocChart, confusionChart, actionRadar };
