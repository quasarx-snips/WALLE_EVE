/**
 * types.js — Single source of truth for the dashboard's data contract.
 * -------------------------------------------------------------------------
 * These JSDoc `@typedef`s mirror, field-for-field, the JSON emitted by the
 * Flask backend in app.py. Because this project is plain JavaScript (no
 * TypeScript build step), we document the shapes here so IDEs can still offer
 * autocomplete/type-checking via JSDoc, and so the ML semantics of every
 * number are explicit.
 *
 * Coordinate convention (from app.py):
 *   - A cell is an (x, y) pair; x grows right, y grows DOWNWARD.
 *   - `belief` is indexed [y][x] (row-major), matching numpy array order.
 *   - `state.pos`, `peak.x/.y`, `entry.position` are all (x, y).
 */

/**
 * @typedef {[number, number]} Cell            A grid coordinate [x, y].
 */

/**
 * @typedef {'running'|'eve_found'|'battery_depleted'|'time_expired'} MissionStatus
 * Terminal status of the simulation. 'running' => not done.
 */

/**
 * @typedef {'init'|'move_up'|'move_down'|'move_left'|'move_right'|'scan'|'recharge'} ActionKind
 * Every discrete action the agent can emit.
 */

/**
 * @typedef {'searching'|'homing'|'recharging'|'scanning'|'error'} StrategyKind
 * The agent's high-level intent for a step (maps to the `strategy` field).
 */

/**
 * @typedef {Object} Signal
 * @property {'initial'|'passive'|'scan'} kind  Reading type.
 * @property {number} strength                  Observed signal strength in [0,1] (noisy).
 * @property {number|null} bearing              Degrees, -180..180; null for passive reads.
 */

/**
 * @typedef {Object} Clue
 * @property {number} id
 * @property {Cell} pos                         Where the clue token sits on the grid.
 * @property {Cell} hint                        Noisy pointer toward EVE (revealed on pickup).
 * @property {number} sigma                     Hint uncertainty radius, in cells.
 */

/**
 * @typedef {Object} BeliefPeak
 * @property {number} x                         argmax column of the belief map.
 * @property {number} y                         argmax row of the belief map.
 * @property {number} p                         Probability mass at that cell.
 */

/**
 * @typedef {number[][]} Matrix  A grid indexed [y][x].
 */

/**
 * A registered decoy beacon. Its position AND nominal amplitude are on the
 * agent's own map: the beacons are fixed infrastructure, not a surprise. The
 * difficulty is that a strength reading near one is explained without EVE.
 * @typedef {Object} Decoy
 * @property {Cell} pos
 * @property {number} amplitude                 Relative emitter strength, < 1.
 */

/**
 * One bin of the reliability diagram.
 * @typedef {Object} CalibrationBin
 * @property {number} bin                       0..9
 * @property {number} lo                        Lower edge of the trust interval.
 * @property {number} hi                        Upper edge.
 * @property {number} n                         Steps that fell in this bin.
 * @property {number} predicted                 Mean trust the agent had.
 * @property {number} observed                  How often it was actually right.
 */

/**
 * The 2x2 detection matrix for "am I within one cell of EVE?", predicted yes
 * when the agent's own 3x3 neighbourhood holds >= 0.5 of the posterior mass.
 * @typedef {Object} Detection
 * @property {number} tp
 * @property {number} fp
 * @property {number} tn
 * @property {number} fn
 * @property {number} precision
 * @property {number} recall
 */

/**
 * ROC over pooled per-step cells (score = that cell's posterior, label = is it
 * the true cell). AUC is therefore read as "how well does posterior mass rank
 * the truth", averaged across the whole run.
 * @typedef {Object} Roc
 * @property {[number, number][]} points        [[fpr, tpr], ...], down-sampled.
 * @property {number} auc
 */

