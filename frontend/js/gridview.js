/**
 * gridview.js — shared canvas primitives for the landing page.
 * -----------------------------------------------------------------------------
 * Both the method section and the run replay draw the same thing: a probability
 * grid with a warm path through it. Keeping one renderer means the two figures
 * cannot drift apart visually, and the drawing rules live in one place.
 *
 * Colour discipline (landing page only): cyan is knowledge (the posterior),
 * warm rust is the agent and everything it spent. Nothing else is coloured, so
 * a glance at either figure tells you which is which.
 *
 * Inputs are deliberately permissive:
 *   - `belief` may be a 0..1 probability grid OR a 0..255 quantised grid
 *     (the recorded replay data is quantised to keep demo_run.json small).
 *   - Everything else is plain arrays from the API / trace format.
 */

export const THEME = {
  paper: '#0a0a0a',
  glyph: '#FFFFFF',
  mute: 'rgba(255,255,255,0.4)',
  rule: 'rgba(255,255,255,0.08)',
  belief: '217, 102, 10',
  warm: '#d9660a',
  warmWash: 'rgba(217, 102, 10, 0.12)',
  obstacle: '#0c0c10',
  obstacleEdge: 'rgba(255,255,255,0.1)',
};

/** Largest value in a belief grid, used to normalise the alpha ramp. */
function peakOf(belief) {
  let m = 0;
  for (const row of belief) for (const v of row) if (v > m) m = v;
  return m || 1;
}

/**
 * Paint one frame of the search.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} o
 * @param {number} o.width    grid columns
 * @param {number} o.height   grid rows
 * @param {number[][]} o.belief       posterior, indexed [y][x]
 * @param {[number, number][]} [o.path]   breadcrumb history
 * @param {[number, number]} [o.pos]      agent cell
 * @param {{x:number,y:number}} [o.peak]  best hypothesis
 * @param {{pos:number[], charges:number}[]} [o.stations]
 * @param {[number, number][]} [o.obstacles]
 * @param {[number, number]|null} [o.eve]  target cell (only drawn when found)
 * @param {boolean} [o.found]
 */
export function drawGrid(ctx, o) {
  const { width: W, height: H } = o;
  const size = ctx.canvas.width;             // square: both figures are square
  const cell = size / Math.max(W, H);
  const max = peakOf(o.belief);

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = THEME.paper;
  ctx.fillRect(0, 0, size, size);

  // 1) Posterior wash. A gamma below 1 keeps low-probability mass faintly
  //    visible so the map reads as a distribution rather than a single blob.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = o.belief[y][x];
      if (!v) continue;
      const a = 0.04 + 0.72 * Math.pow(v / max, 0.85);
      ctx.fillStyle = `rgba(${THEME.belief}, ${a.toFixed(3)})`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }

  // 2) Grid hairlines.
  ctx.strokeStyle = THEME.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= W; i++) { ctx.moveTo(i * cell + 0.5, 0); ctx.lineTo(i * cell + 0.5, size); }
  for (let i = 0; i <= H; i++) { ctx.moveTo(0, i * cell + 0.5); ctx.lineTo(size, i * cell + 0.5); }
  ctx.stroke();

  // 3) Cells the agent has stood on (visited ⇒ ruled out).
  if (o.path) {
    ctx.fillStyle = THEME.warmWash;
    for (const [x, y] of o.path) ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
  }

  // 4) Obstacles: flat black with a single diagonal tick.
  if (o.obstacles) {
    for (const [x, y] of o.obstacles) {
      ctx.fillStyle = '#0c0c10';
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.strokeStyle = THEME.obstacleEdge;
      ctx.beginPath();
      ctx.moveTo(x * cell, y * cell + cell);
      ctx.lineTo(x * cell + cell, y * cell);
      ctx.stroke();
    }
  }

  // 5) Recharge pads (charge count only matters when > 0, so it is muted).
  if (o.stations) {
    for (const st of o.stations) {
      const [x, y] = st.pos;
      ctx.strokeStyle = st.charges > 0 ? THEME.warm : THEME.mute;
      ctx.lineWidth = 1.4;
      ctx.strokeRect(x * cell + 7, y * cell + 7, cell - 14, cell - 14);
      if (st.charges > 0) {
        ctx.fillStyle = THEME.warm;
        ctx.font = `500 ${Math.round(cell * 0.24)}px "JetBrains Mono", monospace`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(String(st.charges), (x + 1) * cell - 10, (y + 1) * cell - 9);
      }
    }
  }

  // 6) Path polyline through cell centres.
  if (o.path && o.path.length > 1) {
    ctx.strokeStyle = THEME.warm;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    o.path.forEach(([x, y], i) => {
      const px = (x + 0.5) * cell;
      const py = (y + 0.5) * cell;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.stroke();
  }

  // 7) Best hypothesis: a dashed marker, not a glow.
  if (o.peak && !o.found) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = `rgba(${THEME.belief}, 0.75)`;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(o.peak.x * cell + 4, o.peak.y * cell + 4, cell - 8, cell - 8);
    ctx.restore();
  }

  // 8) EVE, revealed only once the run is over.
  if (o.eve && o.found) {
    const cx = (o.eve[0] + 0.5) * cell;
    const cy = (o.eve[1] + 0.5) * cell;
    ctx.save();
    ctx.strokeStyle = `rgba(${THEME.belief}, 0.9)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = THEME.glyph;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 9) The agent last, so it is never hidden.
  if (o.pos) {
    const [x, y] = o.pos;
    const pad = cell * 0.24;
    ctx.fillStyle = o.found ? THEME.glyph : THEME.warm;
    ctx.beginPath();
    ctx.roundRect(x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2, 2);
    ctx.fill();
    ctx.strokeStyle = THEME.paper;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
