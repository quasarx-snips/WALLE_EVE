/**
 * StatsDashboard.js — the live evaluation panel.
 * -----------------------------------------------------------------------------
 * A thin view: it reads one store snapshot and lays out the six figures built by
 * charts.js. Keeping the drawing code out of this class means the landing page
 * can render the same figures from a recorded run without importing a dashboard
 * component, and it means the maths can be reasoned about (and tested) without a
 * browser in the loop.
 *
 * The metrics come from the SERVER, which scores every step against the hidden
 * truth. They are deliberately never fed back into the agent's decisions: these
 * are report cards, not inputs.
 */
import {
  entropyChart,
  informationChart,
  reliabilityChart,
  rocChart,
  confusionChart,
  actionRadar,
} from '../charts.js';
import { humanize } from '../utils/format.js';

/* ------------------------------------------------------------------ component */

export class StatsDashboard {
  /**
   * @param {HTMLElement} root   container that receives both charts
   * @param {HTMLElement} [hint] panel-hint element for the one-line summary
   */
  constructor(root, hint) {
    this.root = root;
    this.hint = hint;
    this.root.innerHTML = '<p class="log-empty">// diagnostics appear once the mission starts</p>';
  }

  /**
   * @param {import('../types.js').SimulationState} s
   * @param {{step:number, entropy:number}[]} series
   */
  render(s, series) {
    // Server-side metrics are authoritative (they are computed against ground
    // truth); the local entropy series only feeds the first chart, which needs a
    // sample per step even before the server has scored one.
    const m = s.metrics || {};
    const entropy = entropyChart(series, { done: s.done, status: s.status });
    const spawn = informationChart(m.information_gain_series || []);
    const reliability = reliabilityChart(m.calibration || []);
    const roc = rocChart(m.roc || { points: [], auc: 0 });
    const radar = actionRadar(s.counts);
    const spend = s.steps ? (s.spent.move + s.spent.scan) / s.steps : 0;
    const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : '—');

    this.root.innerHTML = `
      <figure class="chart chart--wide">
        <div class="chart-cap">
          <span>Belief entropy vs. step <b class="mono">${s.entropy.toFixed(3)}</b></span>
          <span class="mono">lower = the filter is converging</span>
        </div>
        ${entropy}
        <figcaption class="chart-cap">
          <span>Uncertainty ${s.entropy < 0.35 ? 'low' : s.entropy < 0.6 ? 'moderate' : 'high'}</span>
          <span class="mono">${humanize(s.status)}</span>
        </figcaption>
      </figure>

      <figure class="chart chart--wide">
        <div class="chart-cap">
          <span>Information gain per observation <b class="mono">${fmt(m.information_gain_mean, 4)}</b></span>
          <span class="mono">nats of KL divergence, this run</span>
        </div>
        ${spawn}
        <figcaption class="chart-cap">
          <span>${(m.information_gain_mean || 0) < 0.02
            ? 'Near-zero bars: readings inside a beacon\u2019s field carry no information about EVE.'
            : 'Tall bars are readings that actually moved the posterior.'}</span>
          <span class="mono">Σ ${fmt(m.information_gain_total, 2)} nats</span>
        </figcaption>
      </figure>

      <figure class="chart">
        <div class="chart-cap"><span>Calibration <b class="mono">${fmt(m.mean_within_1_cell_mass, 2)}</b></span><span class="mono">trust vs. hit rate</span></div>
        ${reliability}
        <figcaption class="chart-cap">
          <span>mean mass within 1 cell</span>
          <span class="mono">on the diagonal = honest</span>
        </figcaption>
      </figure>

      <figure class="chart">
        <div class="chart-cap"><span>Ranking quality <b class="mono">${fmt(m.top1_accuracy, 2)}</b></span><span class="mono">ROC-AUC ${fmt(m.auc, 3)}</span></div>
        ${roc}
        <figcaption class="chart-cap">
          <span>top-1 ${fmt(m.top1_accuracy, 2)} · top-3 ${fmt(m.top3_accuracy, 2)}</span>
          <span class="mono">log loss ${fmt(m.log_loss, 2)}</span>
        </figcaption>
      </figure>

      <figure class="chart chart--wide">
        <div class="chart-cap"><span>Detection \u2014 \u201cwithin one cell?\u201d</span><span class="mono">threshold 0.50 posterior mass</span></div>
        ${confusionChart(m.detection)}
        <figcaption class="chart-cap">
          <span>Brier ${fmt(m.brier, 5)} \u00b7 mean rank pct ${fmt(m.mean_rank_percentile, 3)}</span>
          <span class="mono">credible set \u00f8 ${fmt(m.mean_credible_set_90, 1)} cells</span>
        </figcaption>
      </figure>

      <figure class="chart">
        <div class="chart-cap">
          <span>Action mix <b class="mono">${s.steps}</b></span>
          <span class="mono">${spend.toFixed(2)} energy/step</span>
        </div>
        ${radar}
        <figcaption class="chart-cap">
          <span class="mono">mv ${s.counts.move} · sc ${s.counts.scan} · bl ${s.counts.blocked} · rc ${s.counts.recharge}</span>
          <span class="mono">clues ${s.clues_found.length}/${s.clue_total}</span>
        </figcaption>
      </figure>`;

    if (this.hint) {
      this.hint.textContent = `step ${s.steps}/${s.max_steps} · entropy ${s.entropy.toFixed(2)} · ` +
        `${(s.peak.p * 100).toFixed(0)}% peak · AUC ${fmt(m.auc, 3)}`;
    }
  }
}

