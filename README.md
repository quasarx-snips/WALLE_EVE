# WALL-E and EVE's Signal — autonomous Bayesian search

> **Goal (brief):** build an autonomous agent that explores a simulated
> environment, gathers clues, and manages limited resources to locate EVE and
> decide WALL-E's next move.

WALL-E searches a 14×14 grid world for a hidden, *moving* target (EVE) using
noisy signal readings and hint clues, under a battery and step budget. The
backend runs the simulation plus a Bayesian grid filter (with a second,
independent 400-particle filter for cross-checking); the front-end is a
mission-control dashboard that visualises the belief map, the agent's reasoning
trace, and the post-mission briefing.

**Live demo:** landing page `/` (recorded run you can audit) → **Open mission
control** → `/mission` (live lab).

---

## Table of contents

1. [Quickstart — run it](#1-quickstart--run-it)
2. [What was delivered (rubric map)](#2-what-was-delivered-rubric-map)
3. [Sample mission: config + trace + report](#3-sample-mission-config--trace--report)
4. [Environment design](#4-environment-design)
5. [Config format](#5-config-format)
6. [Agent design](#6-agent-design)
7. [API](#7-api)
8. [Project structure](#8-project-structure)
9. [Dashboard & visualisation](#9-dashboard--visualisation)
10. [Bonus / stretch coverage](#10-bonus--stretch-coverage)
11. [Verification performed](#11-verification-performed)
12. [Limitations & future work](#12-limitations--future-work)

---

## 1. Quickstart — run it

**Requirements:** Python ≥ 3.10, `pip`. The frontend has no build step
(plain HTML/CSS/JS ES modules served by Flask).

```bash
pip install -r requirements.txt   # flask + numpy, nothing else
python app.py                     # or: py app.py on Windows
```

Open <http://127.0.0.1:5000>. The landing page boots a recorded run; click
**Open mission control** (or go to `/mission`) for the live lab, which boots
straight into a fresh mission.

| Control | What it does |
| --- | --- |
| **Start / Reset** | `POST /reset` — new mission (optionally randomised, optionally seeded) |
| **Step** | `POST /step` — advance one decision |
| **Auto-Run / Pause** | latency-safe loop: each step is awaited before the next is sent |
| **Briefing** | `GET /report` — open the debrief at any time, mid-mission or after |
| **Randomize EVE** + `seed` | random free-cell target; the same seed always reproduces the same mission |
| **threat** | `calm` / `standard` / `pursuit` — EVE restlessness + sensor noise + decoy loudness (next reset) |
| Keyboard | `space` run/pause · `→` single step · `r` reset |

**Headless (no browser):**

```bash
python record_demo_run.py   # runs seed 7 / standard headlessly, rewrites frontend/data/demo_run.json
```

Server logs go to stdout. The backend also writes `mission_trace.json`
(config + trace + report) every time a mission ends.

---

## 2. What was delivered (rubric map)

| Requirement | Where it lives |
| --- | --- |
| **Simulated environment** that loads the config and returns observations per action | `app.py` → `Environment` (grid, obstacles, drift, sensors, clues, decoys, stations, battery). Never reveals EVE; only `briefing()` + per-action `obs` |
| **Autonomous agent** choosing where to move, what to scan, when to recharge/turn back | `app.py` → `Agent.decide()` — A\* to a smoothed belief peak, adaptive scan cadence, reserve-aware recharge rule |
| **Belief updates** about EVE's location, plans adapting to new evidence | `app.py` → `Agent.predict()` (drift diffusion) + `apply()` / `_posterior()` (log-space Bayes); clue hints folded as Gaussians; `ParticleFilter` second opinion (400 particles, systematic resampling) |
| **Full action trace**: actions, observations, decisions, reasoning | Every step appends a `TraceEntry` (`action, ok, note, from, position, battery, energy_cost, observation{signal,clues}, reasoning, strategy, belief_peak, entropy, information_gain, credible_set_90, modes, ess`). See `frontend/js/types.js` |
| **Final mission report**: evidence, inferred location/status, confidence, recommended next step | `Simulation.report()` → `GET /report` and inline on the final `/step`. Fields: `status, eve_found, eve_actual_position (once done), inferred_location, confidence, confidence_within_1_cell, clues_found, battery_remaining, steps_used, energy/actions, recommended_next_step, metrics, trace` |
| **Code repo with README** (environment design, config format, run instructions) | This file (§4 environment, §5 config, §1 run) |
| **Sample config + its traces + report** | `sample_config.json` (input) + `mission_trace.json` (`{config, trace[39], report}` — EVE found) + `frontend/data/demo_run.json` (auditable replay of the same scenario) |
| **Visualisation** (bonus: path, clues, strategy changes) | `/mission` dashboard: belief heatmap + path + clues + decoys + particle cloud + 90% credible set; posterior/prior/likelihood algebra; entropy + information-gain charts, reliability diagram, ROC, detection matrix; colour-coded reasoning log; strategy label per trace entry. Landing `/` replays the recorded run frame-by-frame |

---

## 3. Sample mission: config + trace + report

**Input:** `sample_config.json` — the exact object passed to `Simulation(cfg)`:
14×14 grid, start `(0,0)`, seed 7, `standard` threat, 90 battery / 300 steps,
costs 1 move / 3 scan, 3 recharge stations, 3 clue tokens (±3 cells), 2 decoy
beacons, 36 obstacles, sensor `strength_scale 5.0 / passive σ 0.17 / scan
σ 0.09 / bearing σ 30°`, drift `p = 0.12`. `eve: [11,10]` and
`initial_signal: null` (derived deterministically from the seed — the agent
must *earn* the location through interaction, never reads it).

**Outcome** (`mission_trace.json`, regenerated on every completed mission):

| Field | Value |
| --- | --- |
| status | `eve_found` (EVE at `(11,10)`, inferred `(11,10)`) |
| confidence | `1.0` at the cell, `1.0` within 1 cell |
| steps used | 38 (trace = init + 38 steps = 39 entries) |
| battery remaining | 26 / 90 (spent 25 move + 39 scan; 25 moves, 13 scans, 0 recharges, 0 blocked) |
| clues found | 0 / 3 — found purely on signal geometry |
| recommended next step | *"Contact established. Hand over the plant sample and begin the return journey."* |
| evaluation | AUC 0.959 · log loss 2.799 · Brier 0.0051 · top-1 0.46 · top-3 0.59 · mean info gain 0.099 nats/step · mean credible-90 28.0 cells · detection P 1.00 / R 0.875 · particle ESS 223.6, 5 resamples |

**Strategy arc** (the `strategy` field per entry — visible as colour tags in the
log): `searching → resolving → scanning ⇄ homing`. Early steps sweep the
southern corridor on a flat prior; mid-mission scans collapse the posterior
around `(11,10)`; the final entries read `homing` with the peak pinned at
`83% → 100%` and entropy `0.12 → 0.00`.

---

## 4. Environment design

`app.py → Environment(cfg)` owns the hidden truth and the physics of sensing.
Coordinates are `(x, y)`, `y` growing downward; bearings are degrees from `+x`
toward `+y`.

- **Grid & movement.** 14×14 cells, 36 obstacles (two spines, a mid baffle, a
  lower baffle stopping short of EVE's cell, scattered debris). 4-neighbour
  moves; bumps into walls/obstacles are rejected *but still cost energy*.
- **Hidden target.** EVE starts at `cfg.eve` (or a seeded random free cell with
  `x + y ≥ 10` when `randomize`). Each step she relocates to a free neighbour
  with probability `drift.p` (0.05 calm / 0.12 standard / 0.24 pursuit).
- **Sensors (noisy, difficulty-scaled).**
  - *Strength* at cell `p`: `exp(−d/5)` from EVE, `amp · exp(−d/5)` per decoy —
    the sensor reports the **strongest source**, not the sum. Passive reads add
    `σ 0.12–0.22` noise; scans add `σ 0.06–0.12` **plus a bearing** (`σ 30°`)
    pointing at whichever source is loudest where WALL-E stands.
  - *Initial signal*: bearing ±25° noise, strength ±0.06 — a smear, not a fix.
- **Clues (interaction-only).** 3 tokens at fixed cells. Clue *contents* (a hint
  cell = EVE ± up to `clue_error = 3` in each axis) are generated at reset and
  revealed **only** when WALL-E steps within radius 1. Stepping on EVE's cell
  ends the mission (`eve_found`).
- **Decoys / spoofed signals (advanced).** 2 fixed, *known* beacons
  (`(2,11) @ 0.58`, `(10,1) @ 0.55`, scaled by threat 0.65×/1.0×/1.3×). Known
  positions let the filter explain away readings near them; a nearby decoy also
  *steals the bearing*. Amplitudes stay < 1 so each decoy only wins in a
  bounded region.
- **Resources.** Battery 90 (move 1, scan 3, recharge +20 at stations with
  2/2/1 charges). Time budget 300 steps. `battery_depleted` / `time_expired`
  are terminal alongside `eve_found`.
- **Honesty rule.** The agent receives `briefing()` (dimensions, start,
  obstacles, stations, costs, decoy positions+amplitudes, sensor model,
  initial signal, `believed_drift_p = 0.10`) — never EVE's cell. Evaluation
  metrics are computed from ground truth and never fed back into decisions.

---

## 5. Config format

One JSON object (a YAML file works too: parse it to a dict and pass it to
`Simulation(cfg)`). Defaults live in `DEFAULT_CONFIG`; `new_config()` applies
`difficulty` scaling and optional `randomize`/`seed`. What the agent actually
sees is the `briefing()` subset — everything else is hidden truth.

| Key | Meaning |
| --- | --- |
| `grid.{width,height}` | Playfield size (shipped 14×14) |
| `start` | WALL-E spawn `[x, y]` |
| `eve` | Hidden target `[x, y]` — omitted/randomised with `randomize`; same `seed` reproduces it |
| `seed` / `difficulty` | Determinism + threat (`calm`/`standard`/`pursuit` — drift, sensor σ, decoy scale) |
| `obstacles` | `[[x,y], …]` impassable cells |
| `battery.{max,initial}` / `max_steps` | Energy and time budgets |
| `costs.{move,scan}` | Energy per action |
| `recharge.{gain,stations}` | `stations: [{pos, charges}]` refill pads |
| `sensor.{strength_scale,passive_sigma,scan_sigma,scan_bearing_sigma_deg}` | Noise model |
| `initial_signal` | `null` = derive from the field (seeded); or `{bearing_deg, strength}` |
| `clues` / `clue_error` | Token cells + hint radius (contents hidden until pickup) |
| `drift.{p}` | True per-step relocation probability (agent always *believes* 0.10 — deliberate mismatch) |
| `decoys` | `[{pos, amplitude}]` known spoof beacons |

Minimal example (everything else falls back to `DEFAULT_CONFIG`):

```json
{ "seed": 7, "difficulty": "standard", "randomize": false }
```

Full reference: `sample_config.json`. Programmatic entry: `Simulation(cfg)`
(`record_demo_run.py` shows the headless loop).

---

## 6. Agent design

`app.py → Agent(briefing)` — a classical Bayesian planner (no LLM; the
comparison point is the particle filter running alongside it).

1. **Prior** `p0`: the initial signal folded through the likelihood once —
   a smear peaking around 2%.
2. **Predict** every step: diffuse 10% of each cell's mass to free neighbours
   (`believed_drift_p = 0.10` vs. true 0.12 — the mismatch that keeps the
   posterior from ever collapsing spuriously).
3. **Update** (log-space Bayes, floor `1e-3`): `posterior ∝ prior × L`, where
   `L` is Gaussian on `|observed strength − predicted strongest strength|`
   times a bearing factor on scans; clue pickups multiply in a Gaussian
   around the hint; visited-but-empty cells are discounted ×0.06 (ruled out,
   not zeroed, since EVE moves).
4. **Decide**: A\* to the 3×3-smoothed belief peak (travel-penalised), scan
   cadence that shortens within ~2 cells of the peak or when multimodal, and
   a reserve rule that turns back to the best reachable station before the
   round-trip energy runs out.
5. **Second opinion**: `ParticleFilter` (400 particles, same models,
   systematic resampling at ESS < 200). The *filter duel* (grid MAP vs.
   particle mean gap) is the multimodality alarm: a large gap means the peak
   is one hypothesis among several, not a location.

Tracked per step: `belief_peak{x,y,p}`, normalised entropy, `information_gain`
`D_KL(posterior ‖ prior)`, `credible_set_90`, `modes`, particle `ess`.

---

## 7. API

| Endpoint | Body / returns |
| --- | --- |
| `POST /reset` | `{randomize?: bool, seed?: number, difficulty?: string, eve?: [x,y]}` → `{state, entry}` |
| `POST /step` | — → `{state, entry, report, message}` (`report` only when finished) |
| `GET /report` | → the full report incl. `trace[]`, confidence, recommended next step |

`state` fields the UI relies on: `pos`, `path`, `obstacles`, `belief[y][x]`,
`prior`, `likelihood`, `particles`, `battery`, `battery_max`, `steps`,
`max_steps`, `spent`, `counts`, `energy_pool`, `stations`, `clues_found`,
`clue_total`, `peak{x,y,p}`, `entropy`, `information_gain`, `credible_set_90`,
`modes`, `ess`, `resamples`, `status`, `done`, `found`, `eve` (only once
`done`). Full shapes: `frontend/js/types.js`. Scenario persistence is
stateless (`/reset` returns a `scenario` key; `api/index.py` re-exports the
Flask app for Vercel serverless).

---

## 8. Project structure

```
.
├── app.py                     # Flask API + environment + Bayesian agent + A*
├── api/index.py               # Vercel serverless entrypoint (re-exports app)
├── sample_config.json         # sample mission INPUT (seed 7, standard)
├── mission_trace.json         # sample mission OUTPUT: {config, trace[39], report} (eve_found)
├── record_demo_run.py         # headless run → frontend/data/demo_run.json (landing replay)
├── requirements.txt           # flask + numpy (frontend: zero dependencies)
├── pyproject.toml / vercel.json
├── README.md
└── frontend/                  # zero-dependency dashboard (served by Flask)
    ├── index.html             # landing: recorded, auditable run + method
    ├── mission.html           # live lab: grid layout, icon sprite, a11y hooks
    ├── css/
    │   ├── app.css            # mission design system
    │   ├── landing.css        # landing theme
    │   ├── light.css          # day-mode overrides (both pages)
    │   └── figures.css        # shared chart primitives
    ├── data/
    │   ├── demo_run.json      # recorded frames + config + outcome (no hand-typed numbers)
    │   └── _live_reset.json   # dev fixture
    └── js/
        ├── main.js / landing.js   # entry points (boot + theme)
        ├── App.js / store.js / api.js / useAutoRun.js
        ├── theme.js / theme-toggle.js / gridview.js / charts.js / replay.js
        ├── types.js               # JSDoc contract mirroring the backend JSON
        ├── cursor.js / fx.js
        └── components/
            ├── GridMap.js          # two-canvas belief heatmap + 60 fps overlay
            ├── PosteriorPanel.js   # prior / likelihood / posterior numeric matrices + filter duel
            ├── TelemetryPanel.js   # gauges, bars, stat tiles
            ├── StatsDashboard.js   # entropy / gain charts, reliability, ROC, detection matrix
            ├── ActionLog.js        # auto-scrolling, colour-tagged trace console
            ├── MissionControls.js  # play/pause/step/reset + keyboard shortcuts
            └── ReportModal.js      # briefing dialog + trace download
```

### Data flow

```
button/keyboard → App handler → api.js (fetch) → store.setState()
                                                       │
                                    store.subscribe → App.render(state)
                                                       ├─ TelemetryPanel
                                                       ├─ GridMap   (canvas)
                                                       ├─ PosteriorPanel
                                                       ├─ StatsDashboard (svg)
                                                       └─ ActionLog
```

Every component reads the **same immutable snapshot**, so the canvas, the gauges,
the charts and the log can never disagree about what the agent just did.

---

## 9. Dashboard & visualisation

- **Belief grid** (`GridMap.js`): heatmap of `belief[y][x]`, 90% credible-set
  outline, obstacles, trail + WALL-E, stations, clue tokens (+σ rings), decoy
  beacons, peak cell, particle cloud; pulse + scan-arc overlay at 60 fps.
  Scene repaints only on new snapshots; a `ResizeObserver` preserves aspect
  ratio.
- **Posterior algebra** (`PosteriorPanel.js`): the actual prior / likelihood /
  posterior matrices as numbers (segmented switch — same cells, three
  quantities), plus the filter-duel strip (grid MAP vs. particle mean).
- **Evaluation** (`StatsDashboard.js`): hand-rolled SVG — entropy +
  information-gain series, reliability diagram, ROC/AUC, detection matrix.
  Same builders render the landing scoreboard from the recorded run.
- **Trace & briefing**: colour-tagged reasoning log (`searching/homing/
  scanning/recharging`) that never steals scroll position; briefing modal with
  confidence, evidence, metrics, recommended next step, and one-click trace
  download (`wall-e-briefing-<status>-<n>steps.json`).
- **Day/night**: Lucide sun/moon toggle (inline SVG, no icon font), persisted
  across pages, OS-aware; map/log stay near-black in day mode so belief orange
  keeps reading.

---

## 10. Bonus / stretch coverage

| Stretch item | Status |
| --- | --- |
| Visualise path, clues, strategy changes | ✅ Done — canvas path + clue rings + per-step strategy tags; landing replay |
| Decoy / spoofed signals | ✅ Done — 2 known beacons, strongest-source sensing, bearing hijack, threat scaling |
| Noisy sensors | ✅ Done — passive/scan/bearing σ per difficulty + deliberate drift-belief mismatch |
| Generalisation benchmark | ⚠️ Partial — `seed` + `threat` dials reproduce arbitrary missions; no batch harness yet (`record_demo_run.py` is the single-seed template) |
| LLM vs. classical planner | ❌ Not attempted — classical Bayes + particle duel only |
| Multi-agent coordination | ❌ Not attempted — single WALL-E |
| Physics simulation (Gazebo/Webots) | ❌ Out of scope — grid world |

---

## 11. Verification performed

| Check | Result |
| --- | --- |
| `GET /`, `/assets/css/*.css`, `/assets/js/*.js` | 200 with correct MIME types (`text/javascript` for modules) |
| Full mission via **Auto-Run** | 38 steps, `eve_found` at (11,10), inference error 0 cells, entropy → 0.00 |
| Trace integrity | 39 entries (init + 38 steps), no duplicate step numbers, log matches |
| Briefing modal | opens on mission end and on demand mid-mission (EVE's cell withheld until done) |
| Trace download | JSON blob, filename `wall-e-briefing-<status>-<n>steps.json` |
| Reset + `randomize` + `seed` | same seed reproduces an identical mission; a new seed changes it |
| Backend killed mid-mission | banner `link error: Failed to fetch`, auto-run stops, lamp turns dead; recovers after restart |
| Canvas sizing | repaints after viewport resize at 1600/1024/720 px; no horizontal overflow |
| Day/night toggle | persists across `/` ↔ `/mission`, follows OS until overridden |
| Console | no JS errors during any of the above |

Reproduce the numbers headlessly: `python record_demo_run.py` prints
`status / steps / battery / AUC / logloss / Brier / top-1 / KL_mean`.

---

## 12. Limitations & future work

- Single agent, grid world, no physics engine.
- No batch benchmark harness yet — add a `benchmark.py` sweeping seeds ×
  threats and reporting steps-to-find / AUC distributions.
- No planner comparison — the natural next experiment is LLM-proposed moves
  scored against the Bayes policy on identical seeds.
- `mission_trace.json` is overwritten per completed mission (download the
  briefing from the UI to keep a copy).
