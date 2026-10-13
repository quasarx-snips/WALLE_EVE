/**
 * replay.js — plays back a RECORDED mission (frontend/data/demo_run.json).
 * -----------------------------------------------------------------------------
 * This is not a mock-up and not a fake animation: every frame is a real snapshot
 * from the run that produced mission_trace.json (seed 7). The component draws
 * the posterior, walks the ledger in evaluation order, and exposes transport
 * controls so a reader can inspect any single decision.
 *
 * Failure policy: if the data file is missing the section keeps its static copy
 * (the numbers in the HTML) and simply never becomes interactive.
 */
import { drawGrid, THEME } from './gridview.js';

/** Frame duration when playing (ms per step). */
const FRAME_MS = 850;

export class RunReplay {
  /**
   * @param {Object} refs
   * @param {HTMLCanvasElement} refs.canvas
   * @param {HTMLElement} refs.ledgerBody
   * @param {HTMLElement} refs.counter
   * @param {HTMLElement} refs.scrub
   * @param {HTMLElement} refs.playBtn
   * @param {HTMLElement} refs.playIcon
   * @param {HTMLElement} refs.stepBtn
   * @param {HTMLElement} refs.actionLabel
   * @param {HTMLElement} refs.entropyLabel
   * @param {{autoplay?: boolean}} [opts]
   */
  constructor(refs, opts = {}) {
    this.r = refs;
    this.ctx = refs.canvas.getContext('2d');
    this.data = null;
    this.index = 0;
    this.playing = false;
    this.timer = null;
    this.opts = opts;

    refs.playBtn.addEventListener('click', () => this.toggle());
    refs.stepBtn.addEventListener('click', () => { this.pause(); this.goTo(this.index + 1); });
    refs.scrub.addEventListener('input', () => { this.pause(); this.goTo(Number(refs.scrub.value)); });
  }

