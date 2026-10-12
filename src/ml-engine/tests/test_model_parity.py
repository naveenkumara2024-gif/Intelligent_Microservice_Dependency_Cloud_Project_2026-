"""The plain-PyTorch model must agree with the PyG model on the same weights and graphs."""
import random

import pytest
import torch

import fault_injection
from conftest import REAL_WEIGHTS
from evaluate_boutique import graph_from_topology
from features import build_features
from model import RootCauseGNN
from model_pure import PureRootCauseGNN

ATOL = 1e-5


def _compare(state, x, edge_index, edge_attr):
    pyg = RootCauseGNN(node_in_dim=7, edge_dim=9, hidden_dim=64, improved=True, dynamic_dim=3)
    pyg.load_state_dict(state)
    pyg.eval()
    pure = PureRootCauseGNN.from_state_dict(state)
    with torch.no_grad():
        want = pyg(x, edge_index, edge_attr)
    got = pure(x, edge_index, edge_attr)
    assert got.shape == want.shape
    assert torch.allclose(got, want, atol=ATOL, rtol=0), (got - want).abs().max().item()


def test_boutique_scenarios(random_state_dict, boutique):
    graph = graph_from_topology(boutique)
    rng = random.Random(5)
    for _ in range(10):
        sc = fault_injection.generate_scenario(graph, rng)
        d = graph.to_data(sc.dynamic_feature)
        _compare(random_state_dict, d.x, d.edge_index, d.edge_attr)


def test_graph_with_self_loops_multi_edges_and_a_node_nobody_calls(random_state_dict):
    # c has no incoming edge; a->a is a self-loop; a->b appears twice with different attributes
    nodes = [
        {"name": n, "total_calls_as_um": i + 1, "total_calls_as_dm": 5 - i, "own_delta": 0.3 * i}
        for i, n in enumerate("abcd")
    ]

    def edge(um, dm, c, kind="rpc"):
        return {"um": um, "dm": dm, "avg_latency_ms": c / 3, "p95_latency_ms": c, "call_count": c * 100, "rpctype": kind}

    edges = [edge("a", "a", 4), edge("a", "b", 7), edge("a", "b", 2, "db"), edge("c", "b", 9), edge("b", "d", 1, "mq")]
    f = build_features(nodes, edges)
    _compare(random_state_dict, f.x, f.edge_index, f.edge_attr)


def test_bigger_random_graph(random_state_dict):
    rng = random.Random(21)
    n = 300
    nodes = [
        {"name": f"n{i:03d}", "total_calls_as_um": rng.random() * 1e6, "total_calls_as_dm": rng.random() * 1e6,
         "own_delta": rng.random()}
        for i in range(n)
    ]
    kinds = ["rpc", "db", "mc", "http", "mq", "userDefined"]
    edges = [
        {"um": f"n{rng.randrange(n):03d}", "dm": f"n{rng.randrange(n):03d}", "avg_latency_ms": rng.random() * 50,
         "p95_latency_ms": rng.random() * 200, "call_count": rng.randrange(1, 10**6), "rpctype": rng.choice(kinds)}
        for _ in range(900)
    ]
    f = build_features(nodes, edges)
    _compare(random_state_dict, f.x, f.edge_index, f.edge_attr)


@pytest.mark.skipif(not REAL_WEIGHTS.exists(), reason="trained model.pt is gitignored; only on the training workstation")
def test_real_weights_on_boutique(boutique):
    state = torch.load(REAL_WEIGHTS, map_location="cpu")
    graph = graph_from_topology(boutique)
    sc = fault_injection.generate_scenario(graph, random.Random(8))
    d = graph.to_data(sc.dynamic_feature)
    _compare(state, d.x, d.edge_index, d.edge_attr)
