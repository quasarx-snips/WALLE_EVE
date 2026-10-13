/**
 * App.js — Composition root.
 * -----------------------------------------------------------------------------
 * Wires the single store to the five view components and owns the mission
 * lifecycle (reset -> step* -> done). Data flows one way:
 *
 *      user action → App handler → api.js (fetch) → store.setState()
 *                                                        │
 *                                     store.subscribe → render(state)
 *
 * Why a store instead of direct DOM calls: every component reads the SAME
 * immutable snapshot, so the canvas, the gauges, the charts and the log can never
 * disagree about what the agent just did. When a component needs to react to a
 * change it subscribes; nothing pushes into a component directly.
 *
 * Auto-run lives in useAutoRun.js: a self-correcting setTimeout chain that awaits
 * each /step before scheduling the next, so a slow backend slows the cadence
 * instead of stacking overlapping requests, and stopping is always leak-free.
 */
import { resetMission, stepMission, getReport } from './api.js';
import { createStore, appendEntropy } from './store.js';
import { createAutoRun } from './useAutoRun.js';
import { GridMap } from './components/GridMap.js';
import { TelemetryPanel } from './components/TelemetryPanel.js';
import { ActionLog } from './components/ActionLog.js';
import { StatsDashboard } from './components/StatsDashboard.js';
import { PosteriorPanel } from './components/PosteriorPanel.js';
import { MissionControls } from './components/MissionControls.js';
import { ReportModal } from './components/ReportModal.js';
import { humanize } from './utils/format.js';

/** Gap between auto-run steps (ms). The API round-trip is added on top. */
const AUTO_RUN_INTERVAL = 320;

export class App {
  /** @param {HTMLElement} root the dashboard container (#app) */
  constructor(root) {
    this.root = root;
    this.store = createStore();

    // ---- DOM hooks (queried once; components cache their own refs) --------
    const $ = (sel) => root.querySelector(sel);
    this.dom = {
      status: $('#hdr-status'),
      step: $('#hdr-step'),
      uptime: $('#hdr-uptime'),
      link: $('#hdr-link'),
      dot: $('#hdr-dot'),
      dims: $('#map-dims'),
    };

    this.telemetry = new TelemetryPanel($('[data-area="telemetry"]'));
    this.grid = new GridMap(
      document.getElementById('map-scene'),
      document.getElementById('map-overlay'),
      document.getElementById('map-stage'),
    );
    this.log = new ActionLog(document.getElementById('log-root'));
    this.stats = new StatsDashboard(document.getElementById('stats-root'), document.getElementById('stats-hint'));
    this.posterior = new PosteriorPanel(document.getElementById('matrix-root'), document.getElementById('matrix-hint'));
    this.report = new ReportModal(document.getElementById('report-modal'), document.getElementById('report-root'), {
      onNewMission: () => this.reset(),
    });

    this.controls = new MissionControls({
      resetBtn: $('#btn-reset'),
      stepBtn: $('#btn-step'),
      autoBtn: $('#btn-auto'),
      reportBtn: $('#btn-report'),
      autoLabel: $('#btn-auto-label'),
      autoIcon: $('#btn-auto-icon'),
      randomize: $('#opt-randomize'),
      seed: $('#opt-seed'),
      difficulty: $('#opt-difficulty'),
      alert: $('#alert'),
      alertText: $('#alert-text'),
      logClear: $('#log-clear'),
      onReset: () => this.reset(),
      onStep: () => this.step(),
      onToggleAuto: () => this.toggleAuto(),
      onOpenReport: () => this.openReport(),
      onClearLog: () => this.log.clear(),
    });

    this.autoRun = createAutoRun(
      () => this.step(),
      (err) => this.fail(err),
      () => AUTO_RUN_INTERVAL,
    );

    // Re-render whenever the snapshot changes (one renderer, many sources).
    this.store.subscribe((state) => this.render(state));

    // Mission clock (wall time since the dashboard booted), independent of the sim.
    this.clockFrom = Date.now();
    this._clockTimer = setInterval(() => this._updateClock(), 1000);

    this._lastSim = null;         // identity of the last fully rendered snapshot
    /** @type {import('./types.js').Scenario|null} replay handle returned by /reset */
    this.scenario = null;
  }

  /* ------------------------------------------------------- console handle */
  /* main.js publishes the App itself as `window.__walle` (the boot guard in
     mission.html waits for that global). These accessors are what make the
     handle useful from the console or from an automated probe. */

  /** @returns {import('./types.js').DashboardState} the current snapshot */
  getState() { return this.store.getState(); }

  /**
   * Observe every snapshot change.
   * @param {(s: import('./types.js').DashboardState) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) { return this.store.subscribe(fn); }

  /* ------------------------------------------------------------- lifecycle */