/**
 * Evaluation metrics. Computed server-side against the HIDDEN truth and never
 * fed back into the agent's decisions — these are scores, not inputs.
 * @typedef {Object} Metrics
 * @property {number} steps_scored
 * @property {number} log_loss                  Mean negative log probability at EVE's true cell (nats).
 * @property {number} brier                     Mean Brier score over free cells.
 * @property {number} top1_accuracy             Share of steps where the argmax cell was correct.
 * @property {number} top3_accuracy             Share where the truth was in the top three cells.
 * @property {number} mean_rank_percentile      Mean rank of the true cell as a fraction of grid size (lower is better).
 * @property {number} auc                       ROC-AUC of the posterior's cell ranking.
 * @property {number} information_gain_total    Sum of D_KL(posterior || prior), in nats.
 * @property {number} information_gain_mean     Per-observation information gain.
 * @property {number} mean_within_1_cell_mass   Mean posterior mass in the true cell's 3x3 neighbourhood.
 * @property {number} mean_credible_set_90      Mean size of the 90% credible set, in cells.
 * @property {Detection} detection
 * @property {CalibrationBin[]} calibration
 * @property {Roc} roc
 * @property {number[]} information_gain_series Per-step KL, for the chart.
 */

/**
 * The full simulation snapshot. Returned inside every /reset and /step response.
 * @typedef {Object} SimulationState
 * @property {number} width                     Grid columns.
 * @property {number} height                    Grid rows.
 * @property {Cell} pos                         WALL-E's current [x, y].
 * @property {Cell[]} path                      Ordered trail of visited cells (breadcrumb history).
 * @property {Cell[]} obstacles                 Static, impassable cells.
 * @property {Matrix} belief                    Bayesian posterior; belief[y][x] sums to 1 over free cells.
 * @property {Matrix} prior                     The belief BEFORE the last observation update.
 * @property {Matrix} likelihood                P(last reading | EVE at cell) — evidence, not belief.
 * @property {Cell[]} particles                 Particle-cloud sample, for the overlay.
 * @property {Cell} particle_estimate           Particle filter's weighted mean (may be fractional).
 * @property {number} particle_spread           RMS spread of the cloud, in cells.
 * @property {number} ess                       Particle effective sample size.
 * @property {number} resamples                 Cumulative resampling events.
 * @property {number} filter_gap                Distance between the grid MAP and the particle mean.
 * @property {number} belief_uncertainty        Alias of `entropy`, kept for clarity in the matrix panel.
 * @property {number} credible_set_90           Cells needed to cover 90% of the posterior.
 * @property {number} modes                     Distinct high-probability basins.
 * @property {number} information_gain          D_KL(posterior || prior) for the last observation.
 * @property {number} battery                   Current charge.
 * @property {number} battery_max               Maximum charge.
 * @property {number} steps                     Steps consumed so far.
 * @property {number} max_steps                 Time budget.
 * @property {{move:number, scan:number}} spent Energy spent by category.
 * @property {{move:number, scan:number, recharge:number, blocked:number}} counts  Action tallies.
 * @property {number} energy_pool               Initial battery + total recharged (for % bars).
 * @property {{pos:Cell, charges:number}[]} stations  Recharge pads with remaining charges.
 * @property {Clue[]} clues_found               Clues the agent has picked up.
 * @property {number} clue_total                Total clues in the scenario.
 * @property {BeliefPeak} peak                  Agent's current best hypothesis.
 * @property {number} entropy                   Normalized Shannon entropy in [0,1] (0 = certain).
 * @property {MissionStatus} status
 * @property {boolean} done                     True when status !== 'running'.
 * @property {boolean} found                    True iff EVE was located.
 * @property {Cell|null} eve                    Ground-truth EVE cell; revealed ONLY when done.
 * @property {Cell[]} decoys                    Decoy beacon positions (always visible: they are known).
 * @property {Metrics} metrics                  Evaluation scores for the run so far.
 */

