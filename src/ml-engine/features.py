"""
Snapshot -> model inputs, with no pandas / PyG / filesystem dependency, so it can run inside
the SageMaker inference container.

This is the serving-side twin of ``graph_dataset.ServiceGraph.to_data``. The two MUST produce the
same tensors for the same graph; ``tests/test_features_golden.py`` asserts that on the real Alibaba
CSVs, so training/serving skew cannot hide. If you change feature engineering, change both and the
test will tell you if they drifted.

Input (a graph snapshot, JSON-like):
    nodes: [{"name", "total_calls_as_um", "total_calls_as_dm", "own_delta"}]
    edges: [{"um", "dm", "avg_latency_ms", "p95_latency_ms", "call_count", "rpctype"}]

``own_delta`` is a service's relative latency deviation, observed / normal - 1 (0 = normal, 2 = three
times slower). Negative values (faster than normal) are clipped to 0: the model only ever saw
slow-downs. Deriving it from live counters needs a per-service baseline and is the caller's job.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import torch

# Same order as graph_dataset.RPCTYPES (the one-hot column order the model was trained with).
RPCTYPES = ["rpc", "db", "mc", "http", "mq", "userDefined"]

# fault_injection.FACTOR_HIGH - 1: training scaled the deviation by this fixed constant.
DELTA_SCALE = 9.0
# graph_dataset.LOG_SCALE_K
LOG_SCALE_K = 1000.0

STATIC_DIM = 4
DYNAMIC_DIM = 3
NODE_DIM = STATIC_DIM + DYNAMIC_DIM
EDGE_DIM = 3 + len(RPCTYPES)

MAX_NODES = 20_000
MAX_EDGES = 100_000


class SnapshotError(ValueError):
    """The request is not a valid graph snapshot. A ValueError, so the SageMaker toolkit returns 4xx."""


@dataclass
class Features:
    names: list[str]
    x: torch.Tensor  # [N, 7]
    edge_index: torch.Tensor  # [2, E] (row 0 = caller/um, row 1 = callee/dm)
    edge_attr: torch.Tensor  # [E, 9]
    candidate_indices: list[int]  # nodes with >= 1 incoming call: the only possible roots


def _minmax(x: torch.Tensor) -> torch.Tensor:
    lo, hi = x.min(), x.max()
    if (hi - lo) < 1e-9:
        return torch.zeros_like(x)
    return (x - lo) / (hi - lo)


def _number(value, what: str, *, minimum: float | None = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SnapshotError(f"{what} must be a number, got {value!r}")
    if not math.isfinite(value):
        raise SnapshotError(f"{what} must be finite, got {value!r}")
    if minimum is not None and value < minimum:
        raise SnapshotError(f"{what} must be >= {minimum}, got {value!r}")
    return float(value)


def build_features(nodes: list[dict], edges: list[dict]) -> Features:
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise SnapshotError("'nodes' and 'edges' must be lists")
    if not nodes:
        raise SnapshotError("at least one node is required")
    if not edges:
        raise SnapshotError("at least one edge is required (the model scores a call graph)")
    if len(nodes) > MAX_NODES or len(edges) > MAX_EDGES:
        raise SnapshotError(f"snapshot too large: {len(nodes)} nodes / {len(edges)} edges (max {MAX_NODES} / {MAX_EDGES})")

    # Same node order as ServiceGraph: sorted by name.
    seen: set[str] = set()
    for i, n in enumerate(nodes):
        if not isinstance(n, dict):
            raise SnapshotError(f"nodes[{i}] must be an object")
        name = n.get("name")
        if not isinstance(name, str) or not name:
            raise SnapshotError(f"nodes[{i}].name must be a non-empty string")
        if name in seen:
            raise SnapshotError(f"duplicate node name {name!r}")
        seen.add(name)
    ordered = sorted(nodes, key=lambda n: n["name"])
    names = [n["name"] for n in ordered]
    index = {name: i for i, name in enumerate(names)}
    num_nodes = len(names)

    calls_um = torch.tensor([_number(n.get("total_calls_as_um"), f"node {n['name']!r} total_calls_as_um") for n in ordered], dtype=torch.float32)
    calls_dm = torch.tensor([_number(n.get("total_calls_as_dm"), f"node {n['name']!r} total_calls_as_dm") for n in ordered], dtype=torch.float32)
    # Negative deviations are clipped (see module docstring); non-finite values are rejected.
    own = torch.tensor(
        [max(0.0, _number(n.get("own_delta", 0.0), f"node {n['name']!r} own_delta", minimum=None)) for n in ordered],
        dtype=torch.float32,
    )

    um_idx, dm_idx, avg, p95, calls, kinds = [], [], [], [], [], []
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            raise SnapshotError(f"edges[{i}] must be an object")
        for end in ("um", "dm"):
            if e.get(end) not in index:
                raise SnapshotError(f"edges[{i}].{end} {e.get(end)!r} is not a node in this snapshot")
        kind = e.get("rpctype")
        if kind not in RPCTYPES:
            raise SnapshotError(f"edges[{i}].rpctype {kind!r} is not one of {RPCTYPES}")
        um_idx.append(index[e["um"]])
        dm_idx.append(index[e["dm"]])
        avg.append(_number(e.get("avg_latency_ms"), f"edges[{i}].avg_latency_ms"))
        p95.append(_number(e.get("p95_latency_ms"), f"edges[{i}].p95_latency_ms"))
        calls.append(_number(e.get("call_count"), f"edges[{i}].call_count"))
        kinds.append(RPCTYPES.index(kind))

    um = torch.tensor(um_idx, dtype=torch.long)
    dm = torch.tensor(dm_idx, dtype=torch.long)

    in_degree = torch.zeros(num_nodes, dtype=torch.float32).index_add_(0, dm, torch.ones(len(dm_idx)))
    out_degree = torch.zeros(num_nodes, dtype=torch.float32).index_add_(0, um, torch.ones(len(um_idx)))
    static = torch.stack([_minmax(calls_um), _minmax(calls_dm), _minmax(in_degree), _minmax(out_degree)], dim=1)

    onehot = torch.zeros(len(kinds), len(RPCTYPES), dtype=torch.float32)
    onehot[torch.arange(len(kinds)), torch.tensor(kinds, dtype=torch.long)] = 1.0
    edge_attr = torch.cat(
        [
            _minmax(torch.tensor(avg, dtype=torch.float32)).reshape(-1, 1),
            _minmax(torch.tensor(p95, dtype=torch.float32)).reshape(-1, 1),
            _minmax(torch.log1p(torch.tensor(calls, dtype=torch.float32))).reshape(-1, 1),
            onehot,
        ],
        dim=1,
    )

    # Dynamic features, exactly as ServiceGraph.to_data: own deviation (scaled by the training-time
    # constant), plus max and mean over direct callees, over non-self-loop edges only.
    own = own / DELTA_SCALE
    nonloop = um != dm
    src, dst = um[nonloop], dm[nonloop]
    cols = [own]
    downstream = own[dst]
    for reduce in ("amax", "mean"):
        agg = torch.zeros_like(own)
        agg.scatter_reduce_(0, src, downstream, reduce=reduce, include_self=False)
        cols.append(agg)
    dynamic = torch.log1p(torch.stack(cols, dim=1) * LOG_SCALE_K) / math.log1p(LOG_SCALE_K)

    return Features(
        names=names,
        x=torch.cat([static, dynamic], dim=1),
        edge_index=torch.stack([um, dm]),
        edge_attr=edge_attr,
        candidate_indices=sorted(set(dm_idx)),
    )