  /** Start a fresh mission. Reads the Randomize flag + optional seed.
   *  @param {{randomize?:boolean, seed?:number}} [opts] override the control panel. */
  async reset(opts) {
    this.autoRun.stop();
    this.controls.setError(null);
    this.log.clear();
    this.store.setState({ status: 'loading', busy: true, error: null, entry: null, report: null, entropySeries: [] });

    try {
      const data = await resetMission(opts || this.controls.options());
      this.scenario = data.scenario || null;
      this.clockFrom = Date.now();
      this.store.setState({
        status: 'ready',
        busy: false,
        sim: data.state,
        entry: data.entry,
        // Seed the entropy chart with the prior the filter starts from.
        entropySeries: data.entry ? [{ step: data.entry.step, entropy: data.entry.entropy }] : [],
      });
      this.log.push(data.entry);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Advance the mission by one decision. Safe to call from the auto-run loop or
   * from a button: a `busy` guard makes overlapping calls impossible.
   */
  async step() {
    const s = this.store.getState();
    if (s.busy || !s.sim || s.sim.done) return;
    this.store.setState({ busy: true });

    try {
      // The step index is sent from the client, which is what makes the call
      // idempotent: requesting step 12 twice produces step 12 twice.
      const data = await stepMission(this.scenario, s.sim.steps);
      const prev = this.store.getState();
      let series = prev.entropySeries;
      if (data.entry && (!series.length || series[series.length - 1].step !== data.entry.step)) {
        series = appendEntropy(series, { step: data.entry.step, entropy: data.entry.entropy });
      }
      this.store.setState({
        busy: false,
        error: null,
        sim: data.state,
        entry: data.entry,
        entropySeries: series,
        report: data.report || prev.report,
      });
      if (data.entry) this.log.push(data.entry);
      if (data.message) this.log.system(`// ${data.message}`, 'is-sys');

      // Mission over: stop the loop, narrate the outcome, open the briefing.
      if (data.state.done) {
        this.autoRun.stop();
        this.store.setState({ autoRunning: false });
        this.log.system(
          `// mission ended: ${humanize(data.state.status)} after ${data.state.steps} steps ` +
          `(${data.state.counts.move} moves, ${data.state.counts.scan} scans, ${data.state.counts.blocked} blocked)`,
          data.state.found ? 'is-obs' : 'is-note',
        );
        if (data.report) this.report.show(data.report);
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /** Start/stop the latency-safe auto-run loop. */
  toggleAuto() {
    const s = this.store.getState();
    if (!s.sim || s.sim.done) return;
    if (this.autoRun.isRunning()) {
      this.autoRun.stop();
      this.store.setState({ autoRunning: false });
      this.log.system('// auto-run paused', 'is-sys');
    } else {
      this.store.setState({ autoRunning: true });
      this.log.system('// auto-run engaged', 'is-sys');
      this.autoRun.start();
    }
  }

  /** Fetch GET /report on demand and show the briefing (works mid-mission). */
  async openReport() {
    try {
      const report = await getReport(this.scenario);
      this.report.show(report);
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Single failure path: stop the automation, surface the message in the banner
   * AND in the log, and keep the UI consistent (busy cleared).
   * @param {unknown} err
   */
  fail(err) {
    const message = err instanceof Error ? err.message : String(err);
    this.autoRun.stop();
    this.store.setState({ busy: false, autoRunning: false, error: `link error: ${message}` });
    this.log.system(`// connection to the simulation lost — ${message}`, 'is-fail');
  }

  /* ---------------------------------------------------------------- render */

  /**
   * Paint the whole dashboard from one snapshot.
   * @param {Object} state the store snapshot (see store.js for the full shape)
   */
  render(state) {
    const sim = state.sim;

    // ---- header chips ----------------------------------------------------
    this.dom.status.textContent = sim ? humanize(sim.status) : state.status === 'loading' ? 'linking' : 'idle';
    this.dom.status.style.color = state.error ? 'var(--error)' : sim && !sim.done ? 'var(--accent)' : sim ? 'var(--text)' : 'var(--text-3)';
    this.dom.step.textContent = sim ? `${sim.steps}/${sim.max_steps}` : '—';

    // Link lamp: dead = error, busy = request in flight, live = mission running.
    let lamp = { cls: 'dot', label: 'idle' };
    if (state.error) lamp = { cls: 'dot is-dead', label: 'error' };
    else if (state.busy) lamp = { cls: 'dot is-busy', label: 'syncing' };
    else if (sim && !sim.done) lamp = { cls: 'dot is-live', label: 'online' };
    else if (sim) lamp = { cls: 'dot', label: 'standby' };
    this.dom.dot.className = lamp.cls;
    this.dom.link.textContent = lamp.label;

    // ---- telemetry + charts + canvas ------------------------------------
    if (sim) {
      // Every /reset and /step response carries a NEW state object, so an
      // identity check is enough to skip redundant work: flipping `busy` needs to
      // update the header lamp, but it must not repaint the canvas or the charts.
      if (sim !== this._lastSim) {
        this._lastSim = sim;
        this.telemetry.render(sim);
        this.stats.render(sim, state.entropySeries);
        this.posterior.render(sim);
        this.dom.dims.textContent = `${sim.width} × ${sim.height}`;
        this.grid.update(sim, state.entry);
      }
    }

    // ---- controls --------------------------------------------------------
    this.controls.sync(Boolean(sim), {
      done: Boolean(sim && sim.done),
      busy: state.busy,
      autoRunning: state.autoRunning,
    });
    this.controls.setError(state.error);
  }

  /** mm:ss mission clock in the top bar. */
  _updateClock() {
    const total = Math.floor((Date.now() - this.clockFrom) / 1000);
    const mm = String(Math.floor(total / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    this.dom.uptime.textContent = `${mm}:${ss}`;
  }

  /** Tear everything down (used if the app is ever unmounted/rebooted). */
  destroy() {
    this.autoRun.dispose();
    clearInterval(this._clockTimer);
    this.grid.destroy();
    this.controls.destroy();
  }
}
