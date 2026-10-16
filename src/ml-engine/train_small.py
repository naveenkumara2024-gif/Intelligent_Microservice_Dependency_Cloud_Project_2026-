"""
Stage 10: short retrain of RootCauseGNN for SMALL service graphs (the live Online Boutique graph has
about a dozen services; the Stage 3 model was trained on one 7,384-node graph).

Why: evaluate_boutique.py showed the Stage 3 weights fall below the deployment gate on a 12-node
graph (min-max features are per-graph, so a tiny graph looks nothing like the training graph).

What it trains on (synthetic fault injection, same generator and loss as Stage 3):
  * random layered microservice topologies of 8-30 services (entry -> mid-tier -> data stores);
  * 8-30-node ego subgraphs sampled from the real Alibaba call graph;
  * optionally (--include-boutique) perturbed variants of the Boutique topology itself.
By default the Boutique topology is HELD OUT, so evaluating on it measures generalisation to an
unseen small topology, not memorisation.

Training and serving share features.build_features, so there is no train/serve skew by construction.
Starts from the Stage 3 weights (fine-tune), unless --scratch.

Usage:
    python train_small.py                              # -> artifacts/model_small.pt
    python train_small.py --include-boutique --out artifacts/model_small_b.pt
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn.functional as F

import fault_injection
from features import DELTA_SCALE, RPCTYPES, build_features
from model import RootCauseGNN

ROOT = Path(__file__).parent
ARTIFACTS_DIR = ROOT / "artifacts"
PROCESSED_DIR = ROOT.parent.parent / "Dataset" / "processed"
FIXTURE = ROOT / "fixtures" / "boutique_topology.json"

SEED = 20261012
LR = 5e-4
EPOCHS = 40
PATIENCE = 6
HIDDEN_DIM = 64
MIN_NODES, MAX_NODES = 8, 30


class SmallGraph:
    """The few attributes fault_injection needs, computed as graph_dataset.ServiceGraph does."""

    def __init__(self, nodes: list[dict], edges: list[dict]):
        self.service_names = sorted(n["name"] for n in nodes)
        idx = {name: i for i, name in enumerate(self.service_names)}
        self.num_nodes = len(self.service_names)
        um = [idx[e["um"]] for e in edges]
        dm = [idx[e["dm"]] for e in edges]
        out_volume = [0.0] * self.num_nodes
        for u, d, e in zip(um, dm, edges):
            if u != d:
                out_volume[u] += e["call_count"]
        self.reverse_weight: dict[int, dict[int, float]] = {}
        for u, d, e in zip(um, dm, edges):
            if u != d:
                self.reverse_weight.setdefault(d, {})[u] = e["call_count"] / out_volume[u]
        self.candidate_root_indices = sorted(set(dm))


def _with_counters(names: list[str], edges: list[dict]) -> list[dict]:
    out_c = {n: 0 for n in names}
    in_c = {n: 0 for n in names}
    for e in edges:
        out_c[e["um"]] += e["call_count"]
        in_c[e["dm"]] += e["call_count"]
    return [{"name": n, "total_calls_as_um": out_c[n], "total_calls_as_dm": in_c[n]} for n in names]


def random_microservice(rng: random.Random) -> dict:
    n = rng.randint(MIN_NODES, MAX_NODES)
    layers = rng.randint(3, 5)
    names = [f"svc{i:02d}" for i in range(n)]
    layer_of = {names[0]: 0}
    for name in names[1:]:
        layer_of[name] = rng.randint(1, layers - 1)
    by_layer: dict[int, list[str]] = {}
    for name, layer in layer_of.items():
        by_layer.setdefault(layer, []).append(name)
    pairs: set[tuple[str, str]] = set()
    for name in names:
        lower = [m for m in names if layer_of[m] > layer_of[name]]
        if not lower:
            continue
        for callee in rng.sample(lower, min(len(lower), rng.randint(1, 4))):
            pairs.add((name, callee))
    for name in names[1:]:  # everything below the entry layer is reachable from something above it
        if not any(d == name for _, d in pairs):
            above = [m for m in names if layer_of[m] < layer_of[name]]
            pairs.add((rng.choice(above), name))
    last = max(layer_of.values())
    edges = []
    for um, dm in sorted(pairs):
        if layer_of[dm] == last and rng.random() < 0.5:
            kind = rng.choice(["db", "mc"])
        elif layer_of[um] == 0 and rng.random() < 0.3:
            kind = "http"
        elif rng.random() < 0.05:
            kind = rng.choice(["mq", "userDefined"])
        else:
            kind = "rpc"
        avg = math.exp(rng.uniform(math.log(0.3), math.log(80.0)))
        edges.append(
            {
                "um": um,
                "dm": dm,
                "call_count": int(math.exp(rng.uniform(math.log(1e2), math.log(1e7)))),
                "avg_latency_ms": avg,
                "p95_latency_ms": avg * rng.uniform(1.5, 8.0),
                "rpctype": kind,
            }
        )
    return {"nodes": _with_counters(names, edges), "edges": edges}


class AlibabaEgo:
    def __init__(self):
        self.nodes = pd.read_csv(PROCESSED_DIR / "nodes.csv").set_index("service_name")
        edges = pd.read_csv(PROCESSED_DIR / "edges.csv")
        self.edges_by_pair = {(r.um, r.dm): r for r in edges.itertuples(index=False)}
        self.neighbours: dict[str, set[str]] = {}
        for um, dm in self.edges_by_pair:
            if um != dm:
                self.neighbours.setdefault(um, set()).add(dm)
                self.neighbours.setdefault(dm, set()).add(um)
        self.seeds = sorted(self.neighbours)

    def sample(self, rng: random.Random) -> dict | None:
        target = rng.randint(MIN_NODES, MAX_NODES)
        start = rng.choice(self.seeds)
        chosen, frontier = {start}, [start]
        while frontier and len(chosen) < target:
            current = frontier.pop(rng.randrange(len(frontier)))
            options = sorted(self.neighbours[current] - chosen)
            rng.shuffle(options)
            for nb in options[: max(1, target - len(chosen))]:
                chosen.add(nb)
                frontier.append(nb)
                if len(chosen) >= target:
                    break
        edges = [
            {
                "um": r.um,
                "dm": r.dm,
                "call_count": int(r.call_count),
                "avg_latency_ms": float(r.avg_latency_ms),
                "p95_latency_ms": float(r.p95_latency_ms),
                "rpctype": r.rpctype,
            }
            for (um, dm), r in self.edges_by_pair.items()
            if um in chosen and dm in chosen
        ]
        if not edges:
            return None
        names = sorted(chosen)
        return {
            "nodes": [
                {
                    "name": n,
                    "total_calls_as_um": int(self.nodes.loc[n, "total_calls_as_um"]),
                    "total_calls_as_dm": int(self.nodes.loc[n, "total_calls_as_dm"]),
                }
                for n in names
            ],
            "edges": edges,
        }


def perturbed_boutique(rng: random.Random) -> dict:
    base = json.loads(FIXTURE.read_text(encoding="utf-8"))
    edges = []
    for e in base["edges"]:
        avg = e["avg_latency_ms"] * math.exp(rng.uniform(-1.0, 1.0))
        edges.append(
            {
                **e,
                "call_count": max(1, int(e["call_count"] * math.exp(rng.uniform(-1.5, 1.5)))),
                "avg_latency_ms": avg,
                "p95_latency_ms": avg * rng.uniform(2.0, 6.0),
            }
        )
    return {"nodes": _with_counters([n["name"] for n in base["nodes"]], edges), "edges": edges}


def make_topologies(count: int, rng: random.Random, ego: AlibabaEgo, include_boutique: bool) -> list[dict]:
    out: list[dict] = []
    while len(out) < count:
        roll = rng.random()
        if include_boutique and roll < 0.2:
            topo = perturbed_boutique(rng)
        elif roll < 0.6:
            topo = random_microservice(rng)
        else:
            topo = ego.sample(rng)
        if topo is None:
            continue
        graph = SmallGraph(topo["nodes"], topo["edges"])
        if len(graph.candidate_root_indices) >= 3:
            out.append(topo)
    return out


def make_scenarios(topologies: list[dict], per_topology: int, rng: random.Random) -> list[tuple[dict, str, list[float]]]:
    """(topology, true root name, per-node own_delta in the snapshot's node order)."""
    scenarios = []
    saved = fault_injection.N_DISTRACTORS_RANGE
    try:
        for topo in topologies:
            graph = SmallGraph(topo["nodes"], topo["edges"])
            fault_injection.N_DISTRACTORS_RANGE = (0, max(1, graph.num_nodes // 4))
            for _ in range(per_topology):
                sc = fault_injection.generate_scenario(graph, rng)  # delta already divided by 9
                scenarios.append((topo, graph.service_names[sc.root_index], (sc.dynamic_feature * DELTA_SCALE).tolist()))
    finally:
        fault_injection.N_DISTRACTORS_RANGE = saved
    return scenarios


def tensors(topo: dict, root: str, delta: list[float]):
    names = sorted(n["name"] for n in topo["nodes"])
    by_name = {n["name"]: n for n in topo["nodes"]}
    nodes = [{**by_name[name], "own_delta": delta[i]} for i, name in enumerate(names)]
    f = build_features(nodes, topo["edges"])
    return f.x, f.edge_index, f.edge_attr, names.index(root)


def evaluate(model, scenarios, ks=(1, 3)) -> tuple[float, dict]:
    model.eval()
    loss, hits = 0.0, {k: 0 for k in ks}
    with torch.no_grad():
        for topo, root, delta in scenarios:
            x, ei, ea, target = tensors(topo, root, delta)
            logits = model(x, ei, ea)
            loss += F.nll_loss(F.log_softmax(logits, 0).unsqueeze(0), torch.tensor([target])).item()
            top = torch.topk(logits, min(max(ks), logits.shape[0])).indices.tolist()
            for k in ks:
                hits[k] += target in top[:k]
    n = len(scenarios)
    return loss / n, {k: hits[k] / n for k in ks}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--init", type=Path, default=ARTIFACTS_DIR / "model.pt")
    parser.add_argument("--scratch", action="store_true", help="random init instead of fine-tuning")
    parser.add_argument("--include-boutique", action="store_true")
    parser.add_argument("--topologies", type=int, default=700)
    parser.add_argument("--per-topology", type=int, default=8)
    parser.add_argument("--out", type=Path, default=ARTIFACTS_DIR / "model_small.pt")
    args = parser.parse_args()

    torch.manual_seed(SEED)
    rng = random.Random(SEED)
    ego = AlibabaEgo()

    print(f"building {args.topologies} training topologies (+ held-out validation)...")
    train_topos = make_topologies(args.topologies, rng, ego, args.include_boutique)
    val_topos = make_topologies(max(60, args.topologies // 8), random.Random(SEED + 1), ego, args.include_boutique)
    train = make_scenarios(train_topos, args.per_topology, rng)
    val = make_scenarios(val_topos, 5, random.Random(SEED + 2))
    sizes = [len(t["nodes"]) for t in train_topos]
    print(f"  train scenarios={len(train)} val={len(val)}  graph size {min(sizes)}-{max(sizes)} (median {int(np.median(sizes))})")

    model = RootCauseGNN(node_in_dim=7, edge_dim=9, hidden_dim=HIDDEN_DIM, improved=True, dynamic_dim=3)
    if not args.scratch:
        model.load_state_dict(torch.load(args.init, map_location="cpu"))
        print(f"fine-tuning from {args.init}")
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)

    best_loss, best_state, stale = float("inf"), None, 0
    for epoch in range(1, EPOCHS + 1):
        model.train()
        t0 = time.time()
        rng.shuffle(train)
        total = 0.0
        for topo, root, delta in train:
            x, ei, ea, target = tensors(topo, root, delta)
            optimizer.zero_grad()
            loss = F.nll_loss(F.log_softmax(model(x, ei, ea), 0).unsqueeze(0), torch.tensor([target]))
            loss.backward()
            optimizer.step()
            total += loss.item()
        val_loss, acc = evaluate(model, val)
        print(f"epoch {epoch:2d}/{EPOCHS} train_loss={total / len(train):.4f} val_loss={val_loss:.4f} "
              f"val_top1={acc[1]:.3f} val_top3={acc[3]:.3f} ({time.time() - t0:.0f}s)")
        if val_loss < best_loss - 1e-4:
            best_loss, best_state, stale = val_loss, copy.deepcopy(model.state_dict()), 0
        else:
            stale += 1
            if stale >= PATIENCE:
                print(f"early stopping at epoch {epoch}")
                break

    model.load_state_dict(best_state)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    torch.save({k: v.cpu() for k, v in model.state_dict().items()}, args.out)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