/**
 * The replay handle returned by /reset and echoed back on /step. Because the
 * simulation is a pure function of this tuple, the server can rebuild the exact
 * mission from it — which is what makes /step idempotent and the API usable
 * behind a load balancer or in a serverless function.
 * @typedef {Object} Scenario
 * @property {number} seed
 * @property {string} difficulty                'calm' | 'standard' | 'pursuit'
 * @property {Cell} eve                         The (randomised) target cell, part of the scenario.
 */

/**
 * The dashboard's whole UI state (see store.js).
 * @typedef {Object} DashboardState
 * @property {'idle'|'loading'|'ready'|'error'} status
 * @property {SimulationState|null} sim
 * @property {TraceEntry|null} entry
 * @property {MissionReport|null} report
 * @property {string|null} error
 * @property {boolean} autoRunning
 * @property {boolean} busy
 * @property {{step:number, entropy:number}[]} entropySeries
 * @property {number} version
 */

/**
 * A single step of the agent's reasoning trace.
 * @typedef {Object} TraceEntry
 * @property {number} step
 * @property {ActionKind} action
 * @property {boolean} ok                       False for blocked / rejected actions (still costs energy).
 * @property {string} note                      Human-readable outcome, e.g. "blocked: obstacle".
 * @property {Cell} from                        Position before the action.
 * @property {{x:number, y:number}} position    Position after the action.
 * @property {number} battery                   Charge after the action.
 * @property {number} energy_cost               Energy this action consumed.
 * @property {{signal:(Signal|null), clues:Clue[]}} observation
 * @property {string} reasoning                 Natural-language explanation of the decision.
 * @property {StrategyKind} strategy
 * @property {BeliefPeak} belief_peak           Best hypothesis after the update.
 * @property {number} entropy                   Entropy after the update.
 * @property {number} information_gain          D_KL(posterior || prior) for this step's observation.
 * @property {number} credible_set_90           Cells covering 90% of the posterior.
 * @property {number} modes                     Distinct high-probability basins.
 * @property {number} ess                       Particle filter effective sample size.
 * @property {boolean} [drift]                  True if EVE relocated on this step.
 * @property {MissionStatus} status
 */

/**
 * Post-mission briefing from GET /report (also returned inline by /step when done).
 * @typedef {Object} MissionReport
 * @property {MissionStatus} status
 * @property {boolean} eve_found
 * @property {Cell|null} eve_actual_position
 * @property {{x:number, y:number}} inferred_location
 * @property {number} confidence                Probability at the inferred cell.
 * @property {number} confidence_within_1_cell  Probability mass within Chebyshev radius 1.
 * @property {Clue[]} clues_found
 * @property {number} clues_total
 * @property {number} battery_remaining
 * @property {number} steps_used
 * @property {{move:number, scan:number}} energy_spent
 * @property {{move:number, scan:number, recharge:number, blocked:number}} actions
 * @property {string} recommended_next_step
 * @property {TraceEntry[]} trace               Full step-by-step trace for download.
 */

/** Response of POST /reset. @typedef {{state:SimulationState, entry:TraceEntry}} ResetResponse */

/**
 * Response of POST /step.
 * @typedef {Object} StepResponse
 * @property {SimulationState} state
 * @property {TraceEntry|null} entry            Null once the mission has already ended.
 * @property {MissionReport|null} report        Populated only on the final step.
 * @property {string} message                   e.g. "mission already ended".
 */

// Frozen enums so callers never hard-code raw strings (defence against typos).
export const MissionStatus = Object.freeze({
  RUNNING: 'running',
  EVE_FOUND: 'eve_found',
  BATTERY_DEPLETED: 'battery_depleted',
  TIME_EXPIRED: 'time_expired',
});

export const StrategyKind = Object.freeze({
  SEARCHING: 'searching',
  HOMING: 'homing',
  RECHARGING: 'recharging',
  SCANNING: 'scanning',
});

