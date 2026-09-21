"""
Loads the Stage 1/2 service dependency graph (dataset/processed/nodes.csv,
edges.csv) into a fixed PyTorch Geometric topology reused by every synthetic
fault-injection scenario in Stage 3.
"""

from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch_geometric.data import Data

PROCESSED_DIR = Path(__file__).parent.parent.parent / "Dataset" / "processed"

RPCTYPES = ["rpc", "db", "mc", "http", "mq", "userDefined"]


def _minmax(x: np.ndarray) -> np.ndarray:
    lo, hi = x.min(), x.max()
    if hi - lo < 1e-9:
        return np.zeros_like(x)
    return (x - lo) / (hi - lo)


class ServiceGraph:
    """Fixed topology + static features, shared across all synthetic scenarios."""

    def __init__(self, nodes_path: Path = None, edges_path: Path = None, device: str = "cpu"):
        self.device = device
        nodes_path = nodes_path or PROCESSED_DIR / "nodes.csv"
        edges_path = edges_path or PROCESSED_DIR / "edges.csv"

        nodes_df = pd.read_csv(nodes_path).sort_values("service_name").reset_index(drop=True)
        edges_df = pd.read_csv(edges_path)

        self.service_names = nodes_df["service_name"].tolist()
        self.name_to_idx = {name: i for i, name in enumerate(self.service_names)}
        self.num_nodes = len(self.service_names)

        um_idx = edges_df["um"].map(self.name_to_idx).to_numpy()
        dm_idx = edges_df["dm"].map(self.name_to_idx).to_numpy()

        in_degree = np.zeros(self.num_nodes, dtype=np.float32)
        out_degree = np.zeros(self.num_nodes, dtype=np.float32)
        np.add.at(out_degree, um_idx, 1)
        np.add.at(in_degree, dm_idx, 1)

        static = np.stack(
            [
                _minmax(nodes_df["total_calls_as_um"].to_numpy(dtype=np.float32)),
                _minmax(nodes_df["total_calls_as_dm"].to_numpy(dtype=np.float32)),
                _minmax(in_degree),
                _minmax(out_degree),
            ],
            axis=1,
        )
        self.static_features = torch.tensor(static, dtype=torch.float32).to(device)  # [N, 4]

        self.edge_index = torch.tensor(np.stack([um_idx, dm_idx]), dtype=torch.long).to(device)  # [2, E]

        rpctype_onehot = pd.get_dummies(edges_df["rpctype"]).reindex(columns=RPCTYPES, fill_value=0)
        edge_attr = np.concatenate(
            [
                _minmax(edges_df["avg_latency_ms"].to_numpy(dtype=np.float32)).reshape(-1, 1),
                _minmax(edges_df["p95_latency_ms"].to_numpy(dtype=np.float32)).reshape(-1, 1),
                _minmax(np.log1p(edges_df["call_count"].to_numpy(dtype=np.float32))).reshape(-1, 1),
                rpctype_onehot.to_numpy(dtype=np.float32),
            ],
            axis=1,
        )
        self.edge_attr = torch.tensor(edge_attr, dtype=torch.float32).to(device)  # [E, 9]

        # Reverse adjacency (callee -> set of callers) for fault-propagation
        # BFS, excluding self-loops (um == dm) since they aren't a real hop
        # to a *different* node.
        self.reverse_adj: dict[int, set[int]] = {}
        for u, d in zip(um_idx.tolist(), dm_idx.tolist()):
            if u == d:
                continue
            self.reverse_adj.setdefault(d, set()).add(u)

        # Per-node baseline latency, used to scale injected latency deltas.
        # A node's "baseline" is the average avg_latency_ms across edges
        # where it appears as um (the latency it experiences making calls);
        # nodes that never call anyone fall back to the global mean.
        um_latency = edges_df.groupby("um")["avg_latency_ms"].mean()
        global_mean = edges_df["avg_latency_ms"].mean()
        baseline = np.full(self.num_nodes, global_mean, dtype=np.float32)
        for name, val in um_latency.items():
            baseline[self.name_to_idx[name]] = val
        self.baseline_latency = baseline

        # Candidate root-cause nodes: must have >=1 incoming call (someone
        # has to notice they're slow).
        self.candidate_root_indices = sorted(set(dm_idx.tolist()))

    def to_data(self, dynamic_feature: torch.Tensor) -> Data:
        """dynamic_feature: [N] tensor -> full [N, 5] node feature Data object."""
        dynamic_feature = dynamic_feature.to(self.device)
        x = torch.cat([self.static_features, dynamic_feature.view(-1, 1)], dim=1)
        return Data(x=x, edge_index=self.edge_index, edge_attr=self.edge_attr)


if __name__ == "__main__":
    g = ServiceGraph()
    print(f"nodes: {g.num_nodes}, edges: {g.edge_index.shape[1]}")
    print(f"candidate root-cause nodes: {len(g.candidate_root_indices)}")
    print(f"static feature shape: {g.static_features.shape}")
    print(f"edge_attr shape: {g.edge_attr.shape}")
