/**
 * PosteriorPanel.js — the algebra, shown as numbers.
 * -----------------------------------------------------------------------------
 * Everything else on this dashboard draws the posterior as a picture. This panel
 * writes it out as the actual matrices the update works on, because the whole
 * claim of the project is that any single decision can be reconstructed by hand:
 *
 *   prior[y][x]       P(EVE at cell) after the motion model, before this reading
 *   likelihood[y][x]  P(this reading | EVE at cell)  — evidence, not belief
 *   posterior[y][x]   prior * likelihood, renormalised — what the agent now thinks
 *
 * A segmented switch (not three separate panels) keeps the comparison honest:
 * you are looking at the same cells under three different quantities, so any
 * change of shape between them is the evidence talking, not a redraw.
 *
 * The accompanying strip is the FILTER DUEL: the grid filter's MAP against the
 * particle filter's weighted mean. Two estimators of one posterior; when their
 * gap grows, the posterior is multimodal and neither is entitled to be trusted.
 */
import { palette, beliefInk, likelihoodInk } from '../theme.js';

/** Compact fixed-width cell text: 4 characters, so 14 columns still fit. */
function cellText(v) {
  const n = Number(v) || 0;
  if (n >= 0.1) return n.toFixed(2).slice(1);          // ".41"
  if (n >= 0.01) return n.toFixed(3).slice(1);         // ".041"
  if (n >= 0.001) return `${Math.round(n * 1000)}e-3`; // "4e-3"  (< 10 by construction)
  return '·';                                           // below 0.001 reads as "nothing here"
}

const VIEWS = [
  { key: 'prior', label: 'Prior', ink: beliefInk, note: 'belief after the motion model, before this reading' },
  { key: 'likelihood', label: 'Likelihood', ink: likelihoodInk, note: 'P(this reading | EVE at cell) — evidence only' },
  { key: 'belief', label: 'Posterior', ink: beliefInk, note: 'prior × likelihood, renormalised — what the agent thinks now' },
];

export class PosteriorPanel {
  /**
   * @param {HTMLElement} root  panel body
   * @param {HTMLElement} [hint] panel-hint element
   */
  constructor(root, hint) {
    this.root = root;
    this.hint = hint;
    this.view = 'belief';
    this.sim = null;
    // Delegated: the markup is regenerated on every step, the wrapper is not.
    root.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('[data-matrix]') : null;
      if (!btn) return;
      this.view = btn.dataset.matrix;
      if (this.sim) this.render(this.sim);
    });
  }

  /** @param {import('../types.js').SimulationState} s */
  render(s) {
    this.sim = s;
    const active = VIEWS.find((v) => v.key === this.view) || VIEWS[2];
    const grid = s[active.key] || s.belief;
    const H = grid.length;
    const W = grid[0] ? grid[0].length : 0;

    let mx = 1e-9;
    for (const row of grid) for (const v of row) if (v > mx) mx = v;
    const max = mx;

    let cells = '';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = grid[y][x];
        const t = v / max;
        const cls = v <= 0 ? 'mx-cell mx-cell--void'
          : (y === s.peak.y && x === s.peak.x && active.key !== 'likelihood') ? 'mx-cell mx-cell--peak' : 'mx-cell';
        cells += `<i class="${cls}" style="background:${v > 0 ? active.ink(t) : 'transparent'}"` +
          ` title="(${x},${y}) ${active.label.toLowerCase()} ${Number(v).toPrecision(3)}">${cellText(v)}</i>`;
      }
    }

    const gap = s.filter_gap ?? 0;
    const ess = s.ess ?? 0;
    const tags = [
      { k: 'peak', v: `(${s.peak.x},${s.peak.y})`, s: `${(s.peak.p * 100).toFixed(1)}% at that cell` },
      { k: 'entropy', v: (s.entropy ?? 0).toFixed(3), s: 'normalised Shannon entropy' },
      { k: 'credible 90%', v: `${s.credible_set_90 ?? '—'} cells`, s: 'smallest set holding 90% of mass' },
      { k: 'info gain', v: `${(s.information_gain ?? 0).toFixed(3)}`, s: 'D_KL(posterior ‖ prior), nats' },
      { k: 'modes', v: `${s.modes ?? '—'}`, s: 'distinct high-probability basins' },
      { k: 'particle ESS', v: Number(ess).toFixed(0), s: `${s.resamples ?? 0} resamples so far` },
    ];

    this.root.innerHTML = `
      <div class="mx-tabs" role="tablist" aria-label="Which matrix to display">
        ${VIEWS.map((v) => `<button class="mx-tab${v.key === active.key ? ' is-on' : ''}" type="button"
            role="tab" aria-selected="${v.key === active.key}" data-matrix="${v.key}">${v.label}</button>`).join('')}
      </div>
      <p class="mx-note">${active.note}</p>
      <div class="mx-grid" style="grid-template-columns:repeat(${W}, minmax(0, 1fr))" role="img"
           aria-label="Numeric ${active.label.toLowerCase()} matrix over the ${W} by ${H} grid">${cells}</div>
      <dl class="mx-stats">
        ${tags.map((t) => `<div><dt>${t.k}</dt><dd class="mono">${t.v}</dd><small>${t.s}</small></div>`).join('')}
      </dl>
      <div class="duel">
        <span class="duel-head mono">filter duel</span>
        <div class="duel-row">
          <span>grid MAP</span><b class="mono">(${s.peak.x},${s.peak.y})</b>
          <span>particle mean</span><b class="mono">(${(s.particle_estimate || [0, 0]).map((n) => Number(n).toFixed(1)).join(',')})</b>
          <span>gap</span><b class="mono" style="color:${gap > 2 ? palette.red : gap > 1 ? palette.warning : palette.success}">${gap.toFixed(2)} cells</b>
          <span>spread</span><b class="mono">σ ${(s.particle_spread ?? 0).toFixed(2)}</b>
        </div>
        <p class="small">${gap > 2
          ? 'The two estimators disagree by more than two cells: the posterior is multimodal, so the peak cell is one hypothesis among several — not a location.'
          : 'Both estimators agree. A small gap means the mass really has concentrated somewhere.'}</p>
      </div>`;

    if (this.hint) {
      this.hint.textContent = `${W}×${H} · ${active.label.toLowerCase()} peak ${(max * 100).toFixed(1)}%`;
    }
  }
}
