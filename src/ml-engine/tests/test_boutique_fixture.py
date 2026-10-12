import json

import derive_boutique_topology as derive
from conftest import FIXTURE


def test_committed_fixture_is_not_stale():
    assert json.loads(FIXTURE.read_text(encoding="utf-8")) == derive.derive()


def test_topology_is_what_the_manifest_configures(boutique):
    pairs = {(e["um"], e["dm"]) for e in boutique["edges"]}
    names = {n["name"] for n in boutique["nodes"]}
    assert len(names) == 12
    assert ("frontend", "checkoutservice") in pairs
    assert ("checkoutservice", "paymentservice") in pairs
    assert ("cartservice", "redis-cart") in pairs
    # configured in the manifest but not deployed there -> not a node
    assert not any("shoppingassistant" in n for n in names)
    # telemetry export is not a business call
    assert not any("collector" in dm for _, dm in pairs)


def test_provenance_is_declared(boutique):
    assert "SYNTHETIC" in boutique["_provenance"]["volumes_and_latencies"]


def test_node_counters_are_consistent_with_edges(boutique):
    out = {n["name"]: 0 for n in boutique["nodes"]}
    inc = dict(out)
    for e in boutique["edges"]:
        out[e["um"]] += e["call_count"]
        inc[e["dm"]] += e["call_count"]
    for n in boutique["nodes"]:
        assert n["total_calls_as_um"] == out[n["name"]]
        assert n["total_calls_as_dm"] == inc[n["name"]]
