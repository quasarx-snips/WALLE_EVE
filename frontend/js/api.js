/**
 * api.js — fetch clients for the Flask endpoints.
 * -----------------------------------------------------------------------------
 * The dashboard is served from the same origin as the API (Flask serves both),
 * so we use RELATIVE URLs. No CORS headers are needed and there is no proxy.
 *
 * `/step` is deliberately IDEMPOTENT: it carries the scenario (seed, difficulty,
 * EVE's cell) and the index of the step being requested. The simulation is a
 * pure function of its scenario, so the server can rebuild the mission from
 * scratch and replay to that index if it has no warm instance. That makes the
 * API safe behind a load balancer, behind a serverless function that may not
 * still exist next request, and after a plain restart — and it means a
 * duplicated request can never advance the mission twice.
 *
 * Every function throws on network failure or a non-2xx response; callers are
 * expected to catch and surface the error (see useAutoRun / MissionControls).
 */

/**
 * Thin JSON POST/GET helper.
 * @param {string} url        Relative endpoint, e.g. '/step'.
 * @param {'GET'|'POST'} method
 * @param {object|null} [body] JSON-serialised request body (POST only).
 * @returns {Promise<any>}
 */
async function requestJSON(url, method, body = null) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Surface the server's message if it sent one, otherwise the status code.
    let detail = `${res.status} ${res.statusText}`;
    try {
      const err = await res.json();
      if (err && err.message) detail = err.message;
    } catch (_) { /* body wasn't JSON; keep the status text */ }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * POST /reset — start a fresh mission.
 * @param {{randomize?: boolean, seed?: number, difficulty?: string}} [options]
 * @returns {Promise<import('./types.js').ResetResponse>}
 */
export function resetMission(options = {}) {
  const body = {
    randomize: Boolean(options.randomize),
    difficulty: options.difficulty || 'standard',
  };
  if (options.seed !== undefined && options.seed !== null && Number.isFinite(options.seed)) {
    body.seed = options.seed;
  }
  return requestJSON('/reset', 'POST', body);
}

/**
 * POST /step — advance the agent by one decision, idempotently.
 * @param {import('./types.js').Scenario|null} [scenario] replay handle from /reset
 * @param {number|null} [step] index of the step to produce (default: next)
 * @returns {Promise<import('./types.js').StepResponse>}
 */
export function stepMission(scenario = null, step = null) {
  const body = {};
  if (scenario) body.scenario = scenario;
  if (step !== null && step !== undefined) body.step = step;
  if (!scenario && step === null) return requestJSON('/step', 'POST', {});
  return requestJSON('/step', 'POST', body);
}

/**
 * GET /report — fetch the post-mission briefing on demand.
 * @param {import('./types.js').Scenario|null} [scenario]
 * @returns {Promise<import('./types.js').MissionReport>}
 */
export function getReport(scenario = null) {
  const q = scenario ? `?scenario=${encodeURIComponent(JSON.stringify(scenario))}` : '';
  return requestJSON(`/report${q}`, 'GET');
}
