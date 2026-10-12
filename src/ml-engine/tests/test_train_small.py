import random

import pytest

import fault_injection
from evaluate_boutique import graph_from_topology
from train_small import SmallGraph, make_scenarios, random_microservice


def test_small_graph_matches_service_graph_fault_attributes(boutique):
    real = graph_from_topology(boutique)
    small = SmallGraph(boutique["nodes"], boutique["edges"])
    assert small.service_names == real.service_names
    assert small.candidate_root_indices == real.candidate_root_indices
    assert small.num_nodes == real.num_nodes
    for callee, callers in real.reverse_weight.items():
        for caller, weight in callers.items():
            assert small.reverse_weight[callee][caller] == pytest.approx(weight, rel=1e-9)


def test_random_topologies_are_valid_and_deterministic():
    a = random_microservice(random.Random(1))
    b = random_microservice(random.Random(1))
    assert a == b
    names = {n["name"] for n in a["nodes"]}
    assert 8 <= len(names) <= 30
    for e in a["edges"]:
        assert e["um"] in names and e["dm"] in names and e["um"] != e["dm"]
    assert len(SmallGraph(a["nodes"], a["edges"]).candidate_root_indices) >= 1


def test_scenarios_have_a_real_root_and_restore_the_distractor_setting():
    saved = fault_injection.N_DISTRACTORS_RANGE
    topologies = [random_microservice(random.Random(i)) for i in range(5)]
    scenarios = make_scenarios(topologies, 3, random.Random(0))
    assert len(scenarios) == 15
    for topo, root, delta in scenarios:
        names = {n["name"] for n in topo["nodes"]}
        assert root in names and len(delta) == len(names)
        assert max(delta) > 0
    assert fault_injection.N_DISTRACTORS_RANGE == saved
