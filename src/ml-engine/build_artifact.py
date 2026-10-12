"""
Build the SageMaker model artifact: dist/model.tar.gz

Layout (what the PyTorch inference container expects):
    model.pt            state dict (loaded by inference.model_fn)
    metadata.json       hyperparameters, version, provenance, gate result
    code/inference.py   handlers (SAGEMAKER_PROGRAM)
    code/features.py    snapshot -> tensors
    code/model_pure.py  plain-PyTorch model (no torch_geometric in the container)

Reproducible: fixed timestamps and ownership, sorted entries, so the same inputs give the same
bytes (and the same CDK asset hash, i.e. no pointless redeploys).

Safety: the weights must have been through evaluate_boutique.py. The evaluation file records the
sha256 of the weights it measured; a missing, stale (different weights) or failing evaluation is
refused unless --allow-failing-gate is given, which is recorded in metadata.json.

Usage:
    python build_artifact.py        # models/model_small.pt + models/boutique_eval.json
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

import torch

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
CODE_FILES = ["inference.py", "features.py", "model_pure.py"]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_metadata(weights: Path, evaluation: dict | None, allow_failing_gate: bool) -> dict:
    state = torch.load(weights, map_location="cpu")
    digest = sha256(weights)
    gate = (evaluation or {}).get("gate", {})
    return {
        "model_version": digest[:12],
        "weights_file": "model.pt",
        "weights_sha256": digest,
        "architecture": "RootCauseGNN (GATv2Conv + 3 x SAGEConv, LayerNorm, skip)",
        "improved": "norms.0.weight" in state,
        "node_in_dim": int(state["edge_embed.lin_l.weight"].shape[1]),
        "edge_dim": int(state["edge_embed.lin_edge.weight"].shape[1]),
        "hidden_dim": int(state["edge_embed.lin_l.weight"].shape[0]),
        "dynamic_dim": int(state["skip.weight"].shape[1]) if "skip.weight" in state else 3,
        "input_contract": "see code/inference.py; own_delta = observed/normal - 1 per service",
        "labels": "SYNTHETIC fault injection only (no real failure labels exist)",
        "boutique_gate": {
            "met": bool(gate.get("met", False)),
            "bypassed": bool(allow_failing_gate and not gate.get("met", False)),
            "top1_min": gate.get("top1_min"),
            "top3_min": gate.get("top3_min"),
            "proportional": (evaluation or {}).get("proportional"),
            "faithful": (evaluation or {}).get("faithful"),
        },
    }


def _add_bytes(tar: tarfile.TarFile, name: str, data: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mtime = 0
    info.mode = 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    tar.addfile(info, io.BytesIO(data))


def build(weights: Path, evaluation_path: Path, out: Path, allow_failing_gate: bool = False) -> Path:
    if not weights.exists():
        raise SystemExit(f"weights not found: {weights}")
    evaluation = None
    if evaluation_path.exists():
        evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    if not allow_failing_gate:
        if evaluation is None:
            raise SystemExit(f"no gate evaluation at {evaluation_path}; run evaluate_boutique.py --weights {weights}")
        if evaluation.get("weights_sha256") != sha256(weights):
            raise SystemExit(f"{evaluation_path} was measured on different weights; re-run evaluate_boutique.py")
        if not evaluation.get("gate", {}).get("met"):
            raise SystemExit("the Boutique gate is NOT met for these weights; refusing to package (see evaluate_boutique.py)")

    metadata = build_metadata(weights, evaluation, allow_failing_gate)
    out.parent.mkdir(parents=True, exist_ok=True)
    # gzip's own header embeds a timestamp; write it with mtime=0 so the bytes are reproducible.
    import gzip

    with open(out, "wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tar:
            _add_bytes(tar, "metadata.json", (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode())
            _add_bytes(tar, "model.pt", weights.read_bytes())
            for name in sorted(CODE_FILES):
                _add_bytes(tar, f"code/{name}", (ROOT / name).read_bytes())
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", type=Path, default=ROOT / "models" / "model_small.pt")
    parser.add_argument("--eval", type=Path, default=ROOT / "models" / "boutique_eval.json", dest="evaluation")
    parser.add_argument("--out", type=Path, default=DIST / "model.tar.gz")
    parser.add_argument("--allow-failing-gate", action="store_true")
    args = parser.parse_args()
    path = build(args.weights, args.evaluation, args.out, args.allow_failing_gate)
    print(f"wrote {path} ({path.stat().st_size} bytes, sha256 {sha256(path)[:16]}...)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
