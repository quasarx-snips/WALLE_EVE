# Install dependencies first:  pip install flask numpy
# Run:  python app.py   then open http://127.0.0.1:5000
# Coordinates are (x, y) with y growing downward. Bearings are degrees from +x toward +y.
"""WALL-E and EVE's Signal — a Bayesian pursuit lab + Flask API.

The agent never sees EVE. It carries a probability distribution over the grid,
propagates it forward with a motion model (EVE moves), multiplies it by a noisy
sensor likelihood, and renormalises. A second, independent estimator — a particle
filter — runs the same problem with 400 weighted samples so the two can be
compared live. Every step also scores the agent with real evaluation metrics
(log loss, Brier, calibration, AUC) that are computed from ground truth and are
never fed back into its decisions.

Appendix — where the numbers come from:

  grid filter    belief[y][x] is the posterior P(EVE at (x,y) | observations).
                 predict()  : belief <- belief * K   (K = one-step drift kernel)
                 update()   : belief <- belief * L, renormalise
                 L          : Gaussian on |observed strength - predicted
                              strength|, times a von Mises-ish bearing factor
                              when the sensor reported a bearing.
  particle filter 400 samples, same predict/update, systematic resampling when
                 the effective sample size drops below half.
  metrics        D_KL(posterior || prior) is the information the update bought,
                 in nats. Log loss / Brier / calibration / AUC are computed
                 against the hidden truth, for reporting only.
"""
import copy
import heapq
import json
import os
import random
import threading
import time
from collections import OrderedDict

import numpy as np
from flask import Flask, jsonify, request, send_file, send_from_directory

# ----------------------------------------------------------------- mock config
# A 14x14 field. Bigger than the 10x10 it replaced, with a denser maze, two
# decoy beacons that broadcast strength without a bearing, and EVE relocating
# with probability 0.12 per step. The budget is deliberately tight: 70 battery
# against 3 per scan and 1 per move.
DEFAULT_CONFIG = {
    "grid": {"width": 14, "height": 14},
    "start": [0, 0],
    "eve": [11, 10],  # hidden from the agent and the UI until the mission ends
    "obstacles": [
        # two long spines with gaps, so A* has to route around them
        [3, 1], [3, 2], [3, 3], [3, 4],
        [3, 7], [3, 8], [3, 9], [3, 10], [3, 11],
        # horizontal baffle through the middle
        [5, 5], [6, 5], [7, 5], [8, 5],
        [6, 6],
        # right-hand pocket walls
        [9, 2], [9, 3], [9, 4], [9, 5],
        [11, 3], [12, 3], [13, 3],
        [13, 6], [13, 7],
        [11, 8], [11, 9],
        # lower baffle (stops short of EVE's cell at (11,10))
        [6, 10], [7, 10], [8, 10], [9, 10], [10, 10],
        [5, 11], [5, 12],
        # scattered debris
        [1, 9], [7, 7], [1, 12], [10, 12],
    ],
    "battery": {"max": 90, "initial": 90},
    "max_steps": 300,  # time budget
    "costs": {"move": 1, "scan": 3},
    "recharge": {"gain": 20, "stations": [{"pos": [0, 0], "charges": 2}, {"pos": [12, 12], "charges": 2},
                                               {"pos": [7, 13], "charges": 1}]},
    # Noisier sensors + a flatter signal gradient make localisation genuinely hard.
    "sensor": {"strength_scale": 5.0, "passive_sigma": 0.17, "scan_sigma": 0.09, "scan_bearing_sigma_deg": 30.0},
    # None = derive the opening reading from the real field (deterministic per seed).
    "initial_signal": None,
    # Few clues, and each one is only good to +/- 3 cells.
    "clues": [{"pos": [2, 6]}, {"pos": [8, 12]}, {"pos": [13, 3]}],
    "clue_error": 3,
    # EVE is alive: with this probability per step she steps to a free neighbour.
    # The agent BELIEVES the rate is 0.10 (see Agent.DRIFT_BELIEF) — a small,
    # deliberate model mismatch that keeps the posterior from ever collapsing.
    "drift": {"p": 0.12},
    # Decoy beacons: fixed, KNOWN transmitters (their positions are in the
    # briefing). Each radiates a Gaussian strength field of its own, and the
    # strength a sensor reports is the strongest source present — not the sum.
    # So a decoy does two things: (a) it makes its own neighbourhood ambiguous,
    # because a reading there is fully explained without EVE; and (b) it steals
    # the bearing, because a scan points at whichever source is loudest where
    # WALL-E is standing. The amplitudes stay below 1.0 so the decoy only wins
    # in a bounded region (d_eve < d_decoy - s*ln(A) cells).
    "decoys": [
        {"pos": [2, 11], "amplitude": 0.58},
        {"pos": [10, 1], "amplitude": 0.55},
    ],
    "seed": 7,
}
MOVES = {"move_up": (0, -1), "move_down": (0, 1), "move_left": (-1, 0), "move_right": (1, 0)}
ACTIONS = list(MOVES) + ["scan", "recharge"]

# Viewer-facing dial. Everything here is applied on top of DEFAULT_CONFIG, so
# "standard" is the shipped scenario and the other two are honest perturbations
# of it — the agent is never told which one is running, and it always believes
# the drift rate is Agent.DRIFT_BELIEF (0.10) even at "pursuit".
DIFFICULTY = {
    "calm": {"label": "Calm", "drift": 0.05, "passive_sigma": 0.12, "scan_sigma": 0.06, "decoy_scale": 0.65},
    "standard": {"label": "Standard", "drift": 0.12, "passive_sigma": 0.17, "scan_sigma": 0.09, "decoy_scale": 1.0},
    "pursuit": {"label": "Pursuit", "drift": 0.24, "passive_sigma": 0.22, "scan_sigma": 0.12, "decoy_scale": 1.3},
}
DEFAULT_DIFFICULTY = "standard"


def new_config(randomize=False, seed=None, difficulty=None):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    level = DIFFICULTY.get(difficulty or DEFAULT_DIFFICULTY)
    if level is None:
        level, difficulty = DIFFICULTY[DEFAULT_DIFFICULTY], DEFAULT_DIFFICULTY
    cfg["difficulty"] = difficulty or DEFAULT_DIFFICULTY
    cfg["drift"] = {"p": level["drift"]}
    cfg["sensor"]["passive_sigma"] = level["passive_sigma"]
    cfg["sensor"]["scan_sigma"] = level["scan_sigma"]
    for d in cfg["decoys"]:
        d["amplitude"] = round(min(0.98, d["amplitude"] * level["decoy_scale"]), 4)
    if seed is not None:
        cfg["seed"] = int(seed)
    if randomize:
        seed = random.randint(0, 10**6) if seed is None else int(seed)
        r = random.Random(seed)
        w, h = cfg["grid"]["width"], cfg["grid"]["height"]
        taken = {tuple(p) for p in cfg["obstacles"]}
        taken |= {tuple(c["pos"]) for c in cfg["clues"]}
        taken |= {tuple(s["pos"]) for s in cfg["recharge"]["stations"]}
        taken |= {tuple(d["pos"]) for d in cfg["decoys"]}
        taken.add(tuple(cfg["start"]))
        opts = [(x, y) for x in range(w) for y in range(h) if (x, y) not in taken and x + y >= 10]
        cfg["seed"], cfg["eve"], cfg["initial_signal"] = seed, list(r.choice(opts)), None
    return cfg


