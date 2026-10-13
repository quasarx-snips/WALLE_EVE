/**
 * GridMap.js — Canvas renderer for the pursuit map.
 * -------------------------------------------------------------------------
 * Two stacked canvases keep rendering cheap and buttery:
 *
 *   1) SCENE canvas (bottom) — redrawn ONLY when the simulation state changes.
 *      Belief heatmap, the 90% credible set, obstacles, the trail, recharge
 *      stations, clue tokens (+ their sigma rings), decoy beacons, the peak
 *      cell and WALL-E.
 *
 *   2) OVERLAY canvas (top)  — one requestAnimationFrame loop repaints only the
 *      transient things every frame: the pulse on the best hypothesis, the
 *      decaying scan arc, and the particle cloud drifting with the filter. A
 *      belief update therefore never has to re-run the heavy scene draw.
 *
 * ML concepts made visible:
 *   - `belief[y][x]` is a normalised posterior; alpha ramps with probability so
 *     mass concentrates visibly on the agent's best hypotheses.
 *   - The dashed outline is the 90% CREDIBLE SET: the smallest group of cells
 *     that holds 90% of the mass. Its area is the honest answer to "how sure
 *     are you, really?" — a single confident cell is a small set.
 *   - `decoys` are known beacons. They are drawn because the agent knows about
 *     them; the interesting part is that a reading near one is worthless, which
 *     is why the filter's answer there stays diffuse.
 *   - The particle cloud is a second estimator of the SAME posterior (sequential
 *     Monte Carlo). When it visibly separates from the heatmap's peak, the two
 *     filters disagree — which happens exactly when the posterior is multimodal.
 */
import { palette } from '../theme.js';

