# record_demo_run.py — freeze one REAL mission into frontend/data/demo_run.json
# -----------------------------------------------------------------------------
# The landing page replays a real run, and shows real scores for it: this script
# runs the shipped default scenario (seed 7, "standard") headlessly and dumps
# everything the page needs to be honest about what happened.
#
#   per frame     step, action, ok/note, position, battery, energy cost, entropy,
#                 information gain, belief peak, the FULL quantised posterior,
#                 the one-line reasoning and the strategy label
#   config        grid size, obstacles, stations, decoys, costs, sensor model
#   outcome       status, EVE's cell, the inferred cell, and the evaluation
#                 metrics block (log loss, Brier, top-1/top-3, AUC, calibration
#                 bins, ROC points, detection matrix)
#
# The JSON is quantised (probabilities -> 0..255 relative to the frame's own
# maximum) purely to keep the file small; nothing else is lossy, and no number
# here is typed by hand.
#
# Usage:  python record_demo_run.py
import json
import os

import numpy as np

from app import Simulation, new_config

STEPS_LIMIT = 320                       # safety valve; the seeded run ends sooner
SEED = 7
DIFFICULTY = "standard"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "data", "demo_run.json")


def quantise(belief):
    """Map a probability grid to 0-255 ints (relative to its own maximum)."""
    arr = np.asarray(belief, dtype=float)
    peak = float(arr.max()) or 1.0
    return np.round(arr / peak * 255).astype(int).ravel().tolist()


def main():
    cfg = new_config(seed=SEED, difficulty=DIFFICULTY)
    sim = Simulation(cfg)
    frames = []

    def snapshot(entry):
        return {
            "step": entry["step"],
            "action": entry["action"],
            "ok": entry["ok"],
            "note": entry["note"],
            "pos": [entry["position"]["x"], entry["position"]["y"]],
            "battery": entry["battery"],
            "cost": entry["energy_cost"],
            "entropy": entry["entropy"],
            "gain": entry["information_gain"],
            "peak": entry["belief_peak"],
            "credible": entry["credible_set_90"],
            "modes": entry["modes"],
            "ess": entry["ess"],
            "belief": quantise(sim.agent.belief),
            "reasoning": entry["reasoning"],
            "strategy": entry["strategy"],
            "status": entry["status"],
        }

    frames.append(snapshot(sim.trace[0]))
    while not sim.env.done() and len(frames) < STEPS_LIMIT:
        entry = sim.step()
        if entry:
            frames.append(snapshot(entry))

    report = sim.report()
    payload = {
        "label": f"seed {cfg['seed']} · {cfg['grid']['width']}×{cfg['grid']['height']} grid · "
                 f"{cfg['difficulty']} threat · budget {cfg['battery']['initial']} battery / {cfg['max_steps']} steps",
        "config": {
            "seed": cfg["seed"],
            "difficulty": cfg["difficulty"],
            "width": cfg["grid"]["width"],
            "height": cfg["grid"]["height"],
            "start": cfg["start"],
            "obstacles": cfg["obstacles"],
            "stations": [{"pos": s["pos"], "charges": s["charges"]} for s in cfg["recharge"]["stations"]],
            "decoys": cfg["decoys"],
            "costs": cfg["costs"],
            "battery_max": cfg["battery"]["max"],
            "max_steps": cfg["max_steps"],
            "clue_error": cfg["clue_error"],
            "drift_p": cfg["drift"]["p"],
            "sensor": cfg["sensor"],
            "initial_signal": sim.env.initial_signal,
        },
        "outcome": {
            "status": report["status"],
            "eve_found": report["eve_found"],
            "eve": report["eve_actual_position"],
            "inferred": report["inferred_location"],
            "confidence": report["confidence"],
            "confidence_within_1_cell": report["confidence_within_1_cell"],
            "steps_used": report["steps_used"],
            "battery_remaining": report["battery_remaining"],
            "energy_spent": report["energy_spent"],
            "actions": report["actions"],
            "clues_found": len(report["clues_found"]),
            "clues_total": report["clues_total"],
            "metrics": report["metrics"],
            "particle_filter": report["particle_filter"],
        },
        "frames": frames,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    m = report["metrics"]
    print(f"wrote {OUT}: {len(frames)} frames, {os.path.getsize(OUT)} bytes")
    print(f"  status={report['status']} steps={report['steps_used']} battery={report['battery_remaining']} "
          f"evE={report['eve_actual_position']} inferred=({report['inferred_location']['x']},{report['inferred_location']['y']})")
    print(f"  AUC={m['auc']} logloss={m['log_loss']} brier={m['brier']} top1={m['top1_accuracy']} "
          f"top3={m['top3_accuracy']} KL_mean={m['information_gain_mean']} credible90={m['mean_credible_set_90']}")


if __name__ == "__main__":
    main()
