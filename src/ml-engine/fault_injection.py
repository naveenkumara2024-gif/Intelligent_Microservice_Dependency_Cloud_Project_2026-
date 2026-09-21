"""
Synthetic fault-injection scenario generator.

The raw trace data has no real failure labels (confirmed in Stage 1), so we
generate labeled examples by injecting a latency spike at a random node and
propagating a decaying "observed latency" signal BACKWARDS along CALLS
edges (callee -> caller), matching how a real degradation actually surfaces:
a slow downstream service makes every upstream caller look slow too, not
the other way around. See prompt/stage-03-gnn-training.md for the full
rationale.
"""

import random
from dataclasses import dataclass

import numpy as np
import torch

from graph_dataset import ServiceGraph

MAX_HOPS = 4
DECAY = 0.6
FACTOR_LOW, FACTOR_HIGH = 3.0, 10.0


@dataclass
class Scenario:
    dynamic_feature: torch.Tensor  # [N] normalized observed-latency-delta
    root_index: int


def _ancestors_within_hops(graph: ServiceGraph, root: int, max_hops: int) -> dict[int, int]:
    """BFS over reverse adjacency (callers) from root. Returns {node_idx: hop_distance}."""
    visited = {root: 0}
    frontier = [root]
    hop = 0
    while frontier and hop < max_hops:
        hop += 1
        next_frontier = []
        for n in frontier:
            for caller in graph.reverse_adj.get(n, ()):
                if caller not in visited:
                    visited[caller] = hop
                    next_frontier.append(caller)
        frontier = next_frontier
    return visited


def inject_fault(graph: ServiceGraph, root: int, factor: float) -> Scenario:
    """Build a Scenario by injecting a fault at a specific root node with a
    specific severity factor (used both by random scenario generation below
    and by predict.py for interactive, user-chosen testing)."""
    ancestors = _ancestors_within_hops(graph, root, MAX_HOPS)

    delta = np.zeros(graph.num_nodes, dtype=np.float32)
    for node_idx, hop in ancestors.items():
        baseline = graph.baseline_latency[node_idx]
        attenuation = DECAY ** hop
        delta[node_idx] = baseline * (factor - 1.0) * attenuation

    # Root itself gets the full injected delta (hop 0 case is included above
    # since ancestors[root] == 0 -> attenuation = 1.0), but root's baseline
    # latency is measured as an *outgoing* caller latency which may be 0 for
    # leaf services with no outgoing calls; fall back to the global-mean
    # baseline already stored for such nodes by ServiceGraph.

    if delta.max() > 1e-9:
        delta = delta / delta.max()  # normalize scenario to [0, 1]

    return Scenario(dynamic_feature=torch.tensor(delta), root_index=root)


def generate_scenario(graph: ServiceGraph, rng: random.Random) -> Scenario:
    root = rng.choice(graph.candidate_root_indices)
    factor = rng.uniform(FACTOR_LOW, FACTOR_HIGH)
    return inject_fault(graph, root, factor)


def generate_dataset(graph: ServiceGraph, n: int, seed: int) -> list[Scenario]:
    rng = random.Random(seed)
    return [generate_scenario(graph, rng) for _ in range(n)]


if __name__ == "__main__":
    graph = ServiceGraph()
    rng = random.Random(0)
    scenario = generate_scenario(graph, rng)
    affected = int((scenario.dynamic_feature > 0).sum())
    print(f"root index: {scenario.root_index} ({graph.service_names[scenario.root_index][:16]}...)")
    print(f"affected (nonzero-delta) ancestor nodes: {affected}")
    print(f"dynamic_feature stats: min={scenario.dynamic_feature.min():.4f} "
          f"max={scenario.dynamic_feature.max():.4f} mean={scenario.dynamic_feature.mean():.6f}")
