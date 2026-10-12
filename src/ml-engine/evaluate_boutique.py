"""
Domain-shift gate: does the model, run through the SERVING path (features.py + model_pure.py +
inference.predict_fn), find injected faults on a small Online-Boutique-shaped graph?

The model was trained on one 7,384-node Alibaba graph with per-graph min-max features. A 12-node
graph is far outside that, so a good Alibaba test score says nothing about it. This script measures
it with the same synthetic fault generator used for training (fault_injection.py).

Two variants are reported:
  * proportional (the GATE): 1-2 distractor spikes. The training generator adds 2-6 isolated
    distractors to a 7,384-node graph (under 0.1% of nodes); on 12 nodes that would make half the
    graph spike, which is not the same difficulty, so it is scaled down.
  * faithful: the generator exactly as trained (2-6 distractors).

Usage:
    python evaluate_boutique.py [--weights artifacts/model.pt] [--scenarios 600] [--seed 0]
Exit code 0 if the gate (top-1 >= 0.60 and top-3 >= 0.90 on the proportional variant) is met.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import tempfile
from pathlib import Path

import pandas as pd
import torch

import fault_injection
from features import DELTA_SCALE
from graph_dataset import ServiceGraph
from inference import Bundle, predict_fn
from model_pure import PureRootCauseGNN

ROOT = Path(__file__).parent
FIXTURE = ROOT / "fixtures" / "boutique_topology.json"
DEFAULT_WEIGHTS = ROOT / "artifacts" / "model.pt"
DIST_DIR = ROOT / "dist"

GATE_TOP1 = 0.60
GATE_TOP3 = 0.90
PROPORTIONAL_DISTRACTORS = (1, 2)


def load_topology(path: Path = FIXTURE) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def graph_from_topology(topology: dict) -> ServiceGraph:
    """ServiceGraph reads the Alibaba CSV schema, so write the fixture in that schema."""
    tmp = Path(tempfile.mkdtemp(prefix="boutique_graph_"))
    pd.DataFrame(topology["nodes"]).rename(columns={"name": "service_name"}).to_csv(tmp / "nodes.csv", index=False)
    pd.DataFrame(topology["edges"]).to_csv(tmp / "edges.csv", index=False)
    return ServiceGraph(nodes_path=tmp / "nodes.csv", edges_path=tmp / "edges.csv")


def snapshot_payload(topology: dict, graph: ServiceGraph, own_scaled: torch.Tensor, top_k: int) -> dict:
    """What a caller would send: raw node/edge fields plus the relative deviation per service.

    ``own_scaled`` is the generator's already-scaled deviation (delta / 9), so multiply back."""
    delta = (own_scaled * DELTA_SCALE).tolist()
    by_name = {n["name"]: n for n in topology["nodes"]}
    nodes = [
        {**{k: by_name[name][k] for k in ("name", "total_calls_as_um", "total_calls_as_dm")}, "own_delta": delta[i]}
        for i, name in enumerate(graph.service_names)
    ]
    return {"nodes": nodes, "edges": topology["edges"], "top_k": top_k}


def evaluate(bundle: Bundle, topology: dict, scenarios: int, seed: int, distractors: tuple[int, int] | None) -> dict:
    graph = graph_from_topology(topology)
    saved = fault_injection.N_DISTRACTORS_RANGE
    if distractors is not None:
        fault_injection.N_DISTRACTORS_RANGE = distractors
    try:
        rng = random.Random(seed)
        top1 = top3 = trivial1 = trivial3 = 0
        for _ in range(scenarios):
            sc = fault_injection.generate_scenario(graph, rng)
            payload = snapshot_payload(topology, graph, sc.dynamic_feature, top_k=3)
            ranked = [r["name"] for r in predict_fn(payload, bundle)["ranking"]]
            truth = graph.service_names[sc.root_index]
            top1 += ranked[:1] == [truth]
            top3 += truth in ranked[:3]
            order = torch.argsort(sc.dynamic_feature, descending=True).tolist()
            trivial1 += order[0] == sc.root_index
            trivial3 += sc.root_index in order[:3]
    finally:
        fault_injection.N_DISTRACTORS_RANGE = saved
    n_candidates = len(graph.candidate_root_indices)
    return {
        "scenarios": scenarios,
        "candidates": n_candidates,
        "top1": top1 / scenarios,
        "top3": top3 / scenarios,
        "trivial_top1": trivial1 / scenarios,
        "trivial_top3": trivial3 / scenarios,
        "random_top1": 1.0 / n_candidates,
        "random_top3": min(1.0, 3.0 / n_candidates),
    }


def load_bundle(weights: Path, version: str = "eval") -> Bundle:
    state = torch.load(weights, map_location="cpu")
    return Bundle(PureRootCauseGNN.from_state_dict(state), {"model_version": version, "node_in_dim": 7})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS)
    parser.add_argument("--scenarios", type=int, default=600)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=Path, default=DIST_DIR / "boutique_eval.json")
    args = parser.parse_args()

    topology = load_topology()
    bundle = load_bundle(args.weights)
    results = {
        "weights": str(args.weights),
        "weights_sha256": hashlib.sha256(args.weights.read_bytes()).hexdigest(),
        "topology": f"{len(topology['nodes'])} nodes, {len(topology['edges'])} edges (volumes synthetic)",
        "proportional": evaluate(bundle, topology, args.scenarios, args.seed, PROPORTIONAL_DISTRACTORS),
        "faithful": evaluate(bundle, topology, args.scenarios, args.seed, None),
    }
    gate = results["proportional"]
    met = gate["top1"] >= GATE_TOP1 and gate["top3"] >= GATE_TOP3
    results["gate"] = {"top1_min": GATE_TOP1, "top3_min": GATE_TOP3, "met": met}

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")

    print(f"weights: {args.weights}\ntopology: {results['topology']}")
    for label in ("proportional", "faithful"):
        r = results[label]
        print(
            f"{label:>12}: top1={r['top1']:.3f} top3={r['top3']:.3f}   "
            f"(trivial argmax-of-input {r['trivial_top1']:.3f}/{r['trivial_top3']:.3f}, "
            f"random {r['random_top1']:.3f}/{r['random_top3']:.3f}; n={r['scenarios']}, candidates={r['candidates']})"
        )
    print(f"GATE (proportional: top1>={GATE_TOP1}, top3>={GATE_TOP3}): {'MET' if met else 'NOT MET'}")
    return 0 if met else 1


if __name__ == "__main__":
    sys.exit(main())
