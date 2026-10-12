import json
import random
import sys
from pathlib import Path

import pytest
import torch

ML_ENGINE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ML_ENGINE))

from model import RootCauseGNN  # noqa: E402

FIXTURE = ML_ENGINE / "fixtures" / "boutique_topology.json"
PROCESSED = ML_ENGINE.parent.parent / "Dataset" / "processed"
REAL_WEIGHTS = ML_ENGINE / "artifacts" / "model.pt"


@pytest.fixture(scope="session")
def boutique() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def random_state_dict() -> dict:
    """Seeded random weights: lets parity/contract tests run without the (gitignored) trained model."""
    torch.manual_seed(1234)
    model = RootCauseGNN(node_in_dim=7, edge_dim=9, hidden_dim=64, improved=True, dynamic_dim=3)
    with torch.no_grad():  # make LayerNorm and skip non-trivial so parity is not vacuous
        for p in model.parameters():
            p.add_(torch.randn_like(p) * 0.05)
    return {k: v.clone() for k, v in model.state_dict().items()}


@pytest.fixture
def snapshot(boutique) -> dict:
    rng = random.Random(7)
    nodes = [{**n, "own_delta": rng.choice([0.0, 0.0, 0.1, 0.5, 3.0])} for n in boutique["nodes"]]
    return {"nodes": nodes, "edges": [dict(e) for e in boutique["edges"]], "top_k": 3}
