# Stage 3 — GNN model trained offline (PyTorch Geometric, synthetic fault injection)

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol"). No files beyond this spec have been created yet.

## Why this stage exists

The Alibaba trace data has no ground-truth failure/error signal (confirmed in
Stage 1 — no `error_rate` column exists). To train a GNN that can point at a
root-cause node given a pattern of elevated latency, we must generate labeled
training examples ourselves via **synthetic fault injection** on the real
Stage 1/2 topology, per the project's build order (item 3) and its own
novelty framing (CLAUDE.md): the contribution is the streaming system around
graph-based RCA, not a novel GNN — so the model architecture should be a
standard, well-understood one (GraphSAGE), not a research contribution.

## Inputs already confirmed (do not re-derive from assumption)

- `Dataset/processed/nodes.csv` — 7,384 rows: `service_name, total_calls_as_um, total_calls_as_dm`
- `Dataset/processed/edges.csv` — 16,115 rows: `um, dm, call_count, avg_latency_ms, p95_latency_ms, rpctype`
- 7,310 of 7,384 nodes have >=1 incoming call (candidate root-cause pool)
- 235 edges are self-loops (`um == dm`) — keep them as edges but exclude from
  ancestor-propagation BFS (a self-loop can't be a "hop" to a different node)
- Reverse-reachability (callers of callers of ... a target node) checked
  directly against the real graph: at 4 hops, ancestor-set sizes for a random
  sample ranged ~18–601 nodes — a realistic, non-trivial blast radius. Using
  this to size the propagation radius below rather than guessing.
- `rpctype` categories present: `rpc, db, mc, http, mq, userDefined` (6, not
  the 5 documented in the dataset's own README)

## Causal direction (important, easy to get backwards)

If service R degrades, the nodes that *notice* elevated latency are R's
**callers, and callers-of-callers** (upstream, i.e. ancestors of R when edges
point `caller -> callee`) — not R's downstream dependencies. "Checkout is
slow" (symptom, upstream) because "payment" (root cause) is slow
(downstream). Fault injection therefore propagates *backwards* along `CALLS`
edges from the injected node outward to its callers.

## Files to create

```
src/ml-engine/
├── graph_dataset.py      # loads nodes.csv/edges.csv -> PyTorch Geometric Data object
├── fault_injection.py    # synthetic fault scenario generator
├── model.py               # GraphSAGE root-cause scoring model
├── train.py                # generates scenarios, trains, evaluates, saves artifact
└── artifacts/               # (gitignored) trained model.pt + node-id mapping json
```

### `graph_dataset.py`

- Reads `Dataset/processed/nodes.csv` and `edges.csv`.
- Builds a stable `service_name -> integer node index` mapping (sorted for
  determinism), saved alongside the model artifact so inference can map
  indices back to real service hashes later (Stage 10/SageMaker).
- Static node features (4 dims, min-max normalized): `total_calls_as_um`,
  `total_calls_as_dm`, in-degree, out-degree.
- Edge features: `avg_latency_ms`, `p95_latency_ms`, `log1p(call_count)`,
  one-hot(`rpctype`) (6 dims) — used as `edge_attr` for a `GATv2Conv` /
  `SAGEConv`-with-edge-features style layer. Self-loop edges are kept in the
  graph (they're real recorded behavior) but excluded from the reverse BFS
  used for fault propagation.
- Returns a single `torch_geometric.data.Data` object holding the fixed
  topology (`edge_index`, `edge_attr`) reused by every synthetic scenario.

### `fault_injection.py`

One synthetic scenario = one labeled training example, generated as:

1. Pick a root-cause node `R` uniformly at random from the 7,310 nodes with
   >=1 incoming call.
2. Sample a severity multiplier `factor ~ Uniform(3, 10)`.
3. Reverse-BFS from `R` along `CALLS` edges (caller direction), up to
   **4 hops**, skipping self-loops, to find ancestor set `A` with hop
   distances.
4. For each ancestor `a` in `A` at hop distance `h`, compute an injected
   "observed latency delta" = `baseline_latency(a) * (factor - 1) * decay^h`
   with `decay = 0.6`. `R` itself gets the full `factor` applied.
5. All other nodes get delta = 0 (normal).
6. Per-scenario dynamic node feature (5th feature dim, appended to the 4
   static ones) = normalized observed latency delta.
7. Label = the integer node index of `R` (single ground-truth index, not a
   per-node binary vector — see loss function below).
8. Generate 3,000 scenarios total: 2,100 train / 450 val / 450 test
   (70/15/15 split), fixed random seed for reproducibility.

### `model.py`

- 3-layer `GraphSAGE` (`torch_geometric.nn.SAGEConv`), hidden_dim=64,
  ReLU + dropout(0.2) between layers, final linear layer -> scalar score per
  node.
- Input: 5-dim node features (4 static + 1 dynamic-per-scenario) + fixed
  `edge_index`. (Edge features used in an initial `GATv2Conv` embedding
  layer before the SAGEConv stack, so latency/rpctype context informs
  message passing.)
- Output: raw per-node logit; `log_softmax` across all nodes in the graph
  turns this into a single distribution over "which node is the root cause."

### `train.py`

- Loss: `NLLLoss` on `log_softmax(scores)` against the true root-cause node
  index (multi-class classification over all 7,384 nodes, one correct class
  per scenario) — chosen over per-node BCE because there's exactly one
  positive per scenario among thousands of nodes; softmax avoids the
  resulting class imbalance.
- Optimizer: Adam, lr=1e-3, 60 epochs, early stopping on val loss
  (patience=8).
- Metrics logged per epoch: train/val loss, **top-1 accuracy** (argmax ==
  true `R`) and **top-3 accuracy** (true `R` in top 3 scores) on val set.
- After training, evaluate top-1/top-3/top-5 accuracy on the held-out test
  set, and print 3 example scenarios (true root cause + model's top-5
  predicted nodes with scores) for manual sanity-check.
- Saves `src/ml-engine/artifacts/model.pt` (state dict) and
  `src/ml-engine/artifacts/node_index.json` (service_name <-> index mapping).
  This directory is gitignored (trained weights are a build artifact, not
  source) — `.gitkeep` only tracked.

## Commands to run (after approval)

```bash
cd src/ml-engine
pip install -r requirements.txt scikit-learn   # add scikit-learn for split utilities
python train.py
```

## Checkpoint — what "done" means

1. Show actual printed training curve (loss + top-1/top-3 val accuracy per
   epoch), not a claimed final number only.
2. Final test-set metrics: top-1, top-3, top-5 accuracy.
3. **Baseline comparison for sanity**: a random-guess baseline over 7,310
   candidate nodes has top-1 accuracy ~0.014%, top-3 ~0.04% — the trained
   model must clear this by a wide margin, or something is wrong (e.g. label
   leakage, broken propagation) rather than genuinely working.
4. Print the 3 worked examples (true root cause vs. top-5 predictions) so
   correctness can be eyeballed, not just trusted from an aggregate number.
5. Confirm `model.pt` and `node_index.json` exist and are gitignored (not
   staged for commit).

## Explicitly out of scope for this stage

- No SageMaker deployment (Stage 10).
- No real anomaly labels — everything here is synthetic by design; this
  stage's job is to prove the GNN can localize an injected fault on the real
  topology, not to detect real incidents yet.
- No changes to `Dataset/processed/*.csv` or the Stage 1/2 pipeline.
