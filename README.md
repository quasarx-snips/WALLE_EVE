# WALL-E and EVE's Signal — autonomous Bayesian search

An agent (WALL-E) searches a grid world for a hidden target (EVE) using noisy
signal readings and hint clues, under a battery and step budget. The backend runs
the simulation and the Bayesian filter; the front-end is a mission-control
dashboard that visualises the belief map, the agent's reasoning trace, and the
post-mission briefing.

* **Backend:** `app.py` — Flask + NumPy. Environment, planner, and 3 endpoints.
* **Front-end:** `frontend/` — plain HTML + CSS + JavaScript ES modules.
  No bundler, no npm, no build step: Flask serves the source files directly.
* **Proof run:** `mission_trace.json` — a sample config with its full action
  trace and final report (21 steps, EVE found).

---

## 1. Run it

```bash
pip install flask numpy
python app.py
```

Open <http://127.0.0.1:5000>. The dashboard boots straight into a fresh mission.

| Control | What it does |
| --- | --- |
| **Start / Reset** | `POST /reset` — new mission (optionally randomised, optionally seeded) |
| **Step** | `POST /step` — advance one decision |
| **Auto-Run / Pause** | latency-safe loop: each step is awaited before the next is sent |
| **Briefing** | `GET /report` — open the debrief at any time, mid-mission or after |
| **Randomize EVE** + `seed` | random free-cell target; the same seed always reproduces the same mission |
| Keyboard | `space` run/pause · `→` single step · `r` reset |

Server logs: stdout. The backend also writes `mission_trace.json` (config + trace
+ report) every time a mission ends.

---

## 2. Project structure

```
.
├── app.py                     # Flask API + environment + Bayesian agent + A*
├── mission_trace.json         # sample mission: config, 21-step trace, report
├── README.md
└── frontend/                  # zero-dependency dashboard (served by Flask)
    ├── index.html             # shell: CSS-grid layout, icon sprite, a11y hooks
    ├── css/
    │   └── app.css            # design system: space palette, gauges, log, charts
    └── js/
        ├── main.js            # entry point: boots App and calls reset()
        ├── App.js             # composition root: store ↔ API ↔ components
        ├── api.js             # fetch clients for /reset, /step, /report
        ├── store.js           # tiny observable store (single source of truth)
        ├── useAutoRun.js      # leak-free, latency-aware auto-run controller
        ├── types.js           # JSDoc typedefs for every API shape
        ├── theme.js           # the colour palette shared by canvas + CSS
        ├── utils/format.js    # pure formatting helpers
        └── components/
            ├── GridMap.js          # two-canvas belief heatmap + 60 fps overlay
            ├── TelemetryPanel.js   # gauges, bars, stat tiles
            ├── StatsDashboard.js   # entropy line chart + action-mix radar (SVG)
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
                                                       ├─ StatsDashboard (SVG)
                                                       └─ MissionControls
```

Every component reads the **same immutable snapshot**, so the canvas, the gauges,
the charts and the log can never disagree about what the agent just did.

---

## 3. Environment design (`app.py`)

**Config format** — one JSON object (a YAML file works too: parse it to a dict and
pass it to `Simulation(cfg)`). Defaults live in `DEFAULT_CONFIG`:

| Key | Meaning |
| --- | --- |
| `grid.width`, `grid.height` | Grid size in cells |
| `start` | WALL-E's start cell `[x, y]` |
| `eve` | EVE's hidden cell (never sent to the agent; revealed only at mission end) |
| `obstacles` | Impassable cells |
| `battery.max`, `battery.initial` | Battery capacity / starting charge |
| `max_steps` | Time budget (steps until `time_expired`) |
| `costs.move`, `costs.scan` | Energy per action (a *blocked* move still costs) |
| `recharge.gain`, `recharge.stations` | Top-up amount and `{pos, charges}` pads |
| `sensor.strength_scale` | Range of the signal; true strength `= exp(-distance / scale)` |
| `sensor.passive_sigma`, `sensor.scan_sigma` | Observation noise on strength |
| `sensor.scan_bearing_sigma_deg` | Bearing noise for a scan |
| `initial_signal` | The first clue: `{bearing_deg, strength, timestamp}` (or `null` = random) |
| `clues` | Clue cells; their *content* is revealed only by stepping on them |
| `clue_error` | A clue's hint points to EVE within ± this many cells |
| `seed` | RNG seed for clue noise, sensors, and config randomisation |

**Coordinates:** `x` grows right, `y` grows **down**; `belief` is indexed
`belief[y][x]` (row-major, matching NumPy).

