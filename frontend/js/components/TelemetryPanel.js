/**
 * TelemetryPanel.js — Live gauges, progress bars, and key stat tiles.
 * -----------------------------------------------------------------------------
 * A pure view: reads one store snapshot and reconciles the DOM. Element refs are
 * cached in the constructor so updates never re-query the DOM (this runs on
 * every single step).
 *
 * What it shows, and why each number matters to the agent:
 *   - Belief-peak gauge    p at the argmax cell — the agent's confidence that
 *                          its current best guess is where EVE is.
 *   - Entropy gauge        normalized Shannon entropy of the belief map, in
 *                          [0,1]. 0 = certain, 1 = uniform (knows nothing).
 *                          Watching it fall IS the Bayesian filter working.
 *   - Battery bar          remaining charge vs capacity (danger pulse < 25%).
 *   - Time bar             steps used vs the mission's step budget.
 *   - Move / scan bars     energy spent per category, against the total pool
 *                          of energy the agent has had (initial + recharged),
 *                          i.e. "how much of my budget did each behaviour eat".
 *   - Tiles                status, best-guess cell, entropy, clues, charges, blocks.
 */
import { palette, statusColor } from '../theme.js';
import { pct, humanize } from '../utils/format.js';

/** Circumference of the gauge arc (r = 46 in index.html) — used for dash offsets. */
const ARC = 2 * Math.PI * 46;

export class TelemetryPanel {
  /** @param {HTMLElement} root */
  constructor(root) {
    this.root = root;
    this.el = {
      // Bars.
      bat: root.querySelector('[data-bat]'),
      batVal: root.querySelector('[data-bat-val]'),
      time: root.querySelector('[data-time]'),
      timeVal: root.querySelector('[data-time-val]'),
      move: root.querySelector('[data-move]'),
      moveVal: root.querySelector('[data-move-val]'),
      scan: root.querySelector('[data-scan]'),
      scanVal: root.querySelector('[data-scan-val]'),
      // Stat tiles.
      status: root.querySelector('[data-status]'),
      peak: root.querySelector('[data-peak]'),
      entropy: root.querySelector('[data-entropy]'),
      clues: root.querySelector('[data-clues]'),
      charges: root.querySelector('[data-charges]'),
      blocked: root.querySelector('[data-blocked]'),
      // Radial gauges.
      peakArc: root.querySelector('#gauge-peak-arc'),
      peakVal: root.querySelector('#gauge-peak-val'),
      entArc: root.querySelector('#gauge-ent-arc'),
      entVal: root.querySelector('#gauge-ent-val'),
    };
    // Pin the dash pattern to the true circumference so 0..1 maps exactly.
    for (const arc of [this.el.peakArc, this.el.entArc]) {
      arc.style.strokeDasharray = `${ARC.toFixed(2)}`;
      arc.style.strokeDashoffset = `${ARC.toFixed(2)}`;
    }
  }

  /** @param {import('../types.js').SimulationState} s */
  render(s) {
    const e = this.el;

    // ---- gauges ----------------------------------------------------------
    // Confidence: raw probability mass at the argmax cell.
    this._arc(e.peakArc, s.peak.p);
    e.peakVal.textContent = pct(s.peak.p, 0);
    e.peakArc.style.stroke = s.found ? palette.green : palette.cyan;

    // Uncertainty: normalized entropy. Full ring == maximum ignorance.
    this._arc(e.entArc, s.entropy);
    e.entVal.textContent = s.entropy.toFixed(2);
    e.entArc.style.stroke = s.entropy < 0.35 ? palette.green : palette.rust;

    // ---- bars ------------------------------------------------------------
    const batFrac = s.battery_max ? s.battery / s.battery_max : 0;
    this._bar(e.bat, batFrac);
    e.bat.style.background = batFrac < 0.25 ? palette.red : '';
    e.bat.classList.toggle('is-critical', batFrac < 0.25);
    e.batVal.textContent = `${s.battery} / ${s.battery_max}`;

    this._bar(e.time, s.max_steps ? s.steps / s.max_steps : 0);
    e.timeVal.textContent = `${s.steps} / ${s.max_steps} steps`;

    const pool = Math.max(1, s.energy_pool);
    this._bar(e.move, s.spent.move / pool);
    e.moveVal.textContent = `${s.spent.move} (${s.counts.move} moves)`;
    this._bar(e.scan, s.spent.scan / pool);
    e.scanVal.textContent = `${s.spent.scan} (${s.counts.scan} scans)`;

    // ---- tiles -----------------------------------------------------------
    e.status.textContent = humanize(s.status);
    e.status.style.color = statusColor(s.status, !s.done);
    e.peak.textContent = `(${s.peak.x},${s.peak.y})`;
    e.entropy.textContent = s.entropy.toFixed(3);
    e.clues.textContent = `${s.clues_found.length} / ${s.clue_total}`;
    e.charges.textContent = String(s.stations.reduce((a, st) => a + st.charges, 0));
    e.blocked.textContent = String(s.counts.blocked);
  }

  /** Set a bar's width (clamped 0..100%). @param {HTMLElement} bar */
  _bar(bar, frac) {
    bar.style.width = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
  }

  /** Draw a radial gauge arc by offsetting its dash pattern (1 = full ring). */
  _arc(arc, frac) {
    const f = Math.max(0, Math.min(1, frac || 0));
    arc.style.strokeDashoffset = `${(ARC * (1 - f)).toFixed(2)}`;
  }
}
