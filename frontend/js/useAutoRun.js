/**
 * useAutoRun.js — Latency-safe, leak-free auto-run driver.
 * -------------------------------------------------------------------------
 * WHY NOT setInterval(step, 350)?
 *   A naive interval fires on wall-clock time and IGNORES how long a /step
 *   request takes. If the API is slow, calls pile up, responses arrive out of
 *   order, and the UI desyncs from the simulation. If the component unmounts,
 *   the interval keeps firing forever (a memory leak + stray network traffic).
 *
 * THE FIX — a self-correcting setTimeout CHAIN:
 *   - Each tick calls the async `tickFn` and AWAITS it.
 *   - Only AFTER the response resolves do we schedule the NEXT tick.
 *   - `intervalMs` is therefore the *gap between* steps, not the period, so a
 *     slow backend simply slows the cadence instead of overlapping calls.
 *   - `stop()` clears any pending timer and flips a `running` flag; the loop
 *     checks that flag before rescheduling, so it halts cleanly. A `dispose()`
 *     hook tears everything down for good.
 *
 * The controller is framework-agnostic: hand it a `tickFn` (which should do the
 * fetch + state update) and start/stop/dispose it. It never touches the DOM.
 */

/**
 * @typedef {Object} AutoRunController
 * @property {() => boolean} isRunning
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => void} dispose
 */

/**
 * Create an auto-run controller.
 * @param {() => Promise<void>} tickFn   Advance one step; may throw (caught internally).
 * @param {(err: Error) => void} [onError] Called if a tick rejects, so we can stop + surface it.
 * @param {number} [getIntervalMs] Optional provider for the current delay; read fresh each tick.
 * @returns {AutoRunController}
 */
export function createAutoRun(tickFn, onError, getIntervalMs = () => 350) {
  let running = false;        // user-facing intent (start called)
  let timer = null;           // pending setTimeout handle
  let disposed = false;       // torn down permanently
  let active = false;         // a tick is currently executing (guard against overlap)

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const loop = async () => {
    // Re-check intent + lifecycle AFTER the await (state may have changed).
    if (!running || disposed || active) return;
    active = true;
    try {
      await tickFn();
    } catch (err) {
      // Stop immediately on failure so we don't hammer a dead backend, then
      // hand the error to the UI. We do NOT rethrow — this runs off the stack.
      stop();
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      return;
    } finally {
      active = false;
    }
    // Schedule the next tick only if still wanted and not torn down.
    if (running && !disposed) {
      clearTimer();
      timer = setTimeout(loop, Math.max(0, getIntervalMs()));
    }
  };

  function start() {
    if (running || disposed) return;
    running = true;
    // Kick off immediately; the loop handles subsequent scheduling.
    clearTimer();
    timer = setTimeout(loop, 0);
  }

  function stop() {
    running = false;
    clearTimer();
  }

  function dispose() {
    disposed = true;
    running = false;
    clearTimer();
  }

  return { isRunning: () => running && !disposed, start, stop, dispose };
}
