"""
GraphSAGE-based root-cause scoring model.

Not a novel architecture by design (see prompt/stage-03-gnn-training.md /
CLAUDE.md novelty framing): a standard GNN is sufficient, the project's
contribution is the streaming system around it, not the model itself.
"""

import torch
import torch.nn.functional as F
from torch_geometric.nn import GATv2Conv, SAGEConv


class RootCauseGNN(torch.nn.Module):
    def __init__(self, node_in_dim: int, edge_dim: int, hidden_dim: int = 64, dropout: float = 0.2):
        super().__init__()
        self.edge_embed = GATv2Conv(node_in_dim, hidden_dim, edge_dim=edge_dim, add_self_loops=False)
        self.conv1 = SAGEConv(hidden_dim, hidden_dim)
        self.conv2 = SAGEConv(hidden_dim, hidden_dim)
        self.conv3 = SAGEConv(hidden_dim, hidden_dim)
        self.out = torch.nn.Linear(hidden_dim, 1)
        self.dropout = dropout

    def forward(self, x, edge_index, edge_attr):
        h = F.relu(self.edge_embed(x, edge_index, edge_attr))
        h = F.dropout(h, p=self.dropout, training=self.training)
        h = F.relu(self.conv1(h, edge_index))
        h = F.dropout(h, p=self.dropout, training=self.training)
        h = F.relu(self.conv2(h, edge_index))
        h = F.dropout(h, p=self.dropout, training=self.training)
        h = F.relu(self.conv3(h, edge_index))
        logits = self.out(h).squeeze(-1)  # [N]
        return logits


if __name__ == "__main__":
    from graph_dataset import ServiceGraph
    import fault_injection
    import random

    graph = ServiceGraph()
    scenario = fault_injection.generate_scenario(graph, random.Random(0))
    data = graph.to_data(scenario.dynamic_feature)

    model = RootCauseGNN(node_in_dim=data.x.shape[1], edge_dim=data.edge_attr.shape[1])
    logits = model(data.x, data.edge_index, data.edge_attr)
    print("logits shape:", logits.shape)
    log_probs = F.log_softmax(logits, dim=0)
    print("log_probs sum(exp):", log_probs.exp().sum().item())
    print("true root index:", scenario.root_index, "predicted argmax:", logits.argmax().item())