def _replay_config(scenario):
    """Rebuild the exact config a scenario refers to. Used by the stateless
    `/step` path, so a mission survives a process restart, a cold lambda, or a
    different worker behind the load balancer."""
    cfg = new_config(False, scenario.get("seed"), scenario.get("difficulty"))
    if scenario.get("eve"):
        cfg["eve"] = [int(v) for v in scenario["eve"]]
        cfg["initial_signal"] = None  # regenerate against the moved target
    return cfg


# ----------------------------------------------------------------- environment
class Environment:
    """Ground truth. The agent is only ever handed `briefing()`, never this object."""

    def __init__(self, cfg):
        self.cfg = copy.deepcopy(cfg)
        self.w, self.h = cfg["grid"]["width"], cfg["grid"]["height"]
        self.rng = np.random.default_rng(cfg["seed"])
        self.start = self.pos = tuple(cfg["start"])
        self.eve = tuple(cfg["eve"])
        self.obstacles = {tuple(o) for o in cfg["obstacles"]}
        self.bmax, self.battery = cfg["battery"]["max"], cfg["battery"]["initial"]
        self.steps, self.found, self.recharged = 0, False, 0
        self.stations = {tuple(s["pos"]): s["charges"] for s in cfg["recharge"]["stations"]}
        self.decoys = [(tuple(d["pos"]), float(d["amplitude"])) for d in cfg["decoys"]]
        self.spent = {"move": 0, "scan": 0}
        self.counts = {"move": 0, "scan": 0, "recharge": 0, "blocked": 0}
        err, self.clues = cfg["clue_error"], []
        for i, c in enumerate(cfg["clues"]):  # clue content is only revealed by interaction
            ox, oy = (int(v) for v in self.rng.integers(-err, err + 1, size=2))
            hint = (int(np.clip(self.eve[0] + ox, 0, self.w - 1)), int(np.clip(self.eve[1] + oy, 0, self.h - 1)))
            self.clues.append({"id": i, "pos": tuple(c["pos"]), "hint": hint, "sigma": err + 0.5, "found": False})
        self.initial_signal = cfg.get("initial_signal") or {
            "bearing_deg": round(self.bearing(self.start) + float(self.rng.normal(0, 25)), 1),
            "strength": round(float(np.clip(self.true_strength(self.start) + self.rng.normal(0, 0.06), 0, 1)), 3),
            "timestamp": 0}

    # --- the hidden signal field ------------------------------------------
    def true_strength(self, p):
        """Signal amplitude at p: the strongest source wins (not the sum)."""
        best = float(np.exp(-np.hypot(self.eve[0] - p[0], self.eve[1] - p[1]) / self.cfg["sensor"]["strength_scale"]))
        for (dx, dy), amp in self.decoys:
            best = max(best, float(amp * np.exp(-np.hypot(dx - p[0], dy - p[1]) / self.cfg["sensor"]["strength_scale"])))
        return best

    def strongest_source(self, p):
        """Which emitter dominates at p — used for scans (a near decoy hijacks the bearing)."""
        best, who = -1.0, self.eve
        for src, amp in [(self.eve, 1.0)] + list(self.decoys):
            v = amp * float(np.exp(-np.hypot(src[0] - p[0], src[1] - p[1]) / self.cfg["sensor"]["strength_scale"]))
            if v > best:
                best, who = v, src
        return who

    def bearing(self, p, target=None):
        t = target or self.eve
        return float(np.degrees(np.arctan2(t[1] - p[1], t[0] - p[0])))

    def free(self, x, y):
        return 0 <= x < self.w and 0 <= y < self.h and (x, y) not in self.obstacles

    def status(self):
        if self.found:
            return "eve_found"
        if self.battery <= 0:
            return "battery_depleted"
        if self.steps >= self.cfg["max_steps"]:
            return "time_expired"
        return "running"

    def done(self):
        return self.status() != "running"

    def briefing(self):
        """Everything the agent is allowed to know. No EVE cell, no clue content,
        no decoy positions, no true drift rate."""
        return {"width": self.w, "height": self.h, "start": self.start, "obstacles": sorted(self.obstacles),
                "stations": [[p, n] for p, n in self.stations.items()], "costs": self.cfg["costs"],
                "bmax": self.bmax, "gain": self.cfg["recharge"]["gain"], "sensor": self.cfg["sensor"],
                "initial_signal": self.initial_signal, "max_steps": self.cfg["max_steps"],
                "believed_drift_p": Agent.DRIFT_BELIEF,
                # The beacons are fixed, registered infrastructure, so their
                # positions AND nominal amplitudes are on the agent's own map.
                # That is what turns a decoy from a modelling error into a
                # genuine identifiability problem: a strong reading near a
                # beacon is fully explained without EVE, and the agent knows it.
                "decoys": [{"pos": list(p), "amplitude": a} for p, a in self.decoys]}

    def _noisy_strength(self, sigma):
        return round(float(np.clip(self.true_strength(self.pos) + self.rng.normal(0, sigma), 0, 1)), 3)

    def _discover(self, radius, obs):
        for c in self.clues:
            if not c["found"] and max(abs(c["pos"][0] - self.pos[0]), abs(c["pos"][1] - self.pos[1])) <= radius:
                c["found"] = True
                obs["clues"].append({"id": c["id"], "pos": c["pos"], "hint": c["hint"], "sigma": c["sigma"]})

    def act(self, action):
        cc, s = self.cfg["costs"], self.cfg["sensor"]
        obs = {"ok": True, "note": "", "signal": None, "clues": [], "cost": 0}
        if self.done():
            obs.update(ok=False, note="mission already ended")
            return obs
        if action in MOVES:
            dx, dy = MOVES[action]
            nx, ny = self.pos[0] + dx, self.pos[1] + dy
            self.battery -= cc["move"]
            self.spent["move"] += cc["move"]
            obs["cost"] = cc["move"]
            if self.free(nx, ny):
                self.pos = (nx, ny)
                self.counts["move"] += 1
            else:  # bounds and obstacles are enforced here; the bump still costs energy
                inb = 0 <= nx < self.w and 0 <= ny < self.h
                obs.update(ok=False, note="blocked: " + ("obstacle" if inb else "out of bounds"))
                self.counts["blocked"] += 1
            obs["signal"] = {"kind": "passive", "strength": self._noisy_strength(s["passive_sigma"]), "bearing": None}
            if self.pos == self.eve:
                self.found = True
            self._discover(0, obs)
        elif action == "scan":
            if self.battery < cc["scan"]:
                obs.update(ok=False, note="insufficient battery for scan")
            else:
                self.battery -= cc["scan"]
                self.spent["scan"] += cc["scan"]
                self.counts["scan"] += 1
                obs["cost"] = cc["scan"]
                src = self.strongest_source(self.pos)
                b = self.bearing(self.pos, src) + float(self.rng.normal(0, s["scan_bearing_sigma_deg"]))
                obs["signal"] = {"kind": "scan", "strength": self._noisy_strength(s["scan_sigma"]),
                                 "bearing": round((b + 180) % 360 - 180, 1),
                                 "hijacked": src != self.eve}
                self._discover(1, obs)
        elif action == "recharge":
            if self.stations.get(self.pos, 0) <= 0:
                obs.update(ok=False, note="no charged station at this cell")
            else:
                gain = min(self.cfg["recharge"]["gain"], self.bmax - self.battery)
                self.battery += gain
                self.recharged += gain
                self.stations[self.pos] -= 1
                self.counts["recharge"] += 1
                obs["note"] = f"+{gain} battery"
        else:
            obs.update(ok=False, note="unknown action")
        self.steps += 1
        return obs

    def drift(self):
        """EVE relocates with probability drift.p. Returns True if she moved."""
        p = self.cfg.get("drift", {}).get("p", 0)
        if not p or self.done() or float(self.rng.random()) >= p:
            return False
        opts = [(self.eve[0] + dx, self.eve[1] + dy) for dx, dy in MOVES.values()
                if self.free(self.eve[0] + dx, self.eve[1] + dy)]
        if not opts:
            return False
        self.eve = tuple(int(v) for v in self.rng.choice(opts))
        if self.pos == self.eve:  # she drifted straight into WALL-E's arms
            self.found = True
        return True


