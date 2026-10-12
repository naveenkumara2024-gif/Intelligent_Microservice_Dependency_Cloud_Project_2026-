"""
SageMaker inference handlers (PyTorch container contract): model_fn, input_fn, predict_fn, output_fn.

Request  (application/json):
    {"nodes": [{"name", "total_calls_as_um", "total_calls_as_dm", "own_delta"}],
     "edges": [{"um", "dm", "avg_latency_ms", "p95_latency_ms", "call_count", "rpctype"}],
     "top_k": 5}                                       # optional, default 5

Response (application/json):
    {"model_version", "num_nodes", "num_edges",
     "ranking": [{"rank", "name", "score"}],           # top_k candidate roots, best first
     "scores":  {"<name>": probability}}               # every node

``score`` is the softmax over ALL nodes of the model's logits, which is exactly what the model was
trained to output (train.py / predict.py). ``ranking`` only lists nodes with at least one incoming
call, because a service nobody calls cannot be noticed as the root cause.

Bad input raises ``features.SnapshotError`` (a ValueError). The SageMaker inference toolkit does NOT
map a plain ValueError to a 4xx: every exception that is not one of its own becomes a 500. So inside
the container the handlers re-raise it as ``sagemaker_inference.errors.GenericInferenceToolkitError``
with an explicit status (400 bad snapshot, 415 content type, 406 Accept). Off the container (tests,
score_local.py) that package is absent and the SnapshotError propagates unchanged. Anything else is a
bug and stays a 500.
"""

from __future__ import annotations

import json
import os

import torch

from features import SnapshotError, build_features
from model_pure import PureRootCauseGNN

try:  # only present inside the SageMaker inference container
    from sagemaker_inference.errors import GenericInferenceToolkitError
except ImportError:  # pragma: no cover - exercised by tests through monkeypatching
    GenericInferenceToolkitError = None

DEFAULT_TOP_K = 5
MAX_TOP_K = 50
CONTENT_TYPE = "application/json"


def _as_client_error(error: SnapshotError, status: int = 400) -> Exception:
    """The exception to raise for a bad request: carries ``status`` in the container, else as-is."""
    if GenericInferenceToolkitError is not None:
        return GenericInferenceToolkitError(status, str(error))
    return error


class Bundle:
    def __init__(self, model: PureRootCauseGNN, metadata: dict):
        self.model = model
        self.metadata = metadata


def model_fn(model_dir: str) -> Bundle:
    with open(os.path.join(model_dir, "metadata.json"), encoding="utf-8") as f:
        metadata = json.load(f)
    state = torch.load(os.path.join(model_dir, metadata.get("weights_file", "model.pt")), map_location="cpu")
    model = PureRootCauseGNN.from_state_dict(state, improved=metadata.get("improved", True))
    return Bundle(model, metadata)


def input_fn(request_body, content_type: str = CONTENT_TYPE) -> dict:
    if content_type is None or not content_type.split(";")[0].strip().lower() == CONTENT_TYPE:
        raise _as_client_error(SnapshotError(f"unsupported content type {content_type!r}; send {CONTENT_TYPE}"), 415)
    try:
        return _parse_body(request_body)
    except SnapshotError as e:
        raise _as_client_error(e) from e


def _parse_body(request_body) -> dict:
    if isinstance(request_body, (bytes, bytearray)):
        try:
            request_body = request_body.decode("utf-8")
        except UnicodeDecodeError as e:
            raise SnapshotError(f"body is not valid UTF-8: {e}") from e
    try:
        payload = json.loads(request_body)
    except json.JSONDecodeError as e:
        raise SnapshotError(f"body is not valid JSON: {e}") from e
    if not isinstance(payload, dict):
        raise SnapshotError("body must be a JSON object with 'nodes' and 'edges'")
    top_k = payload.get("top_k", DEFAULT_TOP_K)
    if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= MAX_TOP_K:
        raise SnapshotError(f"top_k must be an integer in [1, {MAX_TOP_K}], got {top_k!r}")
    return {"nodes": payload.get("nodes"), "edges": payload.get("edges"), "top_k": top_k}


def predict_fn(data: dict, bundle: Bundle) -> dict:
    try:
        feats = build_features(data["nodes"], data["edges"])
    except SnapshotError as e:
        raise _as_client_error(e) from e
    expected = bundle.metadata.get("node_in_dim")
    if expected is not None and feats.x.shape[1] != expected:
        raise RuntimeError(f"feature width {feats.x.shape[1]} does not match the model ({expected})")
    logits = bundle.model(feats.x, feats.edge_index, feats.edge_attr)
    probs = torch.softmax(logits, dim=0)

    candidates = sorted(feats.candidate_indices, key=lambda i: (-probs[i].item(), feats.names[i]))
    ranking = [
        {"rank": r + 1, "name": feats.names[i], "score": probs[i].item()}
        for r, i in enumerate(candidates[: data["top_k"]])
    ]
    return {
        "model_version": bundle.metadata.get("model_version", "unknown"),
        "num_nodes": len(feats.names),
        "num_edges": int(feats.edge_index.shape[1]),
        "ranking": ranking,
        "scores": {name: probs[i].item() for i, name in enumerate(feats.names)},
    }


def output_fn(prediction: dict, accept: str = CONTENT_TYPE):
    if accept and accept.split(",")[0].split(";")[0].strip().lower() not in (CONTENT_TYPE, "*/*"):
        raise _as_client_error(SnapshotError(f"unsupported Accept {accept!r}; only {CONTENT_TYPE} is produced"), 406)
    return json.dumps(prediction), CONTENT_TYPE
