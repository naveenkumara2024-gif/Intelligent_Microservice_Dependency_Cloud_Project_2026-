"""
Interactive console tester for the trained RootCauseGNN.

Pick a service to simulate as the "broken" one (by index, by hash substring
search, or randomly), choose a severity, and see the model's live top-10
root-cause guesses -- lets you sanity-check the model beyond the aggregate
test-set numbers from train.py.

Usage:
    python predict.py
"""

import random
from pathlib import Path

import torch
import torch.nn.functional as F

import fault_injection
from graph_dataset import ServiceGraph
from model import RootCauseGNN

ARTIFACTS_DIR = Path(__file__).parent / "artifacts"
TOP_K = 10


def load_model(graph: ServiceGraph, device: str) -> RootCauseGNN:
    model = RootCauseGNN(node_in_dim=graph.static_features.shape[1] + graph.num_dynamic,
                          edge_dim=graph.edge_attr.shape[1], dynamic_dim=graph.num_dynamic)
    state_dict = torch.load(ARTIFACTS_DIR / "model.pt", map_location=device)
    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()
    return model


def run_scenario(graph: ServiceGraph, model: RootCauseGNN, root: int, factor: float,
                 rng: random.Random) -> None:
    scenario = fault_injection.inject_fault(graph, root, factor, rng)
    doubled = int((scenario.dynamic_feature > 1.0 / (fault_injection.FACTOR_HIGH - 1.0)).sum())
    print(f"\nInjected fault at: {graph.service_names[root]}  (factor={factor:.2f}; {doubled} nodes "
          "are at >2x their normal latency, incl. a few unrelated distractor spikes; "
          "every node also gets background jitter)")

    with torch.no_grad():
        data = graph.to_data(scenario.dynamic_feature)
        logits = model(data.x, data.edge_index, data.edge_attr)
        probs = F.softmax(logits, dim=0)

    ranked = torch.argsort(probs, descending=True)
    true_rank = (ranked == root).nonzero(as_tuple=True)[0].item() + 1  # 1-indexed

    print(f"\nModel's top-{TOP_K} predicted root causes:")
    for i in range(TOP_K):
        idx = ranked[i].item()
        marker = "  <-- actual injected root cause" if idx == root else ""
        print(f"  #{i+1:2d}  {graph.service_names[idx]}  score={probs[idx].item():.4f}{marker}")

    if true_rank > TOP_K:
        print(f"\n(Actual root cause was NOT in top {TOP_K} -- true rank was #{true_rank} "
              f"out of {graph.num_nodes}, score={probs[root].item():.4f})")


def find_matches(graph: ServiceGraph, substring: str, limit: int = 20) -> list[int]:
    substring = substring.lower()
    matches = [i for i, name in enumerate(graph.service_names) if substring in name.lower()]
    return matches[:limit]


def main() -> None:
    if not (ARTIFACTS_DIR / "model.pt").exists():
        print(f"No trained model found at {ARTIFACTS_DIR / 'model.pt'}. Run train.py first.")
        return

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading graph and model (device={device})...")
    graph = ServiceGraph(device=device)
    model = load_model(graph, device)
    rng = random.Random()

    print(f"\nGraph loaded: {graph.num_nodes} services, {len(graph.candidate_root_indices)} "
          "can be picked as a root cause (must have >=1 incoming call).")
    print("\nCommands:")
    print("  random                 - inject a fault at a random service")
    print("  list [N]                - list first N candidate service hashes with their index (default 10)")
    print("  search <substring>      - find services whose hash contains <substring>")
    print("  <index>                 - inject a fault at that service index")
    print("  quit / exit             - stop")

    while True:
        try:
            cmd = input("\n> ").strip()
        except (EOFError, KeyboardInterrupt):
            break

        if not cmd:
            continue
        if cmd in ("quit", "exit"):
            break

        parts = cmd.split()
        keyword = parts[0].lower()

        if keyword == "random":
            root = rng.choice(graph.candidate_root_indices)
        elif keyword == "list":
            n = int(parts[1]) if len(parts) > 1 else 10
            for i in graph.candidate_root_indices[:n]:
                print(f"  [{i}] {graph.service_names[i]}")
            continue
        elif keyword == "search":
            if len(parts) < 2:
                print("Usage: search <substring>")
                continue
            matches = find_matches(graph, parts[1])
            if not matches:
                print("No matches.")
                continue
            for i in matches:
                tag = "" if i in graph.candidate_root_indices else "  (no incoming calls -- can't be a root cause)"
                print(f"  [{i}] {graph.service_names[i]}{tag}")
            continue
        elif keyword.isdigit():
            root = int(keyword)
            if root >= graph.num_nodes:
                print(f"Index out of range (0-{graph.num_nodes - 1}).")
                continue
            if root not in graph.reverse_adj and root not in graph.candidate_root_indices:
                print("Warning: this service has no incoming calls -- nobody would notice it "
                      "degrading, so this isn't a realistic root-cause scenario, but running it anyway.")
        else:
            print("Unrecognized command.")
            continue

        factor_input = input("Severity factor [3-10, blank for random]: ").strip()
        factor = float(factor_input) if factor_input else rng.uniform(3.0, 10.0)

        run_scenario(graph, model, root, factor, rng)


if __name__ == "__main__":
    main()