# ----------------------------------------------------------------- agent
class Agent:
    """Bayesian grid filter + A* navigation. Never reads the environment's hidden state.

    Two deliberate model mismatches keep this honest:
      * the drift rate it assumes (0.10) is not the true rate (0.12);
      * visited cells are *discounted*, not zeroed, because a moving target can
        legally return to a cell the agent has already cleared. Zeroing them —
        which is correct only for a static target — is what makes naive Bayesian
        search collapse to a single cell and then chase a ghost.
    """

    DRIFT_BELIEF = 0.10     # what the agent thinks EVE's relocation rate is
    VISIT_DISCOUNT = 0.06   # a cleared cell is unlikely, not impossible

    def __init__(self, b):
        self.b, self.w, self.h = b, b["width"], b["height"]
        self.XX, self.YY = np.meshgrid(np.arange(self.w), np.arange(self.h))
        self.obst = {tuple(o) for o in b["obstacles"]}
        self.charges = {tuple(p): n for p, n in b["stations"]}
        self.free_mask = ~np.zeros((self.h, self.w), bool)
        for x, y in self.obst:
            self.free_mask[y, x] = False
        # Number of free neighbours per cell — the denominator of the drift kernel.
        self.deg = np.zeros((self.h, self.w), float)
        for dy, dx in MOVES.values():
            self.deg += _shift(self.free_mask.astype(float), dy, dx)
        self.deg_safe = np.where(self.deg > 0, self.deg, 1.0)

        self.belief = np.ones((self.h, self.w)) * self.free_mask
        self.last_prior = self.belief.copy()
        self.last_likelihood = np.ones((self.h, self.w))
        self.last_kl = 0.0
        self._norm()

        self.scanned, self.since_scan, self.target, self.pos = set(), 99, None, tuple(b["start"])
        self.belief[b["start"][1], b["start"][0]] *= self.VISIT_DISCOUNT
        self._norm()
        self.believed_drift = float(b.get("believed_drift_p", self.DRIFT_BELIEF))
        self.decoys = [(tuple(d["pos"]), float(d["amplitude"])) for d in (b.get("decoys") or [])]
        self.scale = float(b["sensor"]["strength_scale"])
        sig = b["initial_signal"]
        # A loose first read: the initial bearing is worth +/- 25 degrees, the
        # initial strength +/- 0.08, so p0 is a smear rather than a guess.
        self.apply(self.pos, sig["strength"], sig["bearing_deg"], 0.08, 25.0)

    def _norm(self):
        self.belief = self.belief * self.free_mask
        t = self.belief.sum()
        if t > 0:
            self.belief = self.belief / t
        else:  # everything ruled out: fall back to uniform over free cells
            self.belief = self.free_mask.astype(float) / max(self.free_mask.sum(), 1)
        return self.belief

    def entropy(self):
        p = self.belief[self.belief > 1e-12]
        return float(-(p * np.log(p)).sum() / np.log(max(self.free_mask.sum(), 2)))

    def map_cell(self):
        y, x = np.unravel_index(int(np.argmax(self.belief)), self.belief.shape)
        return int(x), int(y), float(self.belief[y, x])

    def modes(self, rel=0.5):
        """Count of distinct high-probability basins — a cheap multimodality test.

        Run over a 3x3-smoothed copy so single-cell noise doesn't inflate it.
        """
        sm = np.zeros_like(self.belief)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                sm += _shift(self.belief, dy, dx)
        m = sm.max()
        if m <= 0:
            return 0
        hot = sm >= rel * m
        seen = np.zeros_like(hot, bool)
        count = 0
        for y in range(self.h):
            for x in range(self.w):
                if hot[y, x] and not seen[y, x]:
                    count += 1
                    stack = [(y, x)]
                    while stack:
                        cy, cx = stack.pop()
                        if not (0 <= cy < self.h and 0 <= cx < self.w) or seen[cy, cx] or not hot[cy, cx]:
                            continue
                        seen[cy, cx] = True
                        stack += [(cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)]
        return count

    def credible_set(self, mass=0.9):
        """How many cells the filter needs to cover `mass` of the posterior."""
        flat = np.sort(self.belief.ravel())[::-1]
        return int(np.searchsorted(np.cumsum(flat), mass) + 1)

    def predict(self):
        """One forward step of the motion model: belief <- belief * K.

        K is the drift kernel: with probability p EVE takes one step to a
        uniformly chosen free neighbour, otherwise she stays. Mass arriving at a
        cell is the sum of (p / deg(source)) * mass(source) over its free
        neighbours. Cells with no free neighbour (fully boxed in) keep their own
        mass instead of leaking it.
        """
        p = self.believed_drift
        if p <= 0:
            return
        share = self.belief * self.free_mask / self.deg_safe
        arrive = np.zeros_like(self.belief)
        for dy, dx in MOVES.values():
            arrive += _shift(share, dy, dx)
        frozen = (self.deg == 0).astype(float)
        self.belief = ((1.0 - p) + p * frozen) * self.belief + p * arrive
        self._norm()

    def decoy_field(self, pos):
        """What the beacons put at `pos`. Independent of where EVE is, so for a
        single reading it is a scalar: the noise floor the strength channel has
        to beat before it says anything about EVE."""
        best = 0.0
        for (dx, dy), amp in self.decoys:
            best = max(best, amp * float(np.exp(-np.hypot(dx - pos[0], dy - pos[1]) / self.scale)))
        return best

    def likelihood(self, pos, strength, bearing, s_sig, b_sig):
        """Sensor model as a grid of likelihoods L[y][x] = P(reading | EVE at x,y).

        The generative model is the one the environment actually uses: the sensor
        reports the STRONGEST source, so the predicted strength for a candidate
        cell is max(EVE's own field there-if-she-were, the strongest beacon).
        Where the beacons already explain the reading, the whole grid shares the
        same likelihood and the reading carries no information — which is exactly
        right, and is why a naive single-source model (that quietly assumed every
        loud reading came from EVE) walks confidently onto a decoy.
        """
        dx, dy = self.XX - pos[0], self.YY - pos[1]
        d = np.hypot(dx, dy)
        eve = np.exp(-d / self.scale)          # EVE's field at WALL-E, if she is at (x, y)
        decoy = self.decoy_field(pos)
        like = np.exp(-0.5 * ((strength - np.maximum(eve, decoy)) / s_sig) ** 2)
        if bearing is not None:
            diff = (np.degrees(np.arctan2(dy, dx)) - bearing + 180) % 360 - 180
            # A scan points at whichever source is loudest. If a beacon is louder
            # than this candidate would be, the reading is the beacon's, and the
            # angle says nothing about EVE; otherwise the angle is informative.
            sharp = 0.03 + 0.97 * np.exp(-0.5 * (diff / b_sig) ** 2)
            like = like * np.where(d < 0.5, 1.0, np.where(eve >= decoy, sharp, 1.0))
        return like

    def _posterior(self, prior, like, floor=1e-3):
        """Bayes in log space.

        `prior * (floor + like)` renormalised, but computed on log-probabilities
        and floored 60 nats below the best cell. Combining hundreds of tiny
        likelihoods in linear space underflows to hard zeros, which would freeze
        the filter on a wrong hypothesis forever; a RELATIVE floor keeps the
        ranking exact and the arithmetic finite.
        """
        lp = np.log(np.maximum(prior, 1e-300)) + np.log(floor + like)
        lp = np.where(self.free_mask, lp, -np.inf)
        top = lp.max()
        if not np.isfinite(top):
            return self._norm_of(prior)
        return self._norm_of(np.exp(np.clip(lp - top, -60.0, 0.0)))

    def apply(self, pos, strength, bearing, s_sig, b_sig):
        self.last_prior = self.belief.copy()
        like = self.likelihood(pos, strength, bearing, s_sig, b_sig)
        self.last_likelihood = like
        post = self._posterior(self.belief, like)
        self.last_kl = _kl(post, self.last_prior, self.free_mask)
        self.belief = post

    def _norm_of(self, arr):
        arr = arr * self.free_mask
        t = arr.sum()
        return arr / t if t > 0 else self.free_mask.astype(float) / max(self.free_mask.sum(), 1)

    def observe(self, pos, action, obs, found):
        self.pos = pos
        if found:
            self.belief[:] = 0
            self.belief[pos[1], pos[0]] = 1
            return
        s = self.b["sensor"]
        if action == "recharge" and obs["ok"]:
            self.charges[pos] = max(0, self.charges.get(pos, 0) - 1)
        sig = obs["signal"]
        if sig and sig["kind"] == "scan":
            self.apply(pos, sig["strength"], sig["bearing"], s["scan_sigma"], s["scan_bearing_sigma_deg"])
            self.scanned.add(pos)
        elif sig:
            self.apply(pos, sig["strength"], None, s["passive_sigma"], 0)
        else:
            self.last_prior = self.belief.copy()
            self.last_likelihood = np.ones((self.h, self.w))
            self.last_kl = 0.0
        for c in obs["clues"]:
            hx, hy = c["hint"]
            self.belief = self.belief * (1e-3 + np.exp(-((self.XX - hx) ** 2 + (self.YY - hy) ** 2) / (2 * c["sigma"] ** 2)))
            self.last_kl = max(self.last_kl, _kl(self._norm_of(self.belief), self.last_prior, self.free_mask))
        # Cleared, not impossible: a drift-capable EVE may come back here later,
        # and predict() will let that mass flow back in.
        self.belief[pos[1], pos[0]] *= self.VISIT_DISCOUNT
        self.since_scan = 0 if (sig and sig["kind"] == "scan") else self.since_scan + 1
        self._norm()

    def astar(self, s, g):
        if s == g:
            return [s]
        pq, came, cost = [(abs(s[0] - g[0]) + abs(s[1] - g[1]), 0, s)], {s: None}, {s: 0}
        while pq:
            _, c, u = heapq.heappop(pq)
            if u == g:
                path = []
                while u:
                    path.append(u)
                    u = came[u]
                return path[::-1]
            if c > cost[u]:
                continue
            for dx, dy in MOVES.values():
                v = (u[0] + dx, u[1] + dy)
                if 0 <= v[0] < self.w and 0 <= v[1] < self.h and v not in self.obst and c + 1 < cost.get(v, 1e9):
                    cost[v], came[v] = c + 1, u
                    heapq.heappush(pq, (c + 1 + abs(v[0] - g[0]) + abs(v[1] - g[1]), c + 1, v))
        return None

    def nearest_station(self, pos):
        best = None
        for p, n in self.charges.items():
            if n > 0:
                path = self.astar(pos, p)
                if path and (best is None or len(path) < len(best[0])):
                    best = (path, p)
        return best

    @staticmethod
    def _dir(a, b):
        return {(1, 0): "move_right", (-1, 0): "move_left", (0, 1): "move_down", (0, -1): "move_up"}[(b[0] - a[0], b[1] - a[1])]

    def decide(self, pos, battery, step):
        px, py, peak = self.map_cell()
        ent = self.entropy()
        cm, cs, gain, bmax = self.b["costs"]["move"], self.b["costs"]["scan"], self.b["gain"], self.b["bmax"]
        strat = "homing" if peak > 0.3 else "searching"
        head = f"Belief peak {peak:.0%} at ({px},{py}), entropy {ent:.2f}, battery {battery}. "
        out = lambda a, why, st=None: {"action": a, "reasoning": head + why, "strategy": st or strat}

        st = self.nearest_station(pos)
        need = (len(st[0]) - 1) * cm + 2 * cs if st else None
        if self.charges.get(pos, 0) > 0 and battery + gain <= bmax and battery <= 0.7 * bmax:
            return out("recharge", "On a charged station with room for a full top-up; recharging.", "recharging")
        if st and need and battery <= need + 2 * cs + 2:
            if need <= battery and len(st[0]) > 1:
                return out(self._dir(st[0][0], st[0][1]),
                           f"Battery low: turning back to station {st[1]} ({len(st[0]) - 1} steps, reserve kept).", "recharging")
            if need > battery:
                head += "Station out of reach; committing remaining energy to the best hypothesis. "

        near = abs(px - pos[0]) + abs(py - pos[1]) <= 2
        # A multimodal posterior means the strength channel alone can't settle it,
        # and only a bearing can separate two candidate cells — so scan sooner.
        modes = self.modes()
        interval = 2 if peak < 0.2 else 3
        if modes >= 2:
            strat = "resolving"
        if pos not in self.scanned and battery - cs >= (need or 0) and (
                self.since_scan >= interval or (near and self.since_scan >= 1) or (modes >= 2 and self.since_scan >= 1)):
            if near:
                why = "Close to the peak cell; scanning to confirm."
            elif modes >= 2:
                why = f"{modes} competing hypotheses share the probability mass; scanning for a bearing to separate them."
            else:
                why = f"{self.since_scan} steps since last scan; scanning to sharpen the belief."
            return out("scan", why, "scanning" if modes < 2 else strat)

        # Target choice: smoothed posterior mass, discounted by travel distance.
        P, loc = np.pad(self.belief, 1), np.zeros_like(self.belief)
        for oy in range(3):
            for ox in range(3):
                loc += P[oy:oy + self.h, ox:ox + self.w]
        score = loc / (1 + 0.12 * (np.abs(self.XX - pos[0]) + np.abs(self.YY - pos[1])))
        for x, y in self.obst:
            score[y, x] = -1
        score[pos[1], pos[0]] = -1
        order = np.argsort(-score, axis=None)
        cand = [(int(i % self.w), int(i // self.w)) for i in order[:16]]
        old = self.target
        if old and old != pos and score[old[1], old[0]] >= 0.8 * score[cand[0][1], cand[0][0]]:
            cand.insert(0, old)
        for t in cand:
            path = self.astar(pos, t)
            if path and len(path) > 1:
                self.target = t
                shift = " Strategy change: new target." if old and old != t else ""
                return out(self._dir(path[0], path[1]),
                           f"Heading to ({t[0]},{t[1]}), {loc[t[1], t[0]]:.0%} of belief nearby, {len(path) - 1} steps away.{shift}")
        for a, (dx, dy) in MOVES.items():
            if (pos[0] + dx, pos[1] + dy) not in self.obst and 0 <= pos[0] + dx < self.w and 0 <= pos[1] + dy < self.h:
                return out(a, "No planned route available; taking any free neighbouring cell.")
        return out("scan", "Boxed in; scanning.")


# ------------------------------------------------------------ particle filter
class ParticleFilter:
    """Sequential Monte Carlo over the same model, as an independent second opinion.

    Weighted samples are propagated through the drift model, reweighted by the
    sensor likelihood, and resampled (systematically) when the effective sample
    size falls below half. Reporting the ESS and the gap between this filter's
    mean and the grid filter's MAP is the point: two estimators of one posterior
    disagree exactly when the posterior is multimodal.
    """

    def __init__(self, b, n=400, seed=0, drift=Agent.DRIFT_BELIEF):
        self.w, self.h = b["width"], b["height"]
        self.n = n
        self.drift = drift
        self.scale = float(b["sensor"]["strength_scale"])
        self.decoys = [(tuple(d["pos"]), float(d["amplitude"])) for d in (b.get("decoys") or [])]
        self.rng = np.random.default_rng(seed + 991)
        self.obst = {tuple(o) for o in b["obstacles"]}
        cells = [(x, y) for x in range(self.w) for y in range(self.h) if (x, y) not in self.obst]
        idx = self.rng.integers(0, len(cells), size=n)
        self.p = np.array([cells[i] for i in idx], dtype=float)
        self.wt = np.full(n, 1.0 / n)
        self.ess = float(n)
        self.resamples = 0

    def predict(self):
        if self.drift <= 0:
            return
        moves = np.array(list(MOVES.values()))
        moving = self.rng.random(self.n) < self.drift
        steps = moves[self.rng.integers(0, 4, size=self.n)]
        cand = self.p + steps * moving[:, None]
        cand[:, 0] = np.clip(cand[:, 0], 0, self.w - 1)
        cand[:, 1] = np.clip(cand[:, 1], 0, self.h - 1)
        # Reject moves onto obstacles: keep the particle where it was.
        bad = np.array([(int(x), int(y)) in self.obst for x, y in cand])
        self.p = np.where(bad[:, None], self.p, cand)

    def decoy_field(self, pos):
        best = 0.0
        for (dx, dy), amp in self.decoys:
            best = max(best, amp * float(np.exp(-np.hypot(dx - pos[0], dy - pos[1]) / self.scale)))
        return best

    def update(self, pos, strength, bearing, s_sig, b_sig):
        """Reweight every particle by the same generative model the grid filter uses."""
        dx, dy = self.p[:, 0] - pos[0], self.p[:, 1] - pos[1]
        d = np.hypot(dx, dy)
        eve = np.exp(-d / self.scale)
        decoy = self.decoy_field(pos)
        like = np.exp(-0.5 * ((strength - np.maximum(eve, decoy)) / s_sig) ** 2)
        if bearing is not None:
            diff = (np.degrees(np.arctan2(dy, dx)) - bearing + 180) % 360 - 180
            sharp = 0.03 + 0.97 * np.exp(-0.5 * (diff / b_sig) ** 2)
            like = like * np.where(d < 0.5, 1.0, np.where(eve >= decoy, sharp, 1.0))
        w = self.wt * (1e-3 + like)
        t = w.sum()
        self.wt = w / t if t > 0 else np.full(self.n, 1.0 / self.n)
        self.ess = float(1.0 / np.sum(self.wt ** 2))
        if self.ess < self.n / 2:
            self._resample()
        return self.ess

    def _resample(self):
        """Systematic resampling: one uniform draw, evenly spaced pointers."""
        positions = (self.rng.random() + np.arange(self.n)) / self.n
        cum = np.cumsum(self.wt)
        cum[-1] = 1.0
        idx = np.searchsorted(cum, positions)
        self.p = self.p[np.clip(idx, 0, self.n - 1)]
        self.wt = np.full(self.n, 1.0 / self.n)
        self.resamples += 1

    def mean(self):
        return (float((self.p[:, 0] * self.wt).sum()), float((self.p[:, 1] * self.wt).sum()))

    def spread(self):
        mx, my = self.mean()
        return float(np.sqrt(((self.p[:, 0] - mx) ** 2 + (self.p[:, 1] - my) ** 2).mean()))

    def cloud(self, k=90):
        """A weighted sample of particle positions, rounded to cells, for the UI.

        Fewer than the population on purpose: 90 marks also fits on a 160-cell
        map without turning the overlay into a solid wash, and the sampler is
        weighted, so the thinning costs no information about where the mass is.
        """
        idx = self.rng.choice(self.n, size=min(k, self.n), p=self.wt / self.wt.sum())
        pts = self.p[idx]
        return [[int(round(x)), int(round(y))] for x, y in pts]


# --------------------------------------------------------------- evaluation
class Metrics:
    """Scores the agent against ground truth. NEVER fed back into its decisions.

    - information gain : D_KL(posterior || prior), in nats, per step.
    - log loss / Brier : proper scoring rules on the posterior at EVE's true cell.
    - top-1 / top-3    : did the argmax / a top-3 cell hold the truth?
    - calibration      : predicted trust vs observed hit rate, binned.
    - ROC / AUC        : pooled per-step ranking of every free cell.
    - detection matrix : "am I within one cell?" at a 0.5 posterior-mass threshold.
    """

    BINS = 10

    def __init__(self, w, h, free_cells):
        self.w, self.h = w, h
        self.n_free = max(1, free_cells)
        self.steps = 0
        self.kl_total = 0.0
        self.log_loss_total = 0.0
        self.brier_total = 0.0
        self.top1 = 0
        self.top3 = 0
        self.within1_mass = []
        self.credible = []
        self.bins = [[0, 0.0] for _ in range(self.BINS)]   # [count, mean predicted]
        self.bin_hits = [0] * self.BINS
        self.det = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
        self.rank_scores = []    # pooled (score, is_truth) for the ROC
        self.ranks = []          # the true cell's rank among free cells, per step
        self.gains = []

    def record(self, belief, prior, kl, true_cell, agent_cell, peak):
        self.steps += 1
        self.kl_total += max(0.0, kl)
        self.gains.append(round(float(max(0.0, kl)), 4))
        tx, ty = true_cell
        p_true = float(belief[ty, tx])
        self.log_loss_total += -float(np.log(max(p_true, 1e-12)))
        # Brier on the "is it this cell?" question, averaged over free cells.
        flat = belief.ravel()
        y = np.zeros_like(flat)
        y[ty * self.w + tx] = 1.0
        self.brier_total += float(((flat - y) ** 2).sum()) / self.n_free
        if (peak["x"], peak["y"]) == (tx, ty):
            self.top1 += 1
        top = np.argsort(belief.ravel())[::-1][:3]
        if ty * self.w + tx in set(int(i) for i in top):
            self.top3 += 1
        # Rank of the true cell (1 = best) among free cells — the AUC input.
        rank = int((flat > p_true).sum()) + 1
        self.ranks.append(rank / self.n_free)
        order = np.argsort(flat)[::-1][: self.n_free]
        for i in order:
            self.rank_scores.append((float(flat[i]), 1.0 if int(i) == ty * self.w + tx else 0.0))

        mass3 = float(belief[max(0, ty - 1):ty + 2, max(0, tx - 1):tx + 2].sum())
        self.within1_mass.append(mass3)
        self.credible.append(_credible(belief, 0.9))

        # Calibration + detection both use the agent's own neighbourhood belief.
        ax, ay = agent_cell
        trust = float(belief[max(0, ay - 1):ay + 2, max(0, ax - 1):ax + 2].sum())
        hit = 1 if (abs(ax - tx) <= 1 and abs(ay - ty) <= 1) else 0
        b = min(self.BINS - 1, int(trust * self.BINS))
        self.bins[b][0] += 1
        self.bins[b][1] += trust
        self.bin_hits[b] += hit
        pred_pos = trust >= 0.5
        if pred_pos and hit:
            self.det["tp"] += 1
        elif pred_pos and not hit:
            self.det["fp"] += 1
        elif not pred_pos and hit:
            self.det["fn"] += 1
        else:
            self.det["tn"] += 1

    def summary(self):
        n = max(1, self.steps)
        sens = self.det["tp"] / max(1, self.det["tp"] + self.det["fn"])
        prec = self.det["tp"] / max(1, self.det["tp"] + self.det["fp"])
        return {
            "steps_scored": self.steps,
            "log_loss": round(self.log_loss_total / n, 4),
            "brier": round(self.brier_total / n, 5),
            "top1_accuracy": round(self.top1 / n, 4),
            "top3_accuracy": round(self.top3 / n, 4),
            "mean_rank_percentile": round(float(np.mean(self.ranks)) if self.ranks else 0.0, 4),
            "auc": round(_auc(self.rank_scores), 4),
            "information_gain_total": round(self.kl_total, 4),
            "information_gain_mean": round(self.kl_total / n, 5),
            "mean_within_1_cell_mass": round(float(np.mean(self.within1_mass)) if self.within1_mass else 0.0, 4),
            "mean_credible_set_90": round(float(np.mean(self.credible)) if self.credible else 0.0, 2),
            "detection": {**self.det, "precision": round(prec, 3), "recall": round(sens, 3)},
            "calibration": [
                {"bin": i, "lo": i / self.BINS, "hi": (i + 1) / self.BINS,
                 "n": self.bins[i][0],
                 "predicted": round(self.bins[i][1] / self.bins[i][0], 4) if self.bins[i][0] else 0.0,
                 "observed": round(self.bin_hits[i] / self.bins[i][0], 4) if self.bins[i][0] else 0.0}
                for i in range(self.BINS)
            ],
            "roc": _roc_curve(self.rank_scores),
            "information_gain_series": self.gains,
        }


# ----------------------------------------------------------------- simulation wrapper
class Simulation:
    def __init__(self, cfg):
        self.cfg, self.env = cfg, Environment(cfg)
        self.agent = Agent(self.env.briefing())
        self.particles = ParticleFilter(self.env.briefing(), seed=cfg["seed"], drift=self.agent.believed_drift)
        self.metrics = Metrics(self.env.w, self.env.h, int(self.agent.free_mask.sum()))
        self.trace = []
        sig, (px, py, p) = self.env.initial_signal, self.agent.map_cell()
        self.trace.append(self._entry(
            "init", self.env.pos,
            {"ok": True, "note": "", "cost": 0, "clues": [],
             "signal": {"kind": "initial", "strength": sig["strength"], "bearing": sig["bearing_deg"]}},
            f"Mission loaded. Initial signal (bearing {sig['bearing_deg']} deg, strength {sig['strength']}) "
            f"gives a prior peaking at ({px},{py}) with {p:.0%}.", "searching"))
        self._score()

    # --- plumbing ---------------------------------------------------------
    def _score(self):
        a, e = self.agent, self.env
        self.metrics.record(a.belief, a.last_prior, a.last_kl, e.eve, e.pos, self._peak())

    def _peak(self):
        px, py, p = self.agent.map_cell()
        return {"x": px, "y": py, "p": round(p, 5)}

    def _entry(self, action, before, obs, reasoning, strategy):
        e, a = self.env, self.agent
        return {"step": e.steps, "action": action, "ok": obs["ok"], "note": obs["note"], "from": list(before),
                "position": {"x": e.pos[0], "y": e.pos[1]}, "battery": e.battery, "energy_cost": obs["cost"],
                "observation": {"signal": obs["signal"],
                                "clues": [{**c, "pos": list(c["pos"]), "hint": list(c["hint"])} for c in obs["clues"]]},
                "reasoning": reasoning, "strategy": strategy, "belief_peak": self._peak(),
                "entropy": round(a.entropy(), 5), "information_gain": round(a.last_kl, 5),
                "credible_set_90": a.credible_set(0.9), "modes": a.modes(),
                "ess": round(self.particles.ess, 1), "status": e.status()}

    def step(self):
        e, a = self.env, self.agent
        if e.done():
            return None
        # 1) Propagate the belief through the motion model (EVE moved last step).
        a.predict()
        self.particles.predict()

        # 2) Decide, act, and fold the observation in.
        d = a.decide(e.pos, e.battery, e.steps)
        before = e.pos
        obs = e.act(d["action"])
        a.observe(e.pos, d["action"], obs, e.found)
        sig = obs["signal"]
        if sig:
            self.particles.update(e.pos, sig["strength"], sig["bearing"],
                                  a.b["sensor"]["scan_sigma"] if sig["kind"] == "scan" else a.b["sensor"]["passive_sigma"],
                                  a.b["sensor"]["scan_bearing_sigma_deg"] if sig["kind"] == "scan" else 0)

        # 3) Let her move.
        drifted = e.drift()
        entry = self._entry(d["action"], before, obs, d["reasoning"], d["strategy"])
        entry["drift"] = drifted
        if drifted and not e.found:
            entry["note"] = (entry["note"] + " · EVE drifted to a new cell") if entry["note"] else "EVE drifted to a new cell"
            entry["reasoning"] += " [target moved: signal must be re-acquired]"
        self.trace.append(entry)
        self._score()
        if e.done():
            _persist_trace(self.cfg, self.trace, self.report())
        return entry

    def state(self):
        e, a = self.env, self.agent
        px, py, p = a.map_cell()
        mx, my = self.particles.mean()
        path = [[t["position"]["x"], t["position"]["y"]] for t in self.trace]
        return {"width": e.w, "height": e.h, "pos": list(e.pos), "path": path,
                "obstacles": [list(o) for o in sorted(e.obstacles)],
                "belief": np.round(a.belief, 5).tolist(),
                # The algebra the last update actually performed, for the UI.
                "prior": np.round(a.last_prior, 5).tolist(),
                "likelihood": np.round(a.last_likelihood, 5).tolist(),
                "particles": self.particles.cloud(),
                "particle_estimate": [round(mx, 2), round(my, 2)],
                "particle_spread": round(self.particles.spread(), 3),
                "ess": round(self.particles.ess, 1),
                "resamples": self.particles.resamples,
                "filter_gap": round(float(np.hypot(mx - (px + 0.5), my - (py + 0.5))), 3),
                "belief_uncertainty": a.entropy(),
                "credible_set_90": a.credible_set(0.9),
                "modes": a.modes(),
                "information_gain": round(a.last_kl, 5),
                "battery": e.battery, "battery_max": e.bmax,
                "steps": e.steps, "max_steps": e.cfg["max_steps"], "spent": e.spent, "counts": e.counts,
                "energy_pool": e.cfg["battery"]["initial"] + e.recharged,
                "stations": [{"pos": list(q), "charges": n} for q, n in e.stations.items()],
                "clues_found": [{"id": c["id"], "pos": list(c["pos"]), "hint": list(c["hint"]), "sigma": c["sigma"]}
                                for c in e.clues if c["found"]],
                "clue_total": len(e.clues), "peak": {"x": px, "y": py, "p": p}, "entropy": a.entropy(),
                "status": e.status(), "done": e.done(), "found": e.found,
                "eve": list(e.eve) if e.done() else None,
                "decoys": [[int(q[0]), int(q[1])] for q, _ in e.decoys],
                "metrics": self.metrics.summary()}

    def report(self):
        e, a = self.env, self.agent
        px, py, p = a.map_cell()
        near = float(a.belief[max(0, py - 1):py + 2, max(0, px - 1):px + 2].sum())
        st = e.status()
        rec = {"eve_found": "Contact established. Hand over the plant sample and begin the return journey.",
               "battery_depleted": f"WALL-E is out of power. Dispatch a recovery unit with a charge, sweeping ({px},{py}) first.",
               "time_expired": f"Time budget spent. Resume from the current cell and prioritise ({px},{py}).",
               "running": f"Mission in progress. Continue toward ({px},{py}) and re-scan on arrival."}[st]
        summary = self.metrics.summary()
        return {"status": st, "eve_found": e.found, "eve_actual_position": list(e.eve) if e.done() else None,
                "inferred_location": {"x": px, "y": py}, "confidence": round(p, 5),
                "confidence_within_1_cell": round(near, 5),
                "clues_found": [{"id": c["id"], "pos": list(c["pos"]), "hint": list(c["hint"])}
                                for c in e.clues if c["found"]],
                "clues_total": len(e.clues), "battery_remaining": e.battery, "steps_used": e.steps,
                "energy_spent": e.spent, "actions": e.counts,
                "metrics": summary,
                "particle_filter": {"ess": round(self.particles.ess, 1), "resamples": self.particles.resamples},
                "recommended_next_step": rec, "trace": self.trace}


# ----------------------------------------------------------------- helpers
def _shift(arr, dy, dx):
    """Translate an array by (dx, dy) without wrap-around; vacated cells become 0."""
    h, w = arr.shape
    out = np.zeros_like(arr)
    ys, ysrc = slice(max(0, dy), min(h, h + dy)), slice(max(0, -dy), min(h, h - dy))
    xs, xsrc = slice(max(0, dx), min(w, w + dx)), slice(max(0, -dx), min(w, w - dx))
    out[ys, xs] = arr[ysrc, xsrc]
    return out


def _kl(p, q, mask=None, eps=1e-12):
    """D_KL(p || q) in nats, over the support of p."""
    p = np.asarray(p, float)
    q = np.asarray(q, float)
    if mask is not None:
        p = np.where(mask, p, 0.0)
        q = np.where(mask, q, 0.0)
    sel = p > eps
    if not sel.any():
        return 0.0
    return float((p[sel] * np.log(p[sel] / np.maximum(q[sel], eps))).sum())


def _credible(arr, mass=0.9):
    flat = np.sort(np.asarray(arr, float).ravel())[::-1]
    flat = flat[flat > 0]
    if flat.size == 0:
        return 0
    return int(np.searchsorted(np.cumsum(flat), mass) + 1)


def _auc(pairs):
    """ROC-AUC via the Mann-Whitney U statistic (ties counted as half)."""
    if not pairs:
        return 0.0
    scores = np.array([s for s, _ in pairs], float)
    labels = np.array([l for _, l in pairs], float)
    pos, neg = int(labels.sum()), int((1 - labels).sum())
    if pos == 0 or neg == 0:
        return 0.0
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), float)
    ranks[order] = np.arange(1, len(scores) + 1)
    # Average ranks across tied score groups.
    i = 0
    s = scores[order]
    while i < len(s):
        j = i
        while j + 1 < len(s) and s[j + 1] == s[i]:
            j += 1
        if j > i:
            ranks[order[i:j + 1]] = (i + 1 + j + 1) / 2.0
        i = j + 1
    return float((ranks[labels == 1].sum() - pos * (pos + 1) / 2.0) / (pos * neg))


def _roc_curve(pairs, points=40):
    """Down-sampled ROC for plotting: threshold sweep over pooled per-step cells."""
    if not pairs:
        return {"points": [], "auc": 0.0}
    scores = np.array([s for s, _ in pairs], float)
    labels = np.array([l for _, l in pairs], float)
    order = np.argsort(-scores, kind="mergesort")
    labels = labels[order]
    pos = max(1, int(labels.sum()))
    neg = max(1, int((1 - labels).sum()))
    tpr = np.cumsum(labels) / pos
    fpr = np.cumsum(1 - labels) / neg
    if len(tpr) > points:
        idx = np.linspace(0, len(tpr) - 1, points).astype(int)
        tpr, fpr = tpr[idx], fpr[idx]
    pts = [[0.0, 0.0]] + [[round(float(f), 4), round(float(t), 4)] for f, t in zip(fpr, tpr)]
    pts.append([1.0, 1.0])
    return {"points": pts, "auc": round(_auc(pairs), 4)}


def _persist_trace(cfg, trace, report):
    """Flush the finished mission next to the app, or to the temp dir when the
    filesystem is read-only (serverless hosts such as Vercel)."""
    payload = {"config": cfg, "trace": trace, "report": report}
    for path in (os.path.join(os.path.dirname(os.path.abspath(__file__)), "mission_trace.json"),
                 os.path.join("/tmp", "mission_trace.json")):
        try:
            with open(path, "w") as f:
                json.dump(payload, f, indent=2)
            return
        except OSError:
            continue


# ----------------------------------------------------------------- Flask API
app = Flask(__name__)
lock = threading.Lock()


class Session:
    """A stateless-friendly handle on one deterministic mission.

    The whole simulation is a pure function of its scenario (seed + placement),
    so `/step` never has to trust process memory: it replays from the scenario
    when the cached instance has drifted or is missing. That keeps the API
    correct behind a load balancer, in a serverless function, or after a restart
    — while a warm instance still hits the O(1) fast path.
    """

    def __init__(self, cache_size=8):
        self.cache_size = cache_size
        self.cache = OrderedDict()
        self._key = None
        self.sim = Simulation(new_config())

    @staticmethod
    def key(scenario):
        return json.dumps(scenario or {}, sort_keys=True, separators=(",", ":"))

    def reset(self, scenario):
        cfg = new_config(bool(scenario.get("randomize")), scenario.get("seed"), scenario.get("difficulty"))
        sim = Simulation(cfg)
        resolved = {"seed": cfg["seed"], "difficulty": cfg["difficulty"], "eve": list(cfg["eve"])}
        k = self.key(resolved)
        self._key, self.sim = k, sim
        self.cache[k] = sim
        self.cache.move_to_end(k)
        while len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
        return sim, resolved

    def at(self, scenario, step_index):
        """Return the instance positioned so its next `/step` produces entry #step_index."""
        k = self.key(scenario)
        sim = self.cache.get(k)
        if sim is not None and sim.env.steps == step_index and not sim.env.done():
            self.cache.move_to_end(k)
            self._key, self.sim = k, sim
            return sim
        # Slow path: rebuild from the scenario and replay to the requested step.
        sim = Simulation(_replay_config(scenario))
        guard = 0
        while sim.env.steps < step_index and not sim.env.done() and guard < sim.cfg["max_steps"] + 4:
            if sim.step() is None:
                break
            guard += 1
        self.cache[k] = sim
        self.cache.move_to_end(k)
        while len(self.cache) > self.cache_size:
            self.cache.popitem(last=False)
        self._key, self.sim = k, sim
        return sim

    def step(self, scenario, step_index=None):
        if scenario is None:
            sim = self.sim
        elif step_index is None:
            sim = self.at(scenario, self.sim.env.steps)
        else:
            sim = self.at(scenario, int(step_index))
        return sim


SESSION = Session()


# ----------------------------------------------------------------- static front-end
# Two pages, both dependency-free (html/css/js only, no build step):
#   /        frontend/index.html   the landing page (motion from pinned CDN libs)
#   /mission frontend/mission.html the live pursuit lab
# Flask serves them at the same origin as the API, so the browser never needs
# CORS. `/assets/<path>` exposes css/, js/ and data/ subfolders.
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend")


@app.get("/")
def index():
    return send_file(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/mission")
def mission():
    return send_file(os.path.join(FRONTEND_DIR, "mission.html"))


@app.get("/assets/<path:filename>")
def assets(filename):
    resp = send_from_directory(FRONTEND_DIR, filename)
    low = filename.lower()
    if low.endswith(".js"):
        resp.headers["Content-Type"] = "text/javascript; charset=utf-8"
    elif low.endswith(".css"):
        resp.headers["Content-Type"] = "text/css; charset=utf-8"
    elif low.endswith(".svg"):
        resp.headers["Content-Type"] = "image/svg+xml; charset=utf-8"
    return resp


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "time": round(time.time(), 3)})


@app.post("/reset")
def reset():
    body = request.get_json(silent=True) or {}
    with lock:
        sim, scenario = SESSION.reset(body)
        return jsonify({"state": sim.state(), "entry": sim.trace[0], "scenario": scenario})


@app.post("/step")
def step():
    """Advance one decision.

    Optional body — `{"scenario": {...}, "step": n}` — makes this idempotent:
    the server reconstructs the mission from the scenario and replays to `step`,
    so it does not depend on any particular process holding the state.
    """
    body = request.get_json(silent=True) or {}
    scenario, step_index = body.get("scenario"), body.get("step")
    with lock:
        sim = SESSION.step(scenario, step_index)
        entry = sim.step()
        done = sim.env.done()
        return jsonify({"state": sim.state(), "entry": entry, "report": sim.report() if done else None,
                        "message": "mission already ended" if entry is None else "",
                        "scenario": scenario})


@app.get("/report")
def report():
    scenario = request.args.get("scenario")
    with lock:
        sim = SESSION.step(json.loads(scenario), None) if scenario else SESSION.sim
        return jsonify(sim.report())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)
