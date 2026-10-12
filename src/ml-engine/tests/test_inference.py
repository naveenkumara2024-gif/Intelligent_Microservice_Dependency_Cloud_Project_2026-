"""SageMaker handler contract: round trip, ranking semantics, and 4xx-style validation."""
import json

import pytest
import torch

import inference
from features import SnapshotError


@pytest.fixture
def bundle(tmp_path, random_state_dict):
    torch.save(random_state_dict, tmp_path / "model.pt")
    (tmp_path / "metadata.json").write_text(json.dumps({"model_version": "test123", "node_in_dim": 7, "improved": True}))
    return inference.model_fn(str(tmp_path))


def _call(bundle, payload, content_type="application/json"):
    body = json.dumps(payload) if not isinstance(payload, (str, bytes)) else payload
    return inference.predict_fn(inference.input_fn(body, content_type), bundle)


def test_round_trip(bundle, snapshot):
    out = _call(bundle, snapshot)
    body, content_type = inference.output_fn(out, "application/json")
    assert content_type == "application/json"
    parsed = json.loads(body)
    assert parsed["model_version"] == "test123"
    assert parsed["num_nodes"] == 12 and parsed["num_edges"] == 16
    assert [r["rank"] for r in parsed["ranking"]] == [1, 2, 3]
    assert abs(sum(parsed["scores"].values()) - 1.0) < 1e-5  # softmax over ALL nodes


def test_ranking_lists_only_nodes_that_are_called_and_is_sorted(bundle, snapshot):
    snapshot["top_k"] = 50
    out = _call(bundle, snapshot)
    called = {e["dm"] for e in snapshot["edges"]}
    names = [r["name"] for r in out["ranking"]]
    assert set(names) == called
    assert "loadgenerator" not in names  # nobody calls it, so it can never be the root cause
    scores = [r["score"] for r in out["ranking"]]
    assert scores == sorted(scores, reverse=True)


def test_deterministic_and_independent_of_input_order(bundle, snapshot):
    a = _call(bundle, snapshot)
    snapshot["nodes"].reverse()
    snapshot["edges"].reverse()
    b = _call(bundle, snapshot)
    assert [r["name"] for r in a["ranking"]] == [r["name"] for r in b["ranking"]]
    for name in a["scores"]:
        assert a["scores"][name] == pytest.approx(b["scores"][name], abs=1e-5)


def test_a_fault_changes_the_scores(bundle, snapshot):
    for n in snapshot["nodes"]:
        n["own_delta"] = 0.0
    quiet = _call(bundle, snapshot)["scores"]["paymentservice"]
    for n in snapshot["nodes"]:
        if n["name"] in ("paymentservice", "checkoutservice", "frontend"):
            n["own_delta"] = 6.0
    assert _call(bundle, snapshot)["scores"]["paymentservice"] != pytest.approx(quiet, abs=1e-6)


def test_default_top_k_is_five(bundle, snapshot):
    del snapshot["top_k"]
    assert len(_call(bundle, snapshot)["ranking"]) == 5


def _break_edge_field(field, value):
    return lambda s: s["edges"][0].update({field: value})


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda s: s.update(nodes=[]), "at least one node"),
        (lambda s: s.update(edges=[]), "at least one edge"),
        (_break_edge_field("rpctype", "grpc"), "rpctype"),
        (_break_edge_field("um", "ghost"), "not a node"),
        (lambda s: s["nodes"][0].update(own_delta=float("nan")), "finite"),
        (lambda s: s["nodes"][0].update(total_calls_as_um=-1), ">= 0"),
        (_break_edge_field("call_count", "many"), "number"),
        (lambda s: s["nodes"].append(dict(s["nodes"][0])), "duplicate"),
        (lambda s: s.update(top_k=0), "top_k"),
        (lambda s: s.update(top_k=True), "top_k"),
        (lambda s: s.update(top_k=999), "top_k"),
    ],
)
def test_invalid_snapshots_are_client_errors(bundle, snapshot, mutate, message):
    mutate(snapshot)
    with pytest.raises(SnapshotError, match=message):
        _call(bundle, snapshot)


@pytest.mark.parametrize("body", ["not json", "[]", "42", b"\xff\xfe"])
def test_malformed_bodies(bundle, body):
    with pytest.raises(SnapshotError):
        _call(bundle, body)


def test_wrong_content_type_and_accept(bundle, snapshot):
    with pytest.raises(SnapshotError, match="content type"):
        inference.input_fn(json.dumps(snapshot), "text/csv")
    with pytest.raises(SnapshotError, match="Accept"):
        inference.output_fn({"ranking": []}, "text/csv")


def test_snapshot_error_is_a_value_error():
    # the SageMaker toolkit maps ValueError to HTTP 400, anything else to 500
    assert issubclass(SnapshotError, ValueError)


def test_oversized_snapshot_is_rejected(bundle):
    nodes = [{"name": f"n{i}", "total_calls_as_um": 1, "total_calls_as_dm": 1, "own_delta": 0} for i in range(20_001)]
    edge = {"um": "n0", "dm": "n1", "avg_latency_ms": 1, "p95_latency_ms": 2, "call_count": 3, "rpctype": "rpc"}
    with pytest.raises(SnapshotError, match="too large"):
        _call(bundle, {"nodes": nodes, "edges": [edge]})


# --- container mode: the SageMaker toolkit only honours ITS OWN exception for the status code -------
# Verified against sagemaker_inference.transformer: a plain ValueError becomes a 500; only
# GenericInferenceToolkitError(status_code, message) sets the response status.

class FakeToolkitError(Exception):
    def __init__(self, status_code, message=None, phrase=None):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


@pytest.fixture
def container_mode(monkeypatch):
    monkeypatch.setattr(inference, "GenericInferenceToolkitError", FakeToolkitError)


def _status_of(fn, *args):
    with pytest.raises(FakeToolkitError) as info:
        fn(*args)
    return info.value.status_code, str(info.value.message)


def test_container_bad_json_is_400_with_a_useful_message(container_mode):
    status, message = _status_of(inference.input_fn, "not json", "application/json")
    assert status == 400 and "valid JSON" in message


def test_container_invalid_snapshot_is_400(container_mode, bundle):
    data = inference.input_fn(json.dumps({"nodes": [], "edges": []}), "application/json")
    status, message = _status_of(inference.predict_fn, data, bundle)
    assert status == 400 and "at least one node" in message


def test_container_bad_top_k_is_400(container_mode, snapshot):
    snapshot["top_k"] = 0
    status, _ = _status_of(inference.input_fn, json.dumps(snapshot), "application/json")
    assert status == 400


def test_container_wrong_content_type_is_415_and_accept_is_406(container_mode):
    assert _status_of(inference.input_fn, "{}", "text/csv")[0] == 415
    assert _status_of(inference.output_fn, {"ranking": []}, "text/csv")[0] == 406


def test_container_valid_request_is_unaffected(container_mode, bundle, snapshot):
    out = inference.predict_fn(inference.input_fn(json.dumps(snapshot), "application/json"), bundle)
    assert len(out["ranking"]) == 3


def test_container_server_side_bugs_stay_500s_not_400s(container_mode, bundle, snapshot):
    bundle.metadata["node_in_dim"] = 99  # model/feature mismatch is OUR bug, not the caller's
    data = inference.input_fn(json.dumps(snapshot), "application/json")
    with pytest.raises(RuntimeError, match="does not match the model"):
        inference.predict_fn(data, bundle)
