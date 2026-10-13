/**
 * MissionControls.js — Play / Pause / Step / Reset with state-driven buttons.
 * -----------------------------------------------------------------------------
 * The buttons are declared in index.html (so the markup stays readable) and this
 * class only OWNS them: it binds clicks, drives disabled/label states from the
 * simulation status, and exposes keyboard shortcuts.
 *
 * Button state truth table (S = simulation state):
 *   idle / loading   Reset enabled · Step disabled · Auto-Run disabled · Briefing disabled
 *   running          Reset enabled · Step enabled  · Auto-Run enabled  · Briefing enabled
 *   done             Reset enabled · Step DISABLED · Auto-Run disabled · Briefing enabled
 *
 * The auto-run toggle label flips Auto-Run <-> Pause and shows the pause glyph, so
 * the operator always knows which way the switch will move.
 */
export class MissionControls {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.resetBtn
   * @param {HTMLElement} opts.stepBtn
   * @param {HTMLElement} opts.autoBtn
   * @param {HTMLElement} opts.reportBtn
   * @param {HTMLElement} opts.autoLabel  text span inside the auto button
   * @param {HTMLElement} opts.autoIcon   <use> element swapped between play/pause
   * @param {HTMLElement} opts.randomize  checkbox
   * @param {HTMLElement} opts.seed       number input
   * @param {HTMLElement} [opts.difficulty] select for the difficulty dial
   * @param {HTMLElement} opts.alert      error banner (p.alert)
   * @param {HTMLElement} opts.alertText  span inside the banner
   * @param {HTMLElement} opts.logClear   "clear" mini button
   * @param {() => void} opts.onReset
   * @param {() => void} opts.onStep
   * @param {() => void} opts.onToggleAuto
   * @param {() => void} opts.onOpenReport
   * @param {() => void} opts.onClearLog
   */
  constructor(opts) {
    this.o = opts;
    this.autoRunning = false;
    this.canStep = false;

    opts.resetBtn.addEventListener('click', () => opts.onReset());
    opts.stepBtn.addEventListener('click', () => opts.onStep());
    opts.autoBtn.addEventListener('click', () => opts.onToggleAuto());
    opts.reportBtn.addEventListener('click', () => opts.onOpenReport());
    opts.logClear.addEventListener('click', () => opts.onClearLog());

    // Keyboard shortcuts. Space is the natural "run/pause" key for a console, but
    // it also scrolls the page and toggles focused checkboxes, so we filter:
    //   - ignore repeats (held key) and anything typed into an input/select,
    //   - preventDefault on Space so the viewport/checkbox doesn't move.
    this._onKey = (e) => {
      const t = e.target;
      const typing = t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (!opts.autoBtn.disabled) opts.onToggleAuto();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (!opts.stepBtn.disabled) opts.onStep();
      } else if (e.key === 'r' || e.key === 'R') {
        opts.onReset();
      }
    };
    window.addEventListener('keydown', this._onKey);
  }

  /**
   * Reset payload for POST /reset — reads the option inputs.
   * @returns {{randomize:boolean, seed?:number, difficulty:string}}
   */
  options() {
    const raw = this.o.seed.value.trim();
    const seed = raw === '' ? undefined : Number.parseInt(raw, 10);
    return {
      randomize: this.o.randomize.checked,
      seed: Number.isFinite(seed) ? seed : undefined,
      difficulty: this.o.difficulty ? this.o.difficulty.value : 'standard',
    };
  }

  /**
   * Sync button states with the latest snapshot.
   * @param {boolean} hasSim       a simulation snapshot exists
   * @param {Object} flags
   * @param {boolean} flags.done   mission finished
   * @param {boolean} flags.busy   a /step request is in flight
   * @param {boolean} flags.autoRunning
   */
  sync(hasSim, { done, busy, autoRunning }) {
    const active = hasSim && !done;
    // While a request is in flight the Step/Auto buttons lock, so a human cannot
    // queue a second overlapping step on top of the auto-run loop.
    this.o.stepBtn.disabled = !active || busy;
    this.o.autoBtn.disabled = !active || busy;
    this.o.reportBtn.disabled = !hasSim;
    this.o.resetBtn.disabled = busy;

    this.autoRunning = autoRunning;
    this.o.autoBtn.classList.toggle('is-active', autoRunning);
    this.o.autoLabel.textContent = autoRunning ? 'Pause' : 'Auto-Run';
    this.o.autoIcon.setAttribute('href', autoRunning ? '#i-pause' : '#i-play');
    this.o.autoBtn.title = autoRunning ? 'Pause the auto-run loop' : 'Advance the mission automatically';
  }

  /** Show/hide the connection-error banner. @param {string|null} message */
  setError(message) {
    if (!message) {
      this.o.alert.hidden = true;
      this.o.alertText.textContent = '';
      return;
    }
    this.o.alertText.textContent = message;
    this.o.alert.hidden = false;
  }

  /** Detach the global keyboard listener (leak hygiene on teardown). */
  destroy() {
    window.removeEventListener('keydown', this._onKey);
  }
}