**Physics / sensing**

* `signal.strength = exp(-dist(EVE, p) / strength_scale)`, so strength rises as the
  agent approaches. Readings are Gaussian-noisy (`passive_sigma` for free moves,
  `scan_sigma` for scans).
* A **scan** costs more but also reports a noisy **bearing** (±20° by default).
* **Clues** are picked up within radius 0 (walking onto the cell) or radius 1 (a scan).

**Belief updates (the Bayesian core)**

1. Likelihood from strength: `L ∝ N(observed; exp(-d/scale), σ)`
2. Likelihood from bearing (scans): a von-Mises-style factor `0.03 + 0.97·N(Δθ; 0, σ_b)`
3. Clue hint: multiply by a Gaussian centred on the hinted cell with `sigma = clue_error + 0.5`
4. Multiply into the prior and renormalise; obstacles and visited cells are "dead"
   (probability zero) because standing somewhere without finding EVE rules it out.
5. **Entropy** `H = -Σ p log p / log(W·H)` — the dashboard's uncertainty gauge.

**Policy:** A* to a 3×3-smoothed belief peak with a travel-distance penalty, a scan
cadence that shortens near the peak, and a recharge rule that reserves energy for
the round trip to the nearest charged pad (turning back before the reserve is gone).
Statuses: `running`, `eve_found`, `battery_depleted`, `time_expired`.

---

## 4. API

| Endpoint | Body / returns |
| --- | --- |
| `POST /reset` | `{randomize?: bool, seed?: number}` → `{state, entry}` |
| `POST /step` | — → `{state, entry, report, message}` (`report` only when finished) |
| `GET /report` | → the full report incl. `trace[]`, confidence, recommended next step |

`state` fields the UI relies on: `pos`, `path`, `obstacles`, `belief[y][x]`,
`battery`, `battery_max`, `steps`, `max_steps`, `spent`, `counts`, `energy_pool`,
`stations`, `clues_found`, `clue_total`, `peak{x,y,p}`, `entropy`, `status`, `done`,
`found`, `eve` (only once `done`).

---

## 5. Dashboard notes (why it is built this way)

* **`GridMap.js`** uses two stacked canvases: the *scene* canvas repaints only when a
  new snapshot arrives (heatmap, obstacles, trail, stations, clues, markers), while
  the *overlay* canvas runs a single `requestAnimationFrame` loop for the 60 fps
  pulse on the best-hypothesis cell and the decaying scan arc. Keeping the animated
  work on its own canvas means belief updates never have to re-run the heavy draw.
  The canvas box is sized in JS to preserve the grid's aspect ratio inside the
  panel, and a `ResizeObserver` repaints after layout changes (assigning
  `canvas.width` clears the bitmap — hence the explicit repaint on resize).
* **`useAutoRun.js`** deliberately avoids `setInterval`: an interval fires on wall
  clock time and would stack overlapping `/step` requests if the API were slow.
  A self-correcting `setTimeout` chain awaits each tick, re-checks intent after the
  await, and is disposable — so pausing, ending the mission, or losing the backend
  can never leave a timer running.
* **`StatsDashboard.js`** hand-rolls both charts in SVG (no chart library): a fixed
  `viewBox` scales them responsively, and the radar marks a zero count at the centre
  instead of faking a minimum radius.
* **`ActionLog.js`** only auto-scrolls when the operator is already at the bottom,
  so reading history is never interrupted by incoming steps.

---

## 6. Verification performed

Checked against a running server via the browser UI (not just unit-level calls):

| Check | Result |
| --- | --- |
| `GET /`, `/assets/css/app.css`, `/assets/js/*.js` | 200 with correct MIME types (`text/javascript` for modules) |
| Full mission via **Auto-Run** | 20 steps, `eve_found` at (7,6), inference error 0 cells, entropy → 0.00 |
| Trace integrity | 21 entries (init + 20 steps), no duplicate step numbers, log matches |
| Briefing modal | opens on mission end and on demand mid-mission (EVE's cell withheld until done) |
| Trace download | 15.6 KB `application/json` blob, filename `wall-e-briefing-<status>-<n>steps.json` |
| Reset + `randomize` + `seed` | same seed reproduces an identical mission; a new seed changes it |
| Backend killed mid-mission | banner `link error: Failed to fetch`, auto-run stops, lamp turns dead; recovers after restart |
| Canvas sizing | repaints after viewport resize at 1600/1024/720 px; no horizontal overflow |
| Console | no JS errors during any of the above |
