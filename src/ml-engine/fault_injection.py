"""
Synthetic fault-injection scenario generator.

The raw trace data has no real failure labels (confirmed in Stage 1), so we
generate labeled examples by injecting a latency spike at a random node and
propagating an "observed latency" signal BACKWARDS along CALLS edges
(callee -> caller), weighted by how much of each caller's traffic depends on
the faulty path, matching how a real degradation actually surfaces: a slow
downstream service makes the upstream callers that rely on it look slow too,
not the other way around. See prompt/stage-03-gnn-training.md and
prompt/stage-03-followup-feature-improvements.md for the rationale.
"""

import random
from dataclasses import dataclass

import numpy as np
import torch

from graph_dataset import ServiceGraph

MAX_HOPS = 4
N_DISTRACTORS_RANGE = (2, 6)
# Background latency jitter on every node, as a fraction of its normal latency
# (half-normal, so slowdown only). Without it unaffected nodes read exactly 0
# and any faint caller ripple becomes a perfect giveaway for the root (a
# noiseless model reached 97% top-1 but fell to 39% at this jitter level).
JITTER_SIGMA = 0.10
FACTOR_LOW, FACTOR_HIGH = 3.0, 10.0


@dataclass
class Scenario:
    dynamic_feature: torch.Tensor  # [N] relative latency deviation, scaled to ~[0, 1]
    root_index: int


def _propagate_impact(graph: ServiceGraph, root: int, max_hops: int) -> dict[int, float]:
    """Traffic-weighted propagation from root up through its callers.

    A caller's impact is the strongest path-product, over at most max_hops
    hops, of "fraction of each caller's outgoing traffic that goes toward the
    fault" (ServiceGraph.reverse_weight). A caller that sends most of its
    calls toward the faulty node feels it strongly; one that barely calls it
    feels almost nothing, regardless of hop distance alone.
    """
    impact = {root: 1.0}
    frontier = {root}
    for _ in range(max_hops):
        updated = set()
        for callee in frontier:
            for caller, weight in graph.reverse_weight.get(callee, {}).items():
                candidate = impact[callee] * weight
                if candidate > impact.get(caller, 0.0):
                    impact[caller] = candidate
                    updated.add(caller)
        frontier = updated
        if not frontier:
            break
    return impact


def inject_fault(graph: ServiceGraph, root: int, factor: float,
                 rng: random.Random | None = None) -> Scenario:
    """Build a Scenario by injecting a fault at a specific root node with a
    specific severity factor (used both by random scenario generation below
    and by predict.py for interactive, user-chosen testing).

    If rng is given, also adds a few isolated distractor spikes (see
    N_DISTRACTORS_RANGE) and background jitter (JITTER_SIGMA). Without it the
    scenario is the pure, noise-free fault.
    """
    impact = _propagate_impact(graph, root, MAX_HOPS)

    # Deviation is RELATIVE to each service's own normal latency
    # (observed / normal - 1), the standard anomaly-detection signal. Using
    # absolute milliseconds instead makes a fast service's fault invisible
    # next to any blip on a slow service.
    delta = np.zeros(graph.num_nodes, dtype=np.float32)
    for node_idx, node_impact in impact.items():
        delta[node_idx] = (factor - 1.0) * node_impact

    # Distractors: unrelated transient latency blips on a few other nodes.
    # Real fault = a coherent ripple through callers; a distractor is a lone
    # spike with no ripple, so the biggest raw number is NOT reliably the root.
    if rng is not None:
        others = [i for i in range(graph.num_nodes) if i != root]
        for node_idx in rng.sample(others, rng.randint(*N_DISTRACTORS_RANGE)):
            spike = rng.uniform(FACTOR_LOW, FACTOR_HIGH) - 1.0
            delta[node_idx] = max(delta[node_idx], spike)

    if rng is not None:
        jitter_rng = np.random.default_rng(rng.getrandbits(32))
        delta += np.abs(jitter_rng.normal(0.0, JITTER_SIGMA, graph.num_nodes)).astype(np.float32)

    # Fixed scale (not per-scenario max) so absolute severity is preserved.
    delta = delta / (FACTOR_HIGH - 1.0)

    return Scenario(dynamic_feature=torch.tensor(delta), root_index=root)


def generate_scenario(graph: ServiceGraph, rng: random.Random) -> Scenario:
    root = rng.choice(graph.candidate_root_indices)
    factor = rng.uniform(FACTOR_LOW, FACTOR_HIGH)
    return inject_fault(graph, root, factor, rng)


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
