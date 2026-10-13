/**
 * ActionLog.js — Stylized, auto-scrolling trace console.
 * -----------------------------------------------------------------------------
 * One row group per simulation step, colour-coded by action tag so the mission
 * reads like a spacecraft downlink:
 *
 *   [MOVE]     rust   — a navigation decision (with the agent's position after it)
 *   [SCAN]     cyan   — an information-gathering action
 *   [RECHARGE] green  — energy recovery at a station
 *   [INIT]     faint  — the mission brief emitted by POST /reset
 *   [FAIL]     red    — a rejected/blocked action (still costs energy!)
 *
 * Each step logs three layers, which is exactly the structure of the agent's
 * reasoning trace:  action+outcome  ->  observation  ->  reasoning/strategy.
 *
 * Auto-scroll policy: we stick to the bottom ONLY when the user is already near
 * it. If they scrolled up to read history, incoming steps must not yank the view
 * away — the single most common annoyance in live consoles.
 */
import { humanize, padStep, fixed } from '../utils/format.js';

/** How close to the bottom (px) still counts as "following the tail". */
const FOLLOW_THRESHOLD = 48;

/** Map an action to its tag label + CSS class. */
function tagOf(entry) {
  if (entry.action === 'scan') return { label: 'SCAN', cls: 'tag--scan' };
  if (entry.action === 'recharge') return { label: 'RECHARGE', cls: 'tag--recharge' };
  if (entry.action === 'init') return { label: 'INIT', cls: 'tag--init' };
  return { label: 'MOVE', cls: 'tag--move' };
}

export class ActionLog {
  /** @param {HTMLElement} root the scroll container */
  constructor(root) {
    this.root = root;
    this.entryCount = 0;
  }

  /** Remove every line (used on reset). */
  clear() {
    this.root.replaceChildren();
    this.entryCount = 0;
    this._empty();
  }

  /** Show the placeholder seen before the first mission starts. */
  _empty() {
    const p = document.createElement('p');
    p.className = 'log-empty';
    p.textContent = '// no telemetry yet — press Start / Reset to launch a mission';
    this.root.appendChild(p);
  }

  /** True when the view is pinned near the bottom (so we may auto-scroll). */
  get following() {
    const { scrollTop, scrollHeight, clientHeight } = this.root;
    return scrollHeight - (scrollTop + clientHeight) <= FOLLOW_THRESHOLD;
  }

  /** Scroll to the newest line. */
  scrollToEnd() {
    this.root.scrollTop = this.root.scrollHeight;
  }

  /**
   * Append one free-form system line (resets, errors, connection loss).
   * @param {string} text
   * @param {'is-sys'|'is-fail'|string} [cls]
   */
  system(text, cls = 'is-sys') {
    const stick = this.following;
    const line = document.createElement('p');
    line.className = `log-line ${cls}`;
    line.textContent = text;
    this.root.appendChild(line);
    if (stick) this.scrollToEnd();
  }

  /**
   * Render one trace entry as a colour-tagged row group.
   * @param {import('../types.js').TraceEntry} entry
   */
  push(entry) {
    const stick = this.following;              // decide BEFORE mutating the DOM
    // The placeholder is a promise that there is nothing here yet, so the first
    // real entry has to retract it — otherwise the console keeps an "empty"
    // notice pinned above 39 steps of actual telemetry.
    const empty = this.root.querySelector('.log-empty');
    if (empty) empty.remove();
    const tag = tagOf(entry);
    const group = document.createElement('div');
    group.className = `log-step ${entry.ok ? 'is-ok' : 'is-fail'}`;

    // ---- line 1: the action itself, plus the outcome of that action --------
    const fail = !entry.ok ? { label: 'FAIL', cls: 'tag--fail' } : tag;
    const note = entry.note ? `  (${entry.note})` : '';
    group.appendChild(this._line(
      fail,
      `[${padStep(entry.step)}] ${entry.action} → (${entry.position.x},${entry.position.y})` +
      `  batt ${entry.battery}  cost ${entry.energy_cost}${note}`,
    ));

    // ---- line 2: what the sensors reported (the evidence) -----------------
    const sig = entry.observation.signal;
    if (sig) {
      const bearing = sig.bearing == null ? 'n/a' : `${sig.bearing}°`;
      group.appendChild(this._line(
        { label: 'OBS', cls: 'tag--scan' },
        `signal/${sig.kind}: strength ${fixed(sig.strength)} · bearing ${bearing}`,
        'is-obs',
      ));
    }
    // Clues are the only way the agent learns about EVE, so log each pickup with
    // its noisy hint and the ±sigma uncertainty it carries.
    entry.observation.clues.forEach((c) => {
      group.appendChild(this._line(
        { label: 'CLUE', cls: 'tag--scan' },
        `clue #${c.id} @ (${c.pos[0]},${c.pos[1]}) hints (${c.hint[0]},${c.hint[1]}) ±${c.sigma}`,
        'is-obs',
      ));
    });

    // ---- line 3: the decision rationale + Bayesian read-out --------------
    group.appendChild(this._line(
      { label: 'WHY', cls: 'tag--init' },
      `${entry.reasoning} [${humanize(entry.strategy)} · entropy ${fixed(entry.entropy)} · peak ` +
      `(${entry.belief_peak.x},${entry.belief_peak.y}) ${(entry.belief_peak.p * 100).toFixed(0)}%]`,
      'is-why',
    ));

    this.root.appendChild(group);
    this.entryCount += 1;
    if (stick) this.scrollToEnd();
  }

  /**
   * Build one monospace line: a fixed-width tag then the text.
   * @param {{label:string, cls:string}} tag
   * @param {string} text
   * @param {string} [extraCls]
   */
  _line(tag, text, extraCls = '') {
    const p = document.createElement('p');
    p.className = `log-line ${extraCls}`.trim();
    const span = document.createElement('span');
    span.className = `tag ${tag.cls}`;
    span.textContent = tag.label;
    p.appendChild(span);
    p.appendChild(document.createTextNode(text));
    return p;
  }
}
