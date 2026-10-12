import importlib.util
import json
import sys
import tarfile

import pytest
import torch

import build_artifact

GATE_OK = {"gate": {"met": True, "top1_min": 0.6, "top3_min": 0.9}, "proportional": {"top1": 0.7}, "faithful": {}}


@pytest.fixture
def weights(tmp_path, random_state_dict):
    path = tmp_path / "w.pt"
    torch.save(random_state_dict, path)
    return path


def _eval(tmp_path, weights, **overrides):
    data = {**GATE_OK, "weights_sha256": build_artifact.sha256(weights), **overrides}
    path = tmp_path / "eval.json"
    path.write_text(json.dumps(data))
    return path


def test_layout_and_metadata(tmp_path, weights):
    out = build_artifact.build(weights, _eval(tmp_path, weights), tmp_path / "m.tar.gz")
    with tarfile.open(out) as tar:
        assert sorted(tar.getnames()) == [
            "code/features.py", "code/inference.py", "code/model_pure.py", "metadata.json", "model.pt",
        ]
        meta = json.load(tar.extractfile("metadata.json"))
    assert meta["node_in_dim"] == 7 and meta["edge_dim"] == 9 and meta["hidden_dim"] == 64
    assert meta["model_version"] == build_artifact.sha256(weights)[:12]
    assert meta["boutique_gate"]["met"] is True and meta["boutique_gate"]["bypassed"] is False
    assert "SYNTHETIC" in meta["labels"]


def test_reproducible_bytes(tmp_path, weights):
    ev = _eval(tmp_path, weights)
    a = build_artifact.build(weights, ev, tmp_path / "a.tar.gz").read_bytes()
    b = build_artifact.build(weights, ev, tmp_path / "b.tar.gz").read_bytes()
    assert a == b


def test_refuses_without_evaluation(tmp_path, weights):
    with pytest.raises(SystemExit, match="no gate evaluation"):
        build_artifact.build(weights, tmp_path / "missing.json", tmp_path / "m.tar.gz")


def test_refuses_stale_evaluation(tmp_path, weights):
    ev = _eval(tmp_path, weights, weights_sha256="0" * 64)
    with pytest.raises(SystemExit, match="different weights"):
        build_artifact.build(weights, ev, tmp_path / "m.tar.gz")


def test_refuses_failing_gate_unless_explicitly_bypassed(tmp_path, weights):
    ev = _eval(tmp_path, weights, gate={"met": False, "top1_min": 0.6, "top3_min": 0.9})
    with pytest.raises(SystemExit, match="NOT met"):
        build_artifact.build(weights, ev, tmp_path / "m.tar.gz")
    out = build_artifact.build(weights, ev, tmp_path / "m.tar.gz", allow_failing_gate=True)
    with tarfile.open(out) as tar:
        meta = json.load(tar.extractfile("metadata.json"))
    assert meta["boutique_gate"]["met"] is False and meta["boutique_gate"]["bypassed"] is True


def test_packaged_artifact_serves_requests(tmp_path, weights, snapshot):
    """Unpack the tarball as the container would and run a request through code/inference.py."""
    out = build_artifact.build(weights, _eval(tmp_path, weights), tmp_path / "m.tar.gz")
    model_dir = tmp_path / "model"
    with tarfile.open(out) as tar:
        tar.extractall(model_dir)
    code = model_dir / "code"
    names = ("inference", "features", "model_pure")
    saved = {k: sys.modules.pop(k) for k in names if k in sys.modules}
    sys.path.insert(0, str(code))
    try:
        spec = importlib.util.spec_from_file_location("inference", code / "inference.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        assert module.__file__.startswith(str(code))
        bundle = module.model_fn(str(model_dir))
        result = module.predict_fn(module.input_fn(json.dumps(snapshot)), bundle)
        assert len(result["ranking"]) == 3
    finally:
        sys.path.remove(str(code))
        for k in names:
            sys.modules.pop(k, None)
        sys.modules.update(saved)
