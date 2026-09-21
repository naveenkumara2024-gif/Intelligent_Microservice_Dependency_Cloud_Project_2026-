# Stage 3 follow-up — richer, traffic-aware fault features

Status: DEFERRED — approved in concept, to be executed after Stage 4 completes.
Not a new numbered build-order stage; this is an iteration on Stage 3's
already-trained model (see prompt/stage-03-gnn-training.md for the baseline).

## Why

Stage 3's trained model (test top-1=28-30%, top-3=47-48%, well above both the
random baseline and a trivial "argmax of raw input" baseline) plateaued
across two independent runs (CPU and GPU), and the worked-example output
showed a specific, diagnosable failure mode: for some scenarios the model's
top-5 scores collapsed to near-identical values (e.g. all ~0.0110), meaning
it had no way to distinguish the true root cause from other similarly-placed
nodes. Root cause of that gap: the current fault-injection signal only
encodes hop-distance and the ancestor's own baseline latency — it completely
ignores `call_count` (how much traffic actually flows between a node and its
downstream dependency). Two ancestors at the same hop distance from the
injected root get identical treatment today even if one depends on it
constantly and the other barely calls it at all.

## What changes (two fixes bundled as one iteration, per user decision)

### 1. Traffic-aware propagation (`fault_injection.py`)

Weight the propagated delta by call volume along the path from each ancestor
toward the root, not just hop-count decay. Concretely: when propagating from
a node `n` to its already-visited downstream neighbor during the reverse
BFS, scale the delta contribution by that edge's `call_count` relative to
`n`'s total outgoing call volume (i.e. "what fraction of `n`'s traffic goes
toward the fault") rather than a flat `decay ** hop` applied uniformly
regardless of how coupled the two nodes actually are.

### 2. Richer per-node dynamic features (`graph_dataset.py`, `model.py`)

Replace the single scalar dynamic feature (`observed latency delta`) with a
small feature vector per node, computed per-scenario:
  - the node's own delta (existing signal)
  - max delta among its direct downstream neighbors ("is something right
    below me on fire?")
  - mean delta among its direct downstream neighbors
This gives the model a local "gradient" pointing toward the fault, similar
to how a human would trace an incident by asking which downstream dependency
looks worse than they do. `model.py`'s `node_in_dim` must be updated
accordingly (4 static + 3 dynamic = 7, up from 5).

## Files touched

- `src/ml-engine/fault_injection.py` — traffic-weighted propagation in
  `inject_fault()`
- `src/ml-engine/graph_dataset.py` — `to_data()` accepts/builds the 3-dim
  dynamic feature block instead of 1
- `src/ml-engine/model.py` — update `node_in_dim` default usage
- `src/ml-engine/train.py` — no structural change expected beyond the
  `node_in_dim` computation already being derived from `graph.static_features.shape[1] + 1`
  (update the `+ 1` to `+ 3`)
- `src/ml-engine/predict.py` — no change expected (already generic over
  whatever `graph.to_data()` produces)

## Checkpoint

Retrain with the same 3,000-scenario / 60-epoch / early-stopping setup as
the Stage 3 baseline (same seed, for a fair comparison), and report:
- test top-1/top-3/top-5 vs. the Stage 3 baseline numbers above (must
  improve, or the iteration didn't work and should be investigated, not
  silently kept)
- re-run the same "trivial baseline" comparison (argmax of raw per-node
  delta) to confirm the model is still doing more than the naive heuristic
- re-inspect worked examples for the specific near-uniform-collapse pattern
  seen before, to confirm it's actually reduced, not just aggregate numbers
  moving
