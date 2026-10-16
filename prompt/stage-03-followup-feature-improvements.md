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

## Implementation notes — deviations from the plan above (added during execution)

1. **The plan as written made the benchmark trivial.** With traffic-weighted
   propagation alone, the root always carries the largest raw signal, and the
   "argmax of raw per-node delta" heuristic (no GNN) scored **93.3% top-1** on
   the new generator (vs 9.6% on the old one). Any model "improving" on that
   would be meaningless, so the plan's own checkpoint (must beat the trivial
   baseline) could not have been satisfied honestly.
2. **Fix: isolated distractor spikes** (`N_DISTRACTORS_RANGE = (2, 6)` in
   `fault_injection.py`). Each scenario also gets 2-6 unrelated single-node
   latency spikes (same 3-10x severity distribution as a real fault, no ripple
   to callers), modelling the project's alert-fatigue problem statement.
   Parameters were fixed before looking at results, not tuned. Trivial-baseline
   top-1 on the resulting generator: 20.9%. Because raw-argmax top-5 is 88%
   here, **top-1 is the metric that matters**; top-3/5 are near-saturated for
   the trivial heuristic.
3. **Ablation added** (`train.py --features own|full`) so the value of the
   richer features is measured on the *same* generator, instead of comparing
   against Stage 3 numbers that were produced on a different (easier or
   harder) task. Stage 3 top-k numbers are not directly comparable to new ones
   because the scenario distribution changed.
