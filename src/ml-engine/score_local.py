"""
Score a graph snapshot locally with exactly the code the SageMaker endpoint runs.

It is the reference for the Stage 10b parity check (the deployed endpoint must return the same
scores) and a handy CLI: feed it the same JSON you would POST to the endpoint.

Usage:
    python score_local.py --in snapshot.json                 # models/model_small.pt
    python score_local.py --in snapshot.json --weights artifacts/model.pt
    cat snapshot.json | python score_local.py --in -
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch

import inference
from features import SnapshotError
from model_pure import PureRootCauseGNN

ROOT = Path(__file__).parent


def load_bundle(weights: Path) -> inference.Bundle:
    state = torch.load(weights, map_location="cpu")
    return inference.Bundle(
        PureRootCauseGNN.from_state_dict(state),
        {"model_version": weights.stem, "node_in_dim": 7, "improved": True},
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="source", required=True, help="snapshot JSON file, or - for stdin")
    parser.add_argument("--weights", type=Path, default=ROOT / "models" / "model_small.pt")
    args = parser.parse_args()
    body = sys.stdin.read() if args.source == "-" else Path(args.source).read_text(encoding="utf-8")
    try:
        result = inference.predict_fn(inference.input_fn(body), load_bundle(args.weights))
    except SnapshotError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 2
    # model_version is the weights file stem here; the endpoint reports the artifact's sha prefix.
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
