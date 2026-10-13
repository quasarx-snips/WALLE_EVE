/**
 * store.js — A tiny observable store (the vanilla-JS stand-in for Redux).
 * -------------------------------------------------------------------------
 * The whole dashboard reads from ONE immutable snapshot and re-renders on
 * change. This replaces the React Context/useReducer pattern: components call
 * `store.getState()` to read and `store.setState(partial)` to update, then
 * `subscribe(fn)` to react. Every setState bumps a monotonic `version` so
 * animation loops (e.g. the grid pulse) can cheaply detect change.
 *
 * State shape (see types.js for full docs):
 *   - status:   'idle' | 'loading' | 'ready' | 'error'   (UI lifecycle, not mission)
 *   - sim:      SimulationState | null                    (latest snapshot)
 *   - entry:    TraceEntry | null                         (latest step, for the pulse)
 *   - report:   MissionReport | null                      (set when the mission ends)
 *   - error:    string | null                             (last API/connection error)
 *   - autoRunning: boolean                                (auto-run loop active)
 *   - busy:     boolean                                   (a request is in flight)
 *   - entropySeries: {step:number, entropy:number}[]      (for the live line chart)
 *   - version:  number                                    (monotonic change counter)
 */
export function createStore(initial = {}) {
  let state = {
    status: 'idle',
    sim: null,
    entry: null,
    report: null,
    error: null,
    autoRunning: false,
    busy: false,
    entropySeries: [],
    version: 0,
    ...initial,
  };
  const listeners = new Set();

  return {
    getState: () => state,
    /**
     * Merge a partial update and notify subscribers.
     * @param {Partial<typeof state>} partial
     */
    setState(partial) {
      state = { ...state, ...partial, version: state.version + 1 };
      listeners.forEach((fn) => fn(state));
    },
    /** @param {(s: typeof state) => void} fn */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Push a new {step, entropy} sample, keeping the series bounded so the chart
 * never grows unbounded during very long runs (defensive; max_steps is 150).
 * @param {{step:number, entropy:number}[]} series
 * @param {{step:number, entropy:number}} sample
 * @param {number} [cap]
 */
export function appendEntropy(series, sample, cap = 1000) {
  const next = series.length >= cap ? series.slice(series.length - cap + 1) : series.slice();
  next.push(sample);
  return next;
}
