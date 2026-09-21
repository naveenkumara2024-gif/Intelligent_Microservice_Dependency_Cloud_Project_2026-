"""
Trains RootCauseGNN on synthetic fault-injection scenarios built from the
real Stage 1/2 service topology, and evaluates top-k accuracy against a
random-guess baseline and a trivial "argmax of raw input" baseline. See
prompt/stage-03-gnn-training.md and
prompt/stage-03-followup-feature-improvements.md.

Usage:
    python train.py                    # full features + improved arch -> artifacts/model.pt
    python train.py --features own     # ablation: own delta only -> artifacts/model_own.pt
    python train.py --arch plain       # control: original architecture -> artifacts/model_plain.pt
"""

import argparse
import json
import random
import time
from pathlib import Path

import torch
import torch.nn.functional as F

import fault_injection
from graph_dataset import ServiceGraph
from model import RootCauseGNN

SEED = 42
N_TOTAL_SCENARIOS = 3000
TRAIN_FRAC, VAL_FRAC = 0.70, 0.15
EPOCHS = 60
PATIENCE = 8
LR = 1e-3
HIDDEN_DIM = 64

ARTIFACTS_DIR = Path(__file__).parent / "artifacts"


def topk_hit(logits: torch.Tensor, true_idx: int, k: int) -> bool:
    top = torch.topk(logits, k=min(k, logits.shape[0])).indices.tolist()
    return true_idx in top


def evaluate(model, graph, scenarios, device, ks=(1, 3, 5)):
    """Returns (mean loss, {k: top-k accuracy}, collapse rate). A scenario is
    'collapsed' when the model's top-1 and top-5 probabilities are within 1e-4,
    i.e. it can't tell its best guess from its fifth (the near-uniform failure
    mode seen in the first Stage 3 run)."""
    model.eval()
    hits = {k: 0 for k in ks}
    total_loss = 0.0
    collapsed = 0
    with torch.no_grad():
        for sc in scenarios:
            data = graph.to_data(sc.dynamic_feature)
            logits = model(data.x, data.edge_index, data.edge_attr)
            log_probs = F.log_softmax(logits, dim=0)
            target = torch.tensor([sc.root_index], device=device)
            total_loss += F.nll_loss(log_probs.unsqueeze(0), target).item()
            for k in ks:
                if topk_hit(logits, sc.root_index, k):
                    hits[k] += 1
            top5 = torch.topk(log_probs.exp(), 5).values
            if (top5[0] - top5[4]).item() < 1e-4:
                collapsed += 1
    n = len(scenarios)
    acc = {k: hits[k] / n for k in ks}
    return total_loss / n, acc, collapsed / n