  /** Load the recording and render its first frame. */
  async load(url = '/assets/data/demo_run.json') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`replay data ${res.status}`);
    this.data = await res.json();
    this.r.scrub.max = String(this.data.frames.length - 1);
    this.buildLedger();
    this.goTo(0);
    if (this.opts.autoplay) this.play();
    return this.data;
  }

  /** Jump to a frame index, clamped to the recording. */
  goTo(i) {
    if (!this.data) return;
    const last = this.data.frames.length - 1;
    this.index = Math.max(0, Math.min(last, i));
    const f = this.data.frames[this.index];
    const cfg = this.data.config;

    drawGrid(this.ctx, {
      width: cfg.width,
      height: cfg.height,
      belief: this.toGrid(f.belief, cfg.width, cfg.height),
      path: this.data.frames.slice(0, this.index + 1).map((fr) => fr.pos),
      pos: f.pos,
      peak: f.peak,
      stations: cfg.stations,
      obstacles: cfg.obstacles,
      eve: this.data.outcome.eve,
      found: this.index === last && this.data.outcome.eve_found,
    });

    this.r.scrub.value = String(this.index);
    this.r.counter.textContent = `step ${f.step} / ${this.data.outcome.steps_used}`;
    this.r.actionLabel.textContent = `${f.action}${f.note ? ` · ${f.note}` : ''}`;
    this.r.entropyLabel.textContent = `entropy ${Math.abs(f.entropy).toFixed(3)}`;
    this.highlightRow(this.index);
  }

  /** 1-D belief array (100 ints) → 2-D grid indexed [y][x]. */
  toGrid(flat, w, h) {
    const rows = [];
    for (let y = 0; y < h; y++) rows.push(flat.slice(y * w, (y + 1) * w));
    return rows;
  }

  /* -------------------------------------------------------------- transport */

  play() {
    if (!this.data || this.playing) return;
    this.playing = true;
    this.syncIcon();
    // A chain rather than an interval: the next frame is only scheduled after
    // this one is drawn, so pausing or scrubbing can never leave a timer behind.
    const tick = () => {
      if (!this.playing) return;
      if (this.index >= this.data.frames.length - 1) {
        this.pause();
        this.skipToStartIfIdle();   // loop the story once the reader has watched it
        return;
      }
      this.goTo(this.index + 1);
      this.timer = setTimeout(tick, FRAME_MS);
    };
    this.timer = setTimeout(tick, FRAME_MS);
  }

  pause() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.syncIcon();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  /** After a full pass, rewind so the section is ready to be watched again. */
  skipToStartIfIdle() {
    setTimeout(() => { if (!this.playing) this.goTo(0); }, 2200);
  }

  syncIcon() {
    this.r.playIcon.setAttribute('href', this.playing ? '#i-pause' : '#i-play');
    this.r.playBtn.setAttribute('aria-label', this.playing ? 'Pause the replay' : 'Play the replay');
  }

  /* ----------------------------------------------------------------- ledger */

  /** One row per trace entry, in evaluation order. */
  buildLedger() {
    const frag = document.createDocumentFragment();
    this.rows = [];
    this.data.frames.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'ledger-row';
      row.innerHTML =
        `<span class="num">${String(f.step).padStart(3, '0')}</span>` +
        `<span class="act">${f.action}</span>` +
        `<span class="num">${f.battery}</span>` +
        `<span class="why"></span>`;
      // Reasoning arrives as "Belief peak 7% at (9,5), entropy 0.73, battery 58.
      // <justification>" — the numbers are already columns here, so only the
      // justification sentence is kept.
      const why = row.querySelector('.why');
      why.textContent = this.justification(f.reasoning);
      row.addEventListener('click', () => { this.pause(); this.goTo(i); });
      frag.appendChild(row);
      this.rows.push(row);
    });
    this.r.ledgerBody.replaceChildren(frag);
  }

  /** Strip the boilerplate read-out that the ledger already shows as columns. */
  justification(reasoning) {
    return String(reasoning || '')
      .replace(/^Belief peak [^.]*\.\s*/, '')
      .replace(/^Mission loaded\.\s*/, '')
      .trim();
  }

  highlightRow(i) {
    if (!this.rows) return;
    this.rows.forEach((row, k) => row.classList.toggle('is-current', k === i));
    const row = this.rows[i];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------------------------------------------------------- marquee */

  /** Build the scrolling strip from the run's own action lines. */
  marqueeLines() {
    if (!this.data) return [];
    return this.data.frames.slice(1).map((f) =>
      `[${String(f.step).padStart(3, '0')}] ${f.action} → (${f.pos[0]},${f.pos[1]}) · batt ${f.battery} · ` +
      `${this.justification(f.reasoning).slice(0, 74)}`);
  }

  /* --------------------------------------------------------------- sparkline */

  /**
   * Entropy over time as inline SVG, drawn from the same frames. The path is
   * returned with its length so the caller can animate the stroke.
   * @returns {{svg: string, length: number}}
   */
  sparkline() {
    const pts = this.data ? this.data.frames : [];
    const W = 520;
    const H = 190;
    const padL = 34;
    const padB = 24;
    const plotW = W - padL - 12;
    const plotH = H - 16 - padB;
    const n = Math.max(1, pts.length - 1);
    const sx = (i) => padL + (i / n) * plotW;
    const sy = (e) => 16 + (1 - Math.min(1, Math.max(0, Math.abs(e)))) * plotH;

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(p.entropy).toFixed(1)}`).join(' ');
    const area = `${line} L${sx(n).toFixed(1)},${(16 + plotH).toFixed(1)} L${padL},${(16 + plotH).toFixed(1)} Z`;
    const gridY = [0, 0.5, 1].map((v) => {
      const y = sy(v).toFixed(1);
      return `<line class="grid-line" x1="${padL}" y1="${y}" x2="${W - 12}" y2="${y}"/>` +
        `<text x="${padL - 7}" y="${Number(y) + 3}" text-anchor="end">${v.toFixed(2)}</text>`;
    }).join('');

    const svg =
      `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Belief entropy falling from 0.87 to 0.00 over 20 steps">
        <defs><linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff9a5e" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#ff9a5e" stop-opacity="0"/>
        </linearGradient></defs>
        ${gridY}
        <path class="area" d="${area}"/>
        <path class="line" d="${line}" pathLength="1"/>
        <text x="${padL}" y="${H - 6}">step 0</text>
        <text x="${W - 12}" y="${H - 6}" text-anchor="end">step ${pts.length ? pts[pts.length - 1].step : 0}</text>
      </svg>`;
    return { svg, length: 1 };
  }
}

export { THEME };