4. **`predict.py` did need a change** (the plan said it wouldn't): it hard-coded
   the old 5-dim input; it now derives the input size from the graph and
   applies distractors so the interactive tester matches training.
5. **`DECAY` removed** from `fault_injection.py` (replaced by traffic weights);
   `reverse_weight` added to `ServiceGraph`.
6. **Near-uniform-collapse rate** is now measured quantitatively (top-1 vs
   top-5 probability within 1e-4). Stage 3 baseline model on its own generator:
   **38.7%** of test scenarios collapsed (top-1 30.2%, top-3 46.7%, top-5 55.8%).

## Results (450 held-out test scenarios, same generator/seed/split for all rows)

| Model / heuristic                      | top-1  | top-3  | top-5  | collapse rate |
|----------------------------------------|--------|--------|--------|---------------|
| Trivial: argmax of raw delta (no GNN)  | 20.9%  | 65.6%  | 88.0%  | n/a           |
| GNN, own-delta feature only (ablation) | 13.3%  | 27.8%  | 35.3%  | 42.2%         |
| GNN, full features (own + down max/mean)| 32.7% | 48.4%  | 54.2%  | 35.3%         |

Std. error on a ~30% accuracy at n=450 is about 2.2 points.

What this does and does not show:
- **Richer features clearly help** (ablation, same generator): +19 points top-1.
- **The full GNN beats the trivial heuristic only on top-1** (32.7% vs 20.9%).
  On top-3 and top-5 the trivial heuristic is *much better* (65.6/88.0 vs
  48.4/54.2): as a shortlist generator, "sort by raw latency" beats the model.
- **The own-only GNN is worse than the trivial heuristic** on every metric.
- **Not a clear overall improvement over Stage 3.** Stage 3's 30% top-1 was on a
  different generator where the trivial baseline was 9.6% (3.1x lift); here the
  lift is 1.6x. The two generators are not comparable, so neither "improved"
  nor "regressed" is a valid claim.
- **Near-uniform collapse is not fixed**: 35.3% of test scenarios (vs 38.7% for
  Stage 3 on its own generator; within noise, different tasks).
- Cause of collapse is **unidentified**. Rejected: (a) tied nodes having
  identical input features (true for only 1% of collapsed cases), (b) dead-ReLU
  all-zero hidden vectors (0 cases). Not yet tried: skip-connecting the raw
  delta into the output logit, normalisation layers/LeakyReLU, log-scaling the
  (very small, ~1e-2..1e-3) input deltas.

Artifacts (gitignored): artifacts/model.pt (full), model_own.pt (ablation),
model_baseline.pt (Stage 3 model), full_run.log, own_run.log.

## Round 2 — fixing the uncertainty seen in interactive testing (index 600, severity 6)

Diagnosis of the reported failure: node 600 has one caller sending 0.05% of its
traffic to it, and a low baseline (0.67 ms). Deviation was measured in
*absolute milliseconds*, so its ~3 ms shift was dwarfed by any distractor on a
slow service (root's scaled signal 0.034 vs 1.0 for the strongest other node).
Over 60 draws the old model ranked it median #3 (top-1 15/60, top-5 31/60,
worst rank #398), so the single bad run was partly an unlucky draw.

Changes (all in src/ml-engine):
1. `fault_injection.py`: deviation is now **relative to each service's own
   normal** (observed/normal - 1) and scaled by a fixed constant, not a
   per-scenario max. `baseline_latency` removed from `ServiceGraph` (unused).
2. `graph_dataset.py`: dynamic features are log-scaled (`LOG_SCALE_K = 1000`)
   so faint ripples (~1e-4) stay visible.
3. `model.py`: `improved=True` (default) adds LayerNorm + LeakyReLU per block
   and a learnable linear skip from raw dynamic features to the output score.
   `improved=False` reproduces the Stage 3 architecture as a control.
   `train.py --arch improved|plain` selects it.
4. `fault_injection.py`: **background jitter** `JITTER_SIGMA = 0.10` on every
   node (fixed in advance). Added after a validity check, see below.
5. `predict.py`: builds the new model; status line no longer claims every node
   is "elevated" (jitter makes all nodes nonzero).

**Validity check that changed the plan.** The first improved run (no jitter)
scored 97.3% top-1 / 100% top-3, 0% collapse, and hit 87% after one epoch, which
was implausible. Evaluating that trained model on the same test scenarios with
jitter added (no retraining): 94.2% (sigma 0.001), 75.6% (0.01), 48.0% (0.05),
39.3% (0.10). Cause: with zero background noise, unaffected nodes read exactly 0,
so any faint caller ripple fingerprints the root perfectly. That score reflected
a too-clean simulator, not real localisation skill, and must not be reported
as model performance.

### Results on the jittered generator (450 test scenarios, same seed/split)

| Model                                    | top-1  | top-3  | top-5  | collapse |
|------------------------------------------|--------|--------|--------|----------|
| No model: highest raw deviation          | 22.2%  | 65.3%  | 91.8%  | n/a      |
| Plain architecture (Stage 3 arch)        | 33.6%  | 46.9%  | 52.9%  | 22.2%    |
| Improved architecture (LayerNorm+skip)   | 62.9%  | 91.8%  | 98.2%  | 0%       |

- The architecture change accounts for the gain (same data/generator/features):
  +29 points top-1 over the control; the control still loses to the no-model
  heuristic on top-3/5, the improved model beats it on all three.
- Index 600 / severity 6, 60 draws: median rank 2, top-1 26/60, top-3 51/60,
  top-5 57/60, worst rank #6 (was: top-1 15/60, top-5 31/60, worst #398).
- Accuracy depends on how much of a caller's traffic goes to the faulty
  service (top-1, severity 6, n=400 random roots): <1% coupling 41% (n=182),
  1-10% 68% (n=117), 10-50% 99% (n=69), >50% 100% (n=32). Weakly coupled
  services leave almost no trace elsewhere; this is an information limit of the
  signal, not a training failure.

Caveats: everything is synthetic. Distractor count/severity and jitter level are
my modelling assumptions (fixed before looking at results), so absolute numbers
say how well the model solves *this* simulator; the relative comparisons
(plain vs improved, own vs full features, vs no-model baseline) are the
reliable part. Not validated on real incidents. Earlier rows in this file
(Stage 3 baseline, Round 1 table) were measured on earlier generators and are
not comparable to these.

Artifacts (gitignored): model.pt = improved+jitter (used by predict.py);
model_plain.pt = plain control on the jittered generator; model_v2_noiseless.pt
= the too-clean 97% model; model_v1_full.pt / model_own.pt / model_baseline.pt
= earlier generators. Logs: *_run.log, *_jitter_run.log.
