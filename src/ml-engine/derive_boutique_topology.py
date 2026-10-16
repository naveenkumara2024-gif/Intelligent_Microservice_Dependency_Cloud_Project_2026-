"""
Derive the Online Boutique call topology from the vendored Kubernetes manifest and write
fixtures/boutique_topology.json.

PROVENANCE (also written into the JSON, so nobody mistakes it for captured traffic):
  * Nodes and edges are derived MECHANICALLY: a Deployment that is configured with another
    deployment's address (an env var ending in ``_ADDR`` whose host is a deployed service) can call
    it. Only deployed services become nodes, so ``SHOPPING_ASSISTANT_SERVICE_ADDR`` (no such
    deployment in the vendored manifest) is ignored.
  * Volumes and latencies are SYNTHETIC (seeded), only there so the graph has the same feature
    schema as the Alibaba graph. They are NOT measurements.

Usage:
    python derive_boutique_topology.py            # rewrites fixtures/boutique_topology.json
    python derive_boutique_topology.py --check    # exit 1 if the committed fixture is stale
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).parent
MANIFEST = ROOT.parent.parent / "k8s" / "online-boutique" / "kubernetes-manifests.yaml"
FIXTURE = ROOT / "fixtures" / "boutique_topology.json"
SEED = 20261012

# Telemetry export, not a business call.
IGNORED_ENV = {"COLLECTOR_SERVICE_ADDR"}


def _rpctype(caller: str, callee: str) -> str:
    if callee == "redis-cart":
        return "db"
    if caller == "loadgenerator":
        return "http"
    return "rpc"  # the Boutique services talk gRPC


def derive() -> dict:
    docs = [d for d in yaml.safe_load_all(MANIFEST.read_text(encoding="utf-8")) if d]
    deployments = {d["metadata"]["name"]: d for d in docs if d.get("kind") == "Deployment"}
    names = sorted(deployments)

    pairs: set[tuple[str, str]] = set()
    for caller, dep in deployments.items():
        for container in dep["spec"]["template"]["spec"]["containers"]:
            for env in container.get("env", []) or []:
                key, value = env.get("name", ""), env.get("value")
                if not value or key in IGNORED_ENV or not re.search(r"_ADDR$", key):
                    continue
                host = value.split(":")[0]
                if host in deployments and host != caller:
                    pairs.add((caller, host))

    rng = random.Random(SEED)
    edges = []
    for um, dm in sorted(pairs):
        avg = math.exp(rng.uniform(math.log(0.5), math.log(40.0)))
        edges.append(
            {
                "um": um,
                "dm": dm,
                "call_count": int(math.exp(rng.uniform(math.log(1e3), math.log(1e6)))),
                "avg_latency_ms": round(avg, 3),
                "p95_latency_ms": round(avg * rng.uniform(2.0, 6.0), 3),
                "rpctype": _rpctype(um, dm),
            }
        )

    out_calls = {n: 0 for n in names}
    in_calls = {n: 0 for n in names}
    for e in edges:
        out_calls[e["um"]] += e["call_count"]
        in_calls[e["dm"]] += e["call_count"]
    nodes = [
        {"name": n, "total_calls_as_um": out_calls[n], "total_calls_as_dm": in_calls[n]} for n in names
    ]
    return {
        "_provenance": {
            "topology": "derived from the *_ADDR env vars in k8s/online-boutique/kubernetes-manifests.yaml",
            "volumes_and_latencies": "SYNTHETIC (seeded), not measured",
            "seed": SEED,
        },
        "nodes": nodes,
        "edges": edges,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed fixture differs")
    args = parser.parse_args()
    fresh = derive()
    text = json.dumps(fresh, indent=2) + "\n"
    if args.check:
        current = FIXTURE.read_text(encoding="utf-8") if FIXTURE.exists() else ""
        if current != text:
            print(f"{FIXTURE} is stale; run: python derive_boutique_topology.py", file=sys.stderr)
            return 1
        print("fixture is up to date")
        return 0
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(text, encoding="utf-8")
    print(f"wrote {FIXTURE}: {len(fresh['nodes'])} nodes, {len(fresh['edges'])} edges")
    return 0


if __name__ == "__main__":
    sys.exit(main())
