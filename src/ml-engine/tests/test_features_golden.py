"""features.build_features must reproduce graph_dataset.ServiceGraph exactly (train/serve skew guard)."""
import random

import pandas as pd
import pytest
import torch

import fault_injection
from conftest import PROCESSED
from evaluate_boutique import graph_from_topology
from features import DELTA_SCALE, build_features
from graph_dataset import ServiceGraph


def _assert_same(graph, own_scaled, nodes, edges):
    expected = graph.to_data(own_scaled)
    got = build_features(nodes, edges)
    assert got.names == graph.service_names
    assert torch.equal(got.edge_index, expected.edge_index)
    # static features and edge attributes: identical arithmetic, so equal up to float32 rounding
    assert torch.allclose(got.x[:, :4], expected.x[:, :4], atol=1e-6, rtol=0)
    assert torch.allclose(got.edge_attr, expected.edge_attr, atol=1e-6, rtol=0)
    # dynamic features go through (d * 9) / 9, log1p and scatter reductions
    assert torch.allclose(got.x[:, 4:], expected.x[:, 4:], atol=1e-5, rtol=0)
    assert got.candidate_indices == graph.candidate_root_indices


def test_boutique_matches_service_graph(boutique):
    graph = graph_from_topology(boutique)
    rng = random.Random(3)
    names = sorted(n["name"] for n in boutique["nodes"])
    by_name = {n["name"]: n for n in boutique["nodes"]}
    for _ in range(5):
        sc = fault_injection.generate_scenario(graph, rng)
        delta = (sc.dynamic_feature * DELTA_SCALE).tolist()
        nodes = [{**by_name[n], "own_delta": delta[i]} for i, n in enumerate(names)]
        _assert_same(graph, sc.dynamic_feature, nodes, boutique["edges"])


@pytest.mark.skipif(not (PROCESSED / "edges.csv").exists(), reason="Stage 1 CSVs not generated")
def test_full_alibaba_graph_matches_service_graph():
    graph = ServiceGraph()  # 7,384 nodes, 16,115 edges, self-loops included
    sc = fault_injection.generate_scenario(graph, random.Random(11))
    nodes_df = pd.read_csv(PROCESSED / "nodes.csv")
    edges_df = pd.read_csv(PROCESSED / "edges.csv")
    by = nodes_df.set_index("service_name")
    delta = (sc.dynamic_feature * DELTA_SCALE).tolist()
    nodes = [
        {
            "name": n,
            "total_calls_as_um": float(by.loc[n, "total_calls_as_um"]),
            "total_calls_as_dm": float(by.loc[n, "total_calls_as_dm"]),
            "own_delta": delta[i],
        }
        for i, n in enumerate(sorted(nodes_df["service_name"]))
    ]
    _assert_same(graph, sc.dynamic_feature, nodes, edges_df.to_dict("records"))