def trivial_baseline(scenarios, ks=(1, 3, 5)):
    """Skip the GNN entirely: rank nodes by their raw observed latency delta."""
    hits = {k: 0 for k in ks}
    for sc in scenarios:
        ranked = torch.topk(sc.dynamic_feature, max(ks)).indices.tolist()
        for k in ks:
            if sc.root_index in ranked[:k]:
                hits[k] += 1
    return {k: hits[k] / len(scenarios) for k in ks}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", choices=["full", "own"], default="full",
                        help="'full' = own + downstream max/mean delta; 'own' = own delta only (ablation)")
    parser.add_argument("--arch", choices=["improved", "plain"], default="improved",
                        help="'improved' = LayerNorm + LeakyReLU + skip; 'plain' = original Stage 3 architecture")
    args = parser.parse_args()
    suffix = ("" if args.features == "full" else "_own") + ("" if args.arch == "improved" else "_plain")

    torch.manual_seed(SEED)
    random.seed(SEED)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Using device: {device}" + (f" ({torch.cuda.get_device_name(0)})" if device == "cuda" else ""))
    print(f"Dynamic features: {args.features}   Architecture: {args.arch}")

    print("Loading graph...")
    graph = ServiceGraph(device=device, dynamic_features=args.features)
    print(f"  nodes={graph.num_nodes} edges={graph.edge_index.shape[1]} "
          f"candidate_roots={len(graph.candidate_root_indices)}")

    print(f"Generating {N_TOTAL_SCENARIOS} synthetic fault scenarios (seed={SEED})...")
    all_scenarios = fault_injection.generate_dataset(graph, N_TOTAL_SCENARIOS, seed=SEED)
    n_train = int(N_TOTAL_SCENARIOS * TRAIN_FRAC)
    n_val = int(N_TOTAL_SCENARIOS * VAL_FRAC)
    train_scenarios = all_scenarios[:n_train]
    val_scenarios = all_scenarios[n_train : n_train + n_val]
    test_scenarios = all_scenarios[n_train + n_val :]
    print(f"  train={len(train_scenarios)} val={len(val_scenarios)} test={len(test_scenarios)}")

    model = RootCauseGNN(node_in_dim=graph.static_features.shape[1] + graph.num_dynamic,
                          edge_dim=graph.edge_attr.shape[1], hidden_dim=HIDDEN_DIM,
                          improved=args.arch == "improved", dynamic_dim=graph.num_dynamic).to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)

    best_val_loss = float("inf")
    best_state = None
    epochs_without_improvement = 0

    print("\n=== Training ===")
    for epoch in range(1, EPOCHS + 1):
        model.train()
        t0 = time.time()
        random.shuffle(train_scenarios)
        total_train_loss = 0.0
        for sc in train_scenarios:
            data = graph.to_data(sc.dynamic_feature)
            optimizer.zero_grad()
            logits = model(data.x, data.edge_index, data.edge_attr)
            log_probs = F.log_softmax(logits, dim=0)
            target = torch.tensor([sc.root_index], device=device)
            loss = F.nll_loss(log_probs.unsqueeze(0), target)
            loss.backward()
            optimizer.step()
            total_train_loss += loss.item()
        train_loss = total_train_loss / len(train_scenarios)

        val_loss, val_acc, _ = evaluate(model, graph, val_scenarios, device)
        dt = time.time() - t0
        print(f"epoch {epoch:3d}/{EPOCHS}  train_loss={train_loss:.4f}  val_loss={val_loss:.4f}  "
              f"val_top1={val_acc[1]:.3f}  val_top3={val_acc[3]:.3f}  val_top5={val_acc[5]:.3f}  "
              f"({dt:.1f}s)")

        if val_loss < best_val_loss - 1e-4:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            epochs_without_improvement = 0
        else:
            epochs_without_improvement += 1
            if epochs_without_improvement >= PATIENCE:
                print(f"Early stopping at epoch {epoch} (no val improvement for {PATIENCE} epochs)")
                break

    model.load_state_dict(best_state)

    print("\n=== Test set evaluation ===")
    test_loss, test_acc, collapse_rate = evaluate(model, graph, test_scenarios, device)
    trivial = trivial_baseline(test_scenarios)
    n_candidates = len(graph.candidate_root_indices)
    random_top1 = 1 / n_candidates
    random_top3 = min(1.0, 3 / n_candidates)
    print(f"test_loss={test_loss:.4f}")
    print(f"test_top1={test_acc[1]:.4f}  (trivial argmax-of-input: {trivial[1]:.4f}, random: {random_top1:.6f})")
    print(f"test_top3={test_acc[3]:.4f}  (trivial argmax-of-input: {trivial[3]:.4f}, random: {random_top3:.6f})")
    print(f"test_top5={test_acc[5]:.4f}  (trivial argmax-of-input: {trivial[5]:.4f})")
    print(f"collapse_rate={collapse_rate:.4f}  (share of test scenarios where top-1 and top-5 probs are within 1e-4)")

    print("\n=== Worked examples (true root cause vs. top-5 predictions) ===")
    model.eval()
    with torch.no_grad():
        for sc in test_scenarios[:3]:
            data = graph.to_data(sc.dynamic_feature)
            logits = model(data.x, data.edge_index, data.edge_attr)
            probs = F.softmax(logits, dim=0)
            top5 = torch.topk(probs, k=5)
            true_name = graph.service_names[sc.root_index]
            print(f"\nTrue root cause: {true_name[:20]}... (idx {sc.root_index})")
            for rank, (idx, p) in enumerate(zip(top5.indices.tolist(), top5.values.tolist()), 1):
                marker = " <-- correct" if idx == sc.root_index else ""
                print(f"  #{rank} {graph.service_names[idx][:20]}... score={p:.4f}{marker}")

    ARTIFACTS_DIR.mkdir(exist_ok=True)
    cpu_state_dict = {k: v.cpu() for k, v in model.state_dict().items()}
    torch.save(cpu_state_dict, ARTIFACTS_DIR / f"model{suffix}.pt")
    with open(ARTIFACTS_DIR / "node_index.json", "w") as f:
        json.dump({"service_names": graph.service_names}, f)
    print(f"\nSaved {ARTIFACTS_DIR / f'model{suffix}.pt'}")
    print(f"Saved {ARTIFACTS_DIR / 'node_index.json'}")


if __name__ == "__main__":
    main()
