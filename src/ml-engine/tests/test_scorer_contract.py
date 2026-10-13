"""The scorer Lambda's request (a golden file written by src/lambda-transformer's Jest suite) must be
accepted by this container's handlers. Fails here if either side drifts: field names, rpctype,
top_k, non-finite numbers."""
import json
from pathlib import Path

import pytest
import torch

import inference

GOLDEN = Path(__file__).resolve().parents[2] / "lambda-transformer" / "test" / "fixtures" / "scorer-request.json"


@pytest.fixture
def bundle(tmp_path, random_state_dict):
    torch.save(random_state_dict, tmp_path / "model.pt")
    (tmp_path / "metadata.json").write_text(json.dumps({"model_version": "contract", "node_in_dim": 7, "improved": True}))
    return inference.model_fn(str(tmp_path))


@pytest.fixture
def golden() -> dict:
    assert GOLDEN.exists(), "run `UPDATE_GOLDEN=1 npx jest test/scorer-contract` in src/lambda-transformer"
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def test_golden_request_is_accepted_and_scored(bundle, golden):
    out = inference.predict_fn(inference.input_fn(json.dumps(golden), "application/json"), bundle)
    assert out["num_nodes"] == len(golden["nodes"])
    assert out["num_edges"] == len(golden["edges"])
    assert len(out["ranking"]) == golden["top_k"]
    names = {n["name"] for n in golden["nodes"]}
    assert {r["name"] for r in out["ranking"]} <= names


def test_golden_request_matches_the_boutique_fixture_topology(golden, boutique):
    """The scorer's scenario is built from the same fixture the model was evaluated on."""
    assert {n["name"] for n in golden["nodes"]} == {n["name"] for n in boutique["nodes"]}
    assert {(e["um"], e["dm"]) for e in golden["edges"]} == {(e["um"], e["dm"]) for e in boutique["edges"]}


def test_golden_request_has_exactly_the_documented_fields(golden):
    assert set(golden) == {"nodes", "edges", "top_k"}
    assert all(set(n) == {"name", "total_calls_as_um", "total_calls_as_dm", "own_delta"} for n in golden["nodes"])
    assert all(
        set(e) == {"um", "dm", "avg_latency_ms", "p95_latency_ms", "call_count", "rpctype"} for e in golden["edges"]
    )
