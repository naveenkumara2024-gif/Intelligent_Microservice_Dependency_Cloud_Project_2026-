"""
RootCauseGNN in plain PyTorch, for the SageMaker container.

``model.RootCauseGNN`` is built from torch_geometric's GATv2Conv and SAGEConv. Serving it would mean
installing PyG (and matching it to the container's torch and Python) at cold start. The two layers
are small, so this module re-implements exactly what the model uses of them and loads the SAME
state dict, with no torch_geometric import.

It is only trustworthy because ``tests/test_model_parity.py`` checks it against the PyG model on the
same weights and graphs (agreement to ~1e-6). Keep that test green when touching this file.

Math (the PyG 2.x implementation, heads=1, concat=True, add_self_loops=False; edges go j -> i):
  GATv2:  e_ji = leaky_relu(lin_r(x_i) + lin_l(x_j) + lin_edge(a_ji), 0.2)
          alpha_ji = softmax over the edges entering i of  att . e_ji
          out_i = sum_j alpha_ji * lin_l(x_j) + bias
  SAGE:   out_i = lin_l(mean_{j -> i} x_j) + lin_r(x_i)        (mean = 0 with no incoming edges)
"""

from __future__ import annotations

import torch
import torch.nn.functional as F
from torch import nn


def _segment_softmax(score: torch.Tensor, index: torch.Tensor, num_nodes: int) -> torch.Tensor:
    """Softmax of ``score`` [E] within each group of equal ``index`` (PyG's softmax, incl. its 1e-16)."""
    top = torch.full((num_nodes,), float("-inf"), dtype=score.dtype)
    top = top.scatter_reduce(0, index, score, reduce="amax", include_self=True)
    exp = (score - top[index]).exp()
    total = torch.zeros(num_nodes, dtype=score.dtype).index_add_(0, index, exp)
    return exp / (total[index] + 1e-16)


class GATv2Layer(nn.Module):
    def __init__(self, in_dim: int, out_dim: int, edge_dim: int, negative_slope: float = 0.2):
        super().__init__()
        self.lin_l = nn.Linear(in_dim, out_dim)
        self.lin_r = nn.Linear(in_dim, out_dim)
        self.lin_edge = nn.Linear(edge_dim, out_dim, bias=False)
        self.att = nn.Parameter(torch.empty(1, 1, out_dim))  # PyG stores [1, heads, channels]
        self.bias = nn.Parameter(torch.zeros(out_dim))
        self.negative_slope = negative_slope

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor, edge_attr: torch.Tensor) -> torch.Tensor:
        src, dst = edge_index
        x_l, x_r = self.lin_l(x), self.lin_r(x)
        e = F.leaky_relu(x_r[dst] + x_l[src] + self.lin_edge(edge_attr), self.negative_slope)
        alpha = _segment_softmax((e * self.att.view(1, -1)).sum(-1), dst, x.shape[0])
        out = torch.zeros_like(x_l).index_add_(0, dst, x_l[src] * alpha.unsqueeze(-1))
        return out + self.bias


class SAGELayer(nn.Module):
    def __init__(self, in_dim: int, out_dim: int):
        super().__init__()
        self.lin_l = nn.Linear(in_dim, out_dim)
        self.lin_r = nn.Linear(in_dim, out_dim, bias=False)

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor) -> torch.Tensor:
        src, dst = edge_index
        total = torch.zeros_like(x).index_add_(0, dst, x[src])
        count = torch.zeros(x.shape[0], dtype=x.dtype).index_add_(0, dst, torch.ones(dst.shape[0], dtype=x.dtype))
        mean = total / count.clamp(min=1.0).unsqueeze(-1)
        return self.lin_l(mean) + self.lin_r(x)


class PureRootCauseGNN(nn.Module):
    """Same parameter names and shapes as ``model.RootCauseGNN``, so its state dict loads directly."""

    def __init__(self, node_in_dim: int, edge_dim: int, hidden_dim: int = 64, improved: bool = True,
                 dynamic_dim: int = 3):
        super().__init__()
        self.edge_embed = GATv2Layer(node_in_dim, hidden_dim, edge_dim)
        self.conv1 = SAGELayer(hidden_dim, hidden_dim)
        self.conv2 = SAGELayer(hidden_dim, hidden_dim)
        self.conv3 = SAGELayer(hidden_dim, hidden_dim)
        self.out = nn.Linear(hidden_dim, 1)
        self.improved = improved
        self.dynamic_dim = dynamic_dim
        if improved:
            self.norms = nn.ModuleList([nn.LayerNorm(hidden_dim) for _ in range(4)])
            self.skip = nn.Linear(dynamic_dim, 1)

    def _block(self, h: torch.Tensor, i: int) -> torch.Tensor:
        if self.improved:
            return F.leaky_relu(self.norms[i](h), negative_slope=0.1)
        return F.relu(h)

    @torch.no_grad()
    def forward(self, x: torch.Tensor, edge_index: torch.Tensor, edge_attr: torch.Tensor) -> torch.Tensor:
        h = self._block(self.edge_embed(x, edge_index, edge_attr), 0)
        h = self._block(self.conv1(h, edge_index), 1)
        h = self._block(self.conv2(h, edge_index), 2)
        h = self._block(self.conv3(h, edge_index), 3)
        logits = self.out(h).squeeze(-1)
        if self.improved:
            logits = logits + self.skip(x[:, -self.dynamic_dim:]).squeeze(-1)
        return logits

    @classmethod
    def from_state_dict(cls, state: dict, *, improved: bool = True) -> "PureRootCauseGNN":
        """Infers the sizes from the weights, so a retrained model of another width loads too."""
        node_in = state["edge_embed.lin_l.weight"].shape[1]
        hidden = state["edge_embed.lin_l.weight"].shape[0]
        edge_dim = state["edge_embed.lin_edge.weight"].shape[1]
        dynamic = state["skip.weight"].shape[1] if "skip.weight" in state else 3
        model = cls(node_in, edge_dim, hidden_dim=hidden, improved=improved, dynamic_dim=dynamic)
        model.load_state_dict(state, strict=True)
        model.eval()
        return model
