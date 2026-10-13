/**
 * ReportModal.js — Post-mission briefing.
 * -----------------------------------------------------------------------------
 * Renders the `/report` payload as a structured debrief: outcome badge, headline
 * metrics grid, the clues the agent managed to collect, and the recommended next
 * step for a follow-up mission. Also offers the full trace as a JSON download.
 *
 * Implementation notes:
 *   - The markup is regenerated on every open, so click handlers are DELEGATED
 *     from the never-replaced container instead of re-bound per render.
 *   - The dialog can be opened mid-mission too (status `running`), which is what
 *     the Briefing button does: it fetches GET /report on demand.
 */
import { humanize, pct } from '../utils/format.js';

/** Status -> badge label + CSS modifier. */
const OUTCOMES = {
  eve_found: { label: 'EVE located', cls: 'badge--ok' },
  battery_depleted: { label: 'Battery depleted', cls: 'badge--bad' },
  time_expired: { label: 'Time expired', cls: 'badge--warn' },
  running: { label: 'In progress', cls: 'badge--info' },
};

export class ReportModal {
  /**
   * @param {HTMLDialogElement} dialog the <dialog> element
   * @param {HTMLElement} root         container inside the dialog
   * @param {{onNewMission?: () => void}} [hooks]
   */
  constructor(dialog, root, hooks = {}) {
    this.dialog = dialog;
    this.root = root;
    this.hooks = hooks;
    /** @type {import('../types.js').MissionReport|null} */
    this.report = null;

    this.root.addEventListener('click', (e) => {
      const btn = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'close') this.close();
      else if (action === 'new') {
        this.close();
        if (this.hooks.onNewMission) this.hooks.onNewMission();
      } else if (action === 'download') this.download();
    });
  }

  /** @param {import('../types.js').MissionReport} report */
  show(report) {
    this.report = report;
    this.root.innerHTML = this._template(report);
    if (!this.dialog.open) this.dialog.showModal();
  }

  close() {
    if (this.dialog.open) this.dialog.close();
  }

  /**
   * Download the briefing (including the full action trace) as JSON — the same
   * artefact the backend writes to mission_trace.json when a mission ends.
   */
  download() {
    if (!this.report) return;
    const blob = new Blob([JSON.stringify(this.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wall-e-briefing-${this.report.status}-${this.report.steps_used}steps.json`;
    a.click();
    URL.revokeObjectURL(url);       // release the blob once the download starts
  }

  /* ------------------------------------------------------------------ view */

  /** @param {import('../types.js').MissionReport} r @returns {string} */
  _template(r) {
    const outcome = OUTCOMES[r.status] || { label: humanize(r.status), cls: 'badge--info' };
    const found = r.eve_found;
    const inferred = `(${r.inferred_location.x},${r.inferred_location.y})`;
    const actual = r.eve_actual_position ? `(${r.eve_actual_position[0]},${r.eve_actual_position[1]})` : 'withheld';
    const distance = r.eve_actual_position
      ? Math.max(Math.abs(r.eve_actual_position[0] - r.inferred_location.x),
        Math.abs(r.eve_actual_position[1] - r.inferred_location.y))
      : null;

    // Each cell = label + monospace value (+ optional explainer line).
    const cell = (label, value, note = '') =>
      `<div class="brief-cell"><dt>${label}</dt><dd>${value}${note ? `<small>${note}</small>` : ''}</dd></div>`;

    const clues = r.clues_found.length
      ? `<div class="brief-clues">${r.clues_found.map((c) =>
        `<span class="clue-tag">#${c.id} @ (${c.pos[0]},${c.pos[1]}) → hint (${c.hint[0]},${c.hint[1]})</span>`).join('')}</div>`
      : '<p class="log-empty">no clues collected — the agent never entered a clue cell</p>';

    return `
      <div class="modal-inner">
        <header class="brief-head">
          <div>
            <h3 id="report-title">Mission briefing</h3>
            <p class="brief-sub mono">${r.steps_used} steps used · ${r.battery_remaining} battery left · seed-stable trace available</p>
          </div>
          <span class="badge ${outcome.cls}">${outcome.label}</span>
        </header>

        <dl class="brief-grid">
          ${cell('EVE located', found ? 'YES' : 'NO', found ? 'agent stepped onto EVE’s cell' : 'mission ended first')}
          ${cell('EVE actual cell', actual, found ? 'revealed at mission end' : 'revealed only when done')}
          ${cell('Inferred cell', inferred, `${pct(r.confidence, 1)} at that cell`)}
          ${cell('Within 1 cell', pct(r.confidence_within_1_cell, 1),
            distance === null ? 'belief mass, Chebyshev radius 1' : `true error: ${distance} cell${distance === 1 ? '' : 's'}`)}
          ${cell('Clues found', `${r.clues_found.length} / ${r.clues_total}`)}
          ${cell('Energy spent', `${r.energy_spent.move} mv / ${r.energy_spent.scan} sc`,
            'moving / scanning, in battery units')}
          ${cell('Actions', `${r.actions.move} mv · ${r.actions.scan} sc`,
            `${r.actions.recharge} recharge · ${r.actions.blocked} blocked`)}
          ${cell('Steps used', String(r.steps_used))}
        </dl>

        <section>
          <div class="chart-cap"><span>Clue evidence</span><span class="mono">${r.clues_found.length} of ${r.clues_total} tokens</span></div>
          ${clues}
        </section>

        <p class="brief-note"><b>Recommended next step</b>${r.recommended_next_step}</p>

        <footer class="brief-actions">
          <button class="btn btn--primary" type="button" data-action="download">
            <svg class="icon" aria-hidden="true"><use href="#i-download"></use></svg><span>Download trace JSON</span>
          </button>
          <button class="btn" type="button" data-action="new">
            <svg class="icon" aria-hidden="true"><use href="#i-reset"></use></svg><span>New mission</span>
          </button>
          <button class="btn btn--ghost" type="button" data-action="close"><span>Close</span></button>
        </footer>
      </div>`;
  }
}