export class GridMap {
  /**
   * @param {HTMLCanvasElement} sceneCanvas
   * @param {HTMLCanvasElement} overlayCanvas
   * @param {HTMLElement} [stage] the sized wrapper (.map-stage)
   */
  constructor(sceneCanvas, overlayCanvas, stage) {
    this.scene = sceneCanvas;
    this.overlay = overlayCanvas;
    this.stack = sceneCanvas.parentElement;              // sized by resize()
    this.stage = stage || this.stack.parentElement;      // available space
    this.sctx = sceneCanvas.getContext('2d');
    this.octx = overlayCanvas.getContext('2d');

    // CSS-pixel box of the canvas (the grid keeps the WIDTH/HEIGHT aspect ratio),
    // cached so the drawing code never has to re-measure mid-frame.
    this.cssW = 0;
    this.cssH = 0;

    /** @type {import('../types.js').SimulationState|null} */
    this.state = null;
    /** @type {import('../types.js').TraceEntry|null} */
    this.lastEntry = null;
    /** Particle positions from the last snapshot, tweened for a settled cloud. */
    this.cloud = [];

    this.clock = 0;
    this.scanAt = -1;      // clock time of the most recent scan, for arc decay
    this.lastScanStep = -1;

    this._raf = null;
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    // Panel edges can also change without a window resize (CSS grid reflow,
    // font loading). A ResizeObserver covers all of them.
    this._ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.stage);
    }
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  /**
   * Update the rendered simulation. Cheap diff of the scan step so we know when
   * to (re)trigger the decaying scan arc.
   * @param {import('../types.js').SimulationState} sim
   * @param {import('../types.js').TraceEntry|null} entry
   */
  update(sim, entry) {
    const prevScan = this.lastScanStep;
    this.state = sim;
    this.lastEntry = entry;
    if (entry && entry.action === 'scan' && entry.step !== prevScan) {
      this.scanAt = this.clock;
      this.lastScanStep = entry.step;
    }
    if (Array.isArray(sim.particles)) this.cloud = sim.particles;
    this.resize();
    this.drawScene();
  }

  /**
   * Fit the canvas box inside the padded stage while preserving the grid's
   * aspect ratio (WIDTH/HEIGHT), then match the backing store to the CSS box.
   * The wrapper is sized explicitly so both stacked canvases overlap exactly.
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const s = this.state;
    const aspect = s && s.height ? s.width / s.height : 1;

    // Stage padding is 5px on each side (see .map-stage in app.css).
    const availW = Math.max(160, this.stage.clientWidth - 12);
    const availH = Math.max(160, this.stage.clientHeight - 12);

    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    this.cssW = w;
    this.cssH = h;
    this.stack.style.width = `${w}px`;
    this.stack.style.height = `${h}px`;

    let resized = false;
    for (const c of [this.scene, this.overlay]) {
      const bw = Math.max(1, Math.round(w * dpr));
      const bh = Math.max(1, Math.round(h * dpr));
      if (c.width !== bw || c.height !== bh) {
        c.width = bw;
        c.height = bh;
        resized = true;
      }
      c._dpr = dpr;
    }

    // Assigning canvas.width CLEARS the bitmap, so a pure resize (window drag,
    // grid reflow) must repaint the scene — otherwise the map would blink empty
    // until the next simulation step arrived.
    if (resized && this.state) this.drawScene();
  }

  /** requestAnimationFrame loop: advance the clock and redraw the overlay. */
  _loop(ts) {
    this.clock = ts || 0;
    this.drawOverlay();
    this._raf = requestAnimationFrame(this._loop);
  }

  /** Tear down: cancel the loop, disconnect observers (no leaks on unmount). */
  destroy() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (this._ro) this._ro.disconnect();
  }

  /** The 90% credible set as a boolean grid, or null when the mission is over. */
  credibleMask() {
    const s = this.state;
    if (!s || !s.credible_set_90 || s.done) return null;
    const flat = [];
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) flat.push([s.belief[y][x], x, y]);
    flat.sort((a, b) => b[0] - a[0]);
    const mask = Array.from({ length: s.height }, () => new Array(s.width).fill(false));
    let acc = 0;
    for (const [p, x, y] of flat) {
      if (acc >= 0.9) break;
      if (p <= 0) continue;
      mask[y][x] = true;
      acc += p;
    }
    return mask;
  }

  /**
   * Repaint the SCENE canvas from scratch. Called only when state changes.
   * Order (back->front): bg -> belief -> credible set -> trail -> grid ->
   * obstacles -> stations -> clues -> decoys -> peak -> WALL-E -> EVE.
   */
  drawScene() {
    const s = this.state;
    const ctx = this.sctx;
    const dpr = this.scene._dpr || 1;
    const W = s ? s.width : 0;
    const H = s ? s.height : 0;
    const w = this.cssW;
    const h = this.cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!s) return;
    const cw = w / W;
    const ch = h / H;

    // 1) Background.
    ctx.fillStyle = palette.space0;
    ctx.fillRect(0, 0, w, h);

    // 2) Belief heatmap. Alpha ramps with probability relative to the max cell,
    //    gamma(<1) so low-probability mass stays faintly visible.
    let mx = 1e-9;
    for (const row of s.belief) for (const p of row) if (p > mx) mx = p;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = s.belief[y][x];
        if (p <= 0) continue;
        const a = 0.04 + 0.72 * Math.pow(p / mx, 0.8);
        ctx.fillStyle = `rgba(${palette.beliefRGB},${a.toFixed(3)})`;
        ctx.fillRect(x * cw, y * ch, cw, ch);
      }
    }

    // 3) 90% credible set: a dashed outline around every cell it contains, which
    //    visually collapses to a small box as the filter converges.
    const mask = this.credibleMask();
    if (mask) {
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = palette.credible;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!mask[y][x]) continue;
          ctx.rect(x * cw + 1.5, y * ch + 1.5, cw - 3, ch - 3);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // 4) Visited trail (breadcrumb history) as translucent tiles.
    ctx.fillStyle = palette.visited;
    s.path.forEach(([x, y]) => ctx.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2));

    // 5) Grid lines.
    ctx.strokeStyle = palette.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= W; i++) { ctx.moveTo(i * cw, 0); ctx.lineTo(i * cw, h); }
    for (let i = 0; i <= H; i++) { ctx.moveTo(0, i * ch); ctx.lineTo(w, i * ch); }
    ctx.stroke();

    // 6) Obstacles — dark cells with a diagonal hatch ("impassable").
    s.obstacles.forEach(([x, y]) => {
      ctx.fillStyle = palette.obstacleFill;
      ctx.fillRect(x * cw, y * ch, cw, ch);
      ctx.strokeStyle = palette.obstacleEdge;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x * cw, y * ch + ch);
      ctx.lineTo(x * cw + cw, y * ch);
      ctx.stroke();
    });

    // 7) Recharge stations — bordered squares + remaining charge count.
    s.stations.forEach((st) => {
      const [x, y] = st.pos;
      ctx.strokeStyle = st.charges ? palette.station : palette.stationDead;
      ctx.lineWidth = 2;
      ctx.strokeRect(x * cw + 4, y * ch + 4, cw - 8, ch - 8);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = `600 ${Math.round(ch * 0.26)}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(st.charges), (x + 1) * cw - 6, (y + 1) * ch - 6);
    });

    // 8) Clues — cyan diamond at the token + dashed Gaussian ring at the hint.
    (s.clues_found || []).forEach((k) => {
      const cx = (k.pos[0] + 0.5) * cw;
      const cy = (k.pos[1] + 0.5) * ch;
      const r = cw * 0.13;
      ctx.fillStyle = palette.clue;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy);
      ctx.closePath(); ctx.fill();
      const hx = (k.hint[0] + 0.5) * cw;
      const hy = (k.hint[1] + 0.5) * ch;
      ctx.strokeStyle = palette.clueRing || 'rgba(89,227,236,0.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(hx, hy, k.sigma * cw, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.setLineDash([]);
    });

    // 9) Decoy beacons — known, so drawn as a red concentric mark, not hidden.
    (s.decoys || []).forEach(([x, y]) => {
      const cx = (x + 0.5) * cw;
      const cy = (y + 0.5) * ch;
      ctx.strokeStyle = palette.decoyRing || 'rgba(255,90,90,0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, Math.min(cw, ch) * 0.30, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, Math.min(cw, ch) * 0.52, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = palette.decoyFill || 'rgba(255,90,90,0.9)';
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(1.6, cw * 0.07), 0, Math.PI * 2); ctx.fill();
    });

    // 10) Peak-cell outline (the pulsing ring lives on the overlay canvas).
    if (!s.done) {
      ctx.strokeStyle = palette.peak;
      ctx.lineWidth = 2;
      ctx.strokeRect(s.peak.x * cw + 2, s.peak.y * ch + 2, cw - 4, ch - 4);
    }

    // 11) WALL-E marker — rounded body with two "eyes".
    const ax = (s.pos[0] + 0.5) * cw;
    const ay = (s.pos[1] + 0.5) * ch;
    ctx.fillStyle = s.found ? palette.success : palette.warm;
    ctx.beginPath();
    ctx.roundRect(ax - cw * 0.3, ay - ch * 0.26, cw * 0.6, ch * 0.52, 5);
    ctx.fill();
    ctx.fillStyle = palette.space0;
    [-1, 1].forEach((sd) => {
      ctx.beginPath();
      ctx.arc(ax + sd * cw * 0.13, ay - ch * 0.04, cw * 0.09, 0, Math.PI * 2);
      ctx.fill();
    });

    // 12) EVE — revealed only when done, with a soft halo.
    if (s.eve) {
      const [ex, ey] = s.eve;
      ctx.save();
      ctx.shadowColor = palette.cyan;
      ctx.shadowBlur = 16;
      ctx.fillStyle = palette.eveFill || '#F4FDFF';
      ctx.beginPath();
      ctx.ellipse((ex + 0.5) * cw, (ey + 0.5) * ch, cw * 0.2, ch * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Repaint the OVERLAY canvas each animation frame. Draws ONLY transient
   * effects (must stay cheap): the particle cloud, a breathing pulse ring on the
   * peak cell, and a decaying arc that flashes when WALL-E performs a scan.
   */
  drawOverlay() {
    const s = this.state;
    const ctx = this.octx;
    const dpr = this.overlay._dpr || 1;
    const w = this.cssW;
    const h = this.cssH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!s) return;
    const cw = w / s.width;
    const ch = h / s.height;

    // Particle cloud — the second estimator, drawn UNDER the peak ring so the
    // heatmap's answer stays readable. Opacity breathes so the cloud reads as
    // samples rather than a hard mask.
    if (this.cloud.length) {
      // Faint on purpose. The cloud is a SECOND opinion about the same posterior,
      // so it must never compete with the heatmap it is sitting on — when the run
      // is early and both are diffuse, a heavy cloud just reads as noise.
      const breathe = 0.5 + 0.28 * Math.sin(this.clock / 900);
      ctx.fillStyle = palette.particle;
      ctx.globalAlpha = breathe;
      const s = Math.max(1.4, Math.min(cw, ch) * 0.26);
      for (const [x, y] of this.cloud) {
        ctx.fillRect(x * cw + (cw - s) / 2, y * ch + (ch - s) / 2, s, s);
      }
      ctx.globalAlpha = 1;
    }

    // Pulsing halo on the highest-probability cell: a 60fps "heartbeat" of the
    // agent's best hypothesis (radius/alpha oscillate via sine of the clock).
    if (!s.done) {
      const cx = (s.peak.x + 0.5) * cw;
      const cy = (s.peak.y + 0.5) * ch;
      const t = this.clock / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.0);
      const radius = Math.min(cw, ch) * (0.38 + 0.12 * pulse);
      ctx.strokeStyle = `rgba(${palette.peakRGB || '232,137,92'},${(0.30 + 0.40 * pulse).toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Decaying scan arc: an amber ring that flashes + fades over ~700ms.
    if (this.scanAt >= 0) {
      const dt = this.clock - this.scanAt;
      const dur = 700;
      if (dt >= 0 && dt <= dur) {
        const k = 1 - dt / dur;                       // 1 -> 0
        const cx = (s.pos[0] + 0.5) * cw;
        const cy = (s.pos[1] + 0.5) * ch;
        ctx.strokeStyle = `rgba(${palette.scanRGB || '217,102,10'},${(0.75 * k).toFixed(3)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(cw, ch) * (0.5 + (1 - k) * 1.4), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        this.scanAt = -1;                             // done decaying
      }
    }
  }
}
