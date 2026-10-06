# How the RCA Model Was Constructed & How It Finds the Root Cause

This explains the Stage 3 GNN (`src/ml-engine/`) in plain terms: what data it
sees, how it's trained without real failure labels, and the actual mechanism
by which it points at the one broken service instead of everything affected
by it.

## 1. The graph the model sees

[`graph_dataset.py`](../src/ml-engine/graph_dataset.py) loads the real Stage
1/2 service topology (`Dataset/processed/nodes.csv` / `edges.csv`) into a
fixed graph: **7,384 service nodes, 16,115 call edges**. This topology never
changes across scenarios — only the "symptom" values placed on top of it
change.

**Node features** (static, 4 dims per service): min-max scaled
`total_calls_as_um`, `total_calls_as_dm`, in-degree, out-degree — i.e. how
central/busy this service normally is.

**Edge features** (9 dims per call relationship): avg latency, p95 latency,
log-scaled call volume, and a one-hot of `rpctype`
(`rpc`/`db`/`mc`/`http`/`mq`/`userDefined`).

**Dynamic features** (3 dims, added per scenario): for each node — its own
latency deviation, the max deviation among its direct downstream callees, and
the mean deviation among its downstream callees (see Section 3 for what
"downstream" means here).

## 2. Why there's no real failure label — synthetic fault injection

The raw Alibaba trace dataset has **no error/failure column**. So
[`fault_injection.py`](../src/ml-engine/fault_injection.py) manufactures
labeled training examples:

1. Pick a random node as the "true" root cause (must have ≥1 incoming call —
   someone has to be calling it for a fault there to be visible).
2. Propagate impact **backward from the root, up through its callers**, up to
   4 hops, weighted by how much of each caller's traffic depends on the
   faulty path. A caller that sends 90% of its calls to the broken service
   inherits most of the fault; one that barely calls it feels almost nothing.
3. Convert impact into a **relative** latency deviation (`(factor - 1) *
   impact`), not an absolute one, so a fault on a normally-fast service isn't
   swamped by a naturally slow one.
4. Add realism: 2–6 unrelated **distractor spikes** (lone blips with no
   caller ripple behind them) and **background jitter** on every node (real
   services are never perfectly at 0). Without this jitter, a model reached
   97% accuracy trivially — because the faint ripple was a dead giveaway —
   then collapsed to 39% once realistic noise was added. This is why the
   jitter and distractors exist in the generator at all.

## 3. Upstream vs. downstream — the part that's easy to mix up

Two different "directions" show up in this project, and they are **not the
same thing**. Take a call chain: **A → B → C** (A calls B, B calls C).

**Downstream** = the direction a call travels *outward*, toward what you
depend on. Think of water flowing downstream, away from you.
- From B's point of view, downstream = C (the thing B calls).
- From A's point of view, downstream = B, and transitively C.

**Upstream** = the direction *back* toward whoever depends on you — back
toward the request's origin (e.g. the customer hitting a checkout API).
- From C's point of view, upstream = B, and transitively A.
- From B's point of view, upstream = A.

### Where each direction is used in this project

**(a) How the fault physically spreads → upstream.** If C is broken and
slow, B has to wait on C, so B looks slow too; A has to wait on B, so A looks
slow too. The symptom rides *up* the call chain, callee → caller:
C → B → A. This is what `fault_injection.py` simulates when it writes an
"own delta" latency-deviation number onto every node — the fault
*originates downstream* (at C) but its *symptom is felt upstream* (at B,
then A).

**(b) The engineered feature → downstream.** Once every node already has its
own-delta number from step (a), `graph_dataset.py` gives each node one more
piece of context by looking at the services it *calls* (its downstream),
not the services that call it:

> "Of the things I directly call, what's the max/mean of their own-delta?"

- For **B**, downstream = {C}. C's own-delta is very high → B's
  downstream-max feature = very high.
- For **A**, downstream = {B}. B's own-delta is high → A's downstream-max
  feature = high.
- For **C**, downstream = whatever C itself calls (assumed healthy) → C's
  downstream-max feature = normal.

### Why this mismatch is the key signal

| Node | own delta | downstream-max delta | interpretation |
|---|---|---|---|
| A | medium | high | "I'm slow, and so is something I call" → just relaying |
| B | high | very high | "I'm slow, and so is something I call" → just relaying |
| C | very high | **normal** | "I'm slow, but everything I call is fine" → **the problem is mine** |

**High own-delta but normal downstream-delta** is the fingerprint of the true
root cause. Everyone upstream of the fault has *both* numbers elevated
(inherited from below), but the root itself only has the first one elevated,
because nothing below it is actually broken. This is the pattern the GNN is
trained to recognize.

One-line summary:
- **Downstream** = the services *you* call (deeper into the system, away
  from the customer).
- **Upstream** = the services that call *you* (closer to the customer).

## 4. Model architecture (`RootCauseGNN`)

```
GATv2Conv(node_feats, edge_attr) → SAGEConv → SAGEConv → SAGEConv → Linear(→ 1 score/node)
```

- **GATv2Conv** (layer 1): attention-weighted aggregation that also consumes
  edge features, so a node's embedding is shaped by *which* neighbors matter
  and *how* they're connected (latency/volume/rpc-type), not just adjacency.
- **SAGEConv ×3** (layers 2–4): each layer lets a node absorb information
  from up to 3 hops away — matching how far the backward-propagated impact
  travels during fault injection (`MAX_HOPS = 4`).
- **`improved=True` additions**: LayerNorm + LeakyReLU per block, plus a
  learnable linear skip connection straight from the raw dynamic features to
  the output logit. This gives the network a floor behavior of "score ≈ how
  anomalous is this node and its callees," and the graph convolutions only
  need to refine that floor rather than reconstruct it from scratch.
- **Output**: one scalar logit per node → softmax over all 7,384 nodes → a
  full probability distribution over "which service is the root cause."

## 5. Training objective

Framed as multi-class classification over nodes, not regression or
threshold-based anomaly detection:
`F.nll_loss(log_softmax(logits), root_index)` per scenario. The model is
trained to put maximum probability mass on the one node that was the
injected root, given the noisy propagated symptom pattern across the whole
graph. 3,000 scenarios (2,100 train / 450 val / 450 test), Adam optimizer,
early stopping on validation loss (patience 8 epochs).

## 6. Inference — how a root cause is actually picked

Given an observed deviation vector (in production, live OTel latency deltas
per service), [`predict.py`](../src/ml-engine/predict.py):

1. Builds node features (static + own/max-downstream/mean-downstream
   deviation).
2. Runs one forward pass → logits → softmax over all nodes.
3. Ranks nodes by score. The top of the ranking is the predicted root cause;
   the rest of the ranked list is a natural "blast radius" — nodes affected
   by the fault but not its origin.

## 7. Measured performance (latest run, `artifacts/improved_jitter_run.log`)

On the 450-scenario held-out test set, with 7,310 candidate root nodes:

| Metric | Model | "Argmax of raw input" baseline | Random baseline |
|---|---|---|---|
| Top-1 | **62.9%** | 22.2% | 0.014% |
| Top-3 | **91.8%** | 65.3% | 0.041% |
| Top-5 | **98.2%** | 91.8% | — |

The comparison against the "trivial" baseline (just picking the node with
the largest raw deviation) isolates what the graph structure buys: the model
roughly **triples** the trivial baseline's top-1 accuracy (62.9% vs. 22.2%),
which is empirical evidence that the GNN is learning the
upstream-propagation / downstream-mismatch pattern above — not just reading
off the biggest number.
