# Stage 11 — DynamoDB incident persistence (and the scorer that produces incidents)

Status: **APPROVED 2026-10-13 (full scope: table + scorer). Phase 11a COMPLETE (local) and Phase 11b
VERIFIED LIVE (2026-10-13): 11b-i 13/13, 11b-ii 22 PASS / 0 FAIL / 0 WARN. See "Phase 11a as built"
and "Phase 11b as run" at the end. Teardown of the 11b-ii stack set is the user's step.**

## Why this stage, and what it really contains

Build-order item 11. A table alone would be ten lines of CDK and would prove nothing: nothing
produces incidents yet. Two earlier stages hand work to this one explicitly:

- Stage 10 (CLAUDE.md): `own_delta` = observed/normal - 1 per service "needs a baseline tracker and
  belongs to the Stage 11 scorer Lambda".
- Stage 10 prompt: "scorer Lambda: Neptune snapshot -> endpoint -> DynamoDB -> SNS belongs with
  Stages 11-12".

So Stage 11 = **the incident store + the scorer Lambda that reads the live graph, calls the
endpoint, decides whether there is an incident, and persists it.** Stage 12 adds only the SNS
publish on top. If you would rather have the table alone, say so; that is the "small" variant at
the end.

## Current state (verified 2026-10-13, read-only)

- `infra-cdk/lib/dynamodb-stack.ts` is an empty stub, already instantiated in `bin/app.ts`.
- **All billable stacks are destroyed** (`list-stacks`: only `CDKToolkit`; no SageMaker endpoint).
  Budget alert exists (`My Monthly Cost Budget`, $50).
- Existing building blocks the scorer reuses:
  - Graph contract in Neptune (`src/lambda-transformer/src/writers/gremlin.ts`): vertices
    `Service{name, total_calls_as_um, total_calls_as_dm}` (cumulative); edges
    `CALLS{call_count, latency_sum_ms, latency_recent_avg_ms, last_seen_ms, h0..h9}` (cumulative
    counters, additive). **No `rpctype` is stored on streamed edges.**
  - `estimateP95(hist)` and `BUCKET_BOUNDS_MS` in `aggregate.ts`.
  - A hardened Gremlin client (`GremlinWriter`: SigV4 handshake, `useNodeWebSocketLibrary()`,
    re-sign on reconnect). These cost nine live defects to get right; the scorer must reuse them,
    not re-implement them.
  - Endpoint `rca-root-cause` (serverless) and its request/response contract (Stage 10).
  - VPC: DynamoDB **gateway** endpoint and `sagemaker.runtime` **interface** endpoint exist
    (`vpc-stack.ts`); Neptune SG already allows 8182 from the private-app CIDRs.
- Model facts that drive the detection rule: trained faults were **3x-10x latency (own_delta 2-9)**;
  the output is a **softmax over nodes, so it names a "root cause" even when nothing is wrong**.
  Shipped weights: Boutique top-1 65.5% / top-3 98.7% on *synthetic* scenarios only.

## Key design decisions (flag any you disagree with)

1. **Detection is gated on evidence, not on the model alone.** An incident is only considered when
   at least one service has `own_delta >= 1.0` (2x its baseline latency; deliberately below the
   2-9 trained range) in the window. Otherwise the softmax would open an incident every minute on a
   healthy system. The gate and thresholds are constants in one file, covered by tests.
2. **Windowed deltas, not cumulative counters.** Neptune counters only grow, so each scorer run
   stores the previous cumulative snapshot and works on the difference. Window average latency per
   edge = d(latency_sum)/d(call_count); window p95 = `estimateP95` of the histogram difference.
   A counter that went *down* (graph cleared / parity reload) means "reset": re-snapshot, skip
   the window, never produce a negative delta.
3. **`own_delta` and baseline.** A service's own latency in a window = call-count-weighted mean of
   the window average latency of the edges *into* it. Baseline per service = EWMA (alpha 0.1) of
   that value, **updated only from windows in which the service is not itself anomalous and has
   >= 20 calls**, so a fault does not teach the baseline that slow is normal. Detection is
   suppressed until a service has >= 5 baseline windows. `own_delta = max(0, window/baseline - 1)`.
   Known limit: a fault already present when the scorer first starts poisons that baseline.
4. **Edge features sent to the endpoint.** `call_count` and node totals = **cumulative** (they are
   min-max normalised inside the graph, and training used totals); `avg_latency_ms` and
   `p95_latency_ms` = **window** values (fallback: cumulative average when the edge had no calls
   in the window); `rpctype` = `"rpc"` for every edge because the streaming graph does not store
   it (Boutique is gRPC/HTTP; a constant is honest and tested, a guess per edge would not be).
5. **Incident lifecycle with hysteresis.** Keyed by root-cause service; one OPEN incident per
   service. A service is *implicated* in a window when the gate holds and it is the endpoint's
   top-1 candidate. Open after **2 consecutive** implicated windows; update `last_seen`,
   `peak_score`, evidence on every implicated window; resolve after **3 consecutive** windows in
   which it is not implicated. Which incidents are open lives in the scorer state item (a
   consistent read), not in a GSI query (eventually consistent), so a lagging index cannot cause a
   duplicate incident.
6. **Blast radius** = transitive *callers* of the root cause (graph ancestors) that are themselves
   anomalous; `at_risk` = all transitive callers. Computed from the same snapshot, not a second
   query.
7. **Two tables.** `rca-incidents` (the dashboard's data, TTL) and `rca-scorer-state` (one item:
   previous counters, baselines, open-incident map, hysteresis counters; optimistic `version`
   attribute so two overlapping runs cannot both commit; the loser skips its window).
8. **`rca-incidents` shape.** PK `incident_id` (`<opened_at_ms>-<service>`). GSI `by-status`
   (`status`, `opened_at_ms`) for "open incidents / recent incidents" and GSI `by-service`
   (`root_cause`, `opened_at_ms`). TTL attribute `expires_at` (epoch seconds, 30 days after the
   last update; refreshed while open). On-demand billing. **Customer-managed KMS key with rotation
   in this stack** (Stage 5 convention: keys live with the resource; CLAUDE.md "KMS encryption at
   rest"). `RemovalPolicy.DESTROY` (teardown convention) and **no PITR** (it would outlive the
   table's purpose and costs); both are reversible, say if you want PITR on.
   Item fields: `schema_version, incident_id, status OPEN|RESOLVED, root_cause, opened_at_ms,
   last_seen_ms, resolved_at_ms?, score, peak_score, ranking[top 5], blast_radius[], at_risk[],
   evidence{service: {own_delta, window_avg_ms, baseline_ms, calls}}, windows, model_version,
   expires_at`.
9. **Scorer = a third bundle of `src/lambda-transformer`** (`dist/scorer.js`, handler
   `scorer.handler`), like the Stage 9 probe, so it reuses the hardened Gremlin client instead of
   copying it. Pure logic (delta, baseline, gate, lifecycle, blast radius) is separate from I/O so
   it is unit-testable without AWS. The AWS SDK v3 clients for DynamoDB and SageMaker Runtime are
   added as pinned dependencies and bundled.
10. **New `ScorerStack`** (Lambda in private-app, EventBridge `rate(1 minute)`, 512 MB, 60 s,
    log retention 1 week). Least-privilege role: `neptune-db:ReadDataViaQuery` on the cluster,
    `sagemaker:InvokeEndpoint` on the one endpoint ARN, read/write on the two tables only. It is
    separate from `DynamodbStack` so the table can be deployed and verified alone for pennies, and
    from `TransformerStack` because that one requires MSK. Dependencies: VPC, Neptune, DynamoDB.
    The endpoint is referenced by its constant name/ARN (SagemakerStack stays independent, as
    decided in Stage 10).
11. **Train/serve contract is pinned from both sides.** The TypeScript tests write a golden request
    JSON; a pytest in `src/ml-engine/tests` feeds the same file through `inference.input_fn`, so
    a drift in field names, rpctype or top_k fails locally, not in a live session.
12. **Live proof without waiting for Stage 14.** There is no fault-injection tooling yet, so 11b
    adds a probe action `degrade` that inflates the latency counters of the edges into one service
    in Neptune. That tests the scorer, the lifecycle and persistence against the real graph and
    real endpoint; it does **not** show the model finds real faults (still synthetic, Stage 14).

## Phase 11a — Code and local validation (no AWS, no cost)

| File | Change |
|---|---|
| `src/lambda-transformer/src/scorer/{window,baseline,detect,lifecycle,blast,contract}.ts` | Pure logic: deltas/reset handling, own_delta + baseline, gate, hysteresis, blast radius, request builder. |
| `src/lambda-transformer/src/scorer/{graph,store,endpoint}.ts`, `src/scorer.ts` | I/O: Gremlin snapshot read, DynamoDB state + incident writes (conditional), SageMaker invoke, handler. |
| `src/lambda-transformer/test/scorer-*.test.ts` | Unit tests; golden request fixture; integration test against Gremlin Server + DynamoDB Local. |
| `src/ml-engine/tests/test_scorer_contract.py` | Golden request from TS accepted by `inference.input_fn`. |
| `docker-compose.yml` | `dynamodb-local` service, profile `dynamodb`. |
| `infra-cdk/lib/dynamodb-stack.ts` | Tables, GSIs, TTL, CMK, outputs. |
| `infra-cdk/lib/scorer-stack.ts`, `bin/app.ts` | Lambda, schedule, least-privilege role, outputs. |
| `infra-cdk/test/{dynamodb,scorer}-stack.test.ts` | TTL attribute, GSIs, PAY_PER_REQUEST, CMK, role scope (no `*`), schedule, placeholder path. |
| `infra-cdk/scripts/{verify-dynamodb,verify-incidents}.ts`, `package.json` | `deploy:dynamodb`, `verify:dynamodb`, `deploy:scorer`, `verify:incidents`, destroy scripts. |
| `src/lambda-transformer/src/probe-actions.ts` | `degrade` action (live proof only; refuses names outside a given service list). |
| `CLAUDE.md`, `prompt/` | Status, as-built notes. |

Local commands:

```bash
cd src/lambda-transformer && npm test && npm run typecheck && npm run build
docker compose --profile gremlin --profile dynamodb up -d gremlin-server dynamodb-local
npm run test:integration
cd ../ml-engine && python -m pytest tests -q
cd ../../infra-cdk && npx tsc && npx jest && npx cdk synth
```

### Checkpoint 11a

1. Window/baseline logic: counter reset, empty window, no incoming edges, fault not absorbed into
   baseline, warm-up suppression, cold start all covered and green.
2. Lifecycle: 1 anomalous window opens nothing; 2 open; 3 clean resolve; a flapping signal does not
   spawn duplicates; two concurrent runs commit once (conditional write test on DynamoDB Local).
3. Integration: Gremlin Server seeded with a Boutique-shaped graph and degraded counters -> scorer
   (stub model = argmax own_delta) opens exactly one incident with the right root, blast radius and
   TTL, then resolves it; a healthy graph opens nothing across 10 windows.
4. Golden request passes `inference.input_fn`; pytest and Jest both green.
5. `cdk synth` for all stacks, no cycles; stack tests green.

## Phase 11b — Live (separate approval; billable)

As on earlier stages, the auto-mode classifier blocks my own `cdk deploy`/`destroy`, so you run
those; I run verify scripts and read-only calls.

**11b-i, table only (cents):**

```bash
cd infra-cdk
npm run deploy:dynamodb && npm run verify:dynamodb && npm run destroy:dynamodb
```

Checks: both tables ACTIVE, on-demand, CMK-encrypted; TTL attribute enabled (`describe-time-to-live`
= ENABLED; actual expiry is lazy, up to 48 h, so it is verified as configuration, not deletion);
GSI query returns a written incident; the optimistic-version conditional write rejects a stale
writer; an item with `expires_at` in the past is filtered by the reader helper.

**11b-ii, the loop (about 2 h, roughly $1.5-3 of credits, same stack set as the earlier live
session):** VPC, EKS, MSK, Neptune, transformer, SageMaker, scorer. Order and teardown as in
`prompt/stage-07b-08b-09b-09c-live-session.md`; run `npx tsx scripts/pre-destroy.ts` first.

```bash
npm run verify:incidents   # healthy soak, degrade, resolve, assertions below
```

### Checkpoint 11b (each line with real output)

1. Healthy live Boutique for >= 10 windows: **zero incidents**; baselines exist for the services
   that receive calls.
2. `degrade` one service: an incident OPENs for it within 3 windows; the endpoint's top-1 is that
   service, or the result is reported honestly if not (the model is 65% top-1).
3. The persisted item matches the schema (blast radius, evidence, model_version, `expires_at`).
4. Stop degrading: the incident RESOLVES after 3 clean windows; no duplicate incidents.
5. CloudWatch shows the scorer invoked on schedule with no errors; scoring latency reported.
6. After destroy, CLI shows no tables, endpoint, or stacks left.

## Estimated cost

DynamoDB on-demand at this volume (60 reads/writes an hour) and one CMK ($1/month prorated,
7-day deletion window) are cents. Lambda at one invocation a minute is free-tier-scale.
The live loop reuses the ~$0.7/h stack set. I have not quoted a price from a live source; check
the pricing pages if it matters.

## Known gotchas / risks

- **Cold-start baseline poisoning** (decision 3) and the **window length**: with a 60 s schedule and
  low Boutique traffic (loadgen emits no spans), some edges see few calls per window. Services under
  20 calls in a window do not update baselines and cannot be implicated.
- **Kafka redelivery double-counting** (a Stage 8 accepted approximation) inflates counters but not
  averages materially; it cannot fake a latency spike.
- **Overlapping runs / retried schedule**: handled by the version check, tested.
- **Neptune IAM scope**: the scorer needs only `ReadDataViaQuery`; if the first live read is denied
  it will be because Neptune authorizes some read shape as another action (the Stage 9c surprise was
  `DeleteDataViaQuery`). I will read the denial, not widen to `*`.
- **Unproven until 11b:** SDK calls from inside the VPC via the gateway/interface endpoints, the
  scorer's Gremlin read shapes on real Neptune, and whether the window deltas on live Boutique
  traffic are stable enough that the healthy soak stays at zero incidents (the main false-positive
  risk; thresholds are constants so retuning is cheap).
- All labels the model learned are synthetic; Stage 11 results must not be written up as "finds real
  faults" (CLAUDE.md novelty framing).

## Explicitly out of scope

- SNS / Slack / PagerDuty (Stage 12). No DynamoDB Stream is enabled now; adding one later is an
  in-place table update.
- Dashboard and API Gateway (13); real fault injection in the cluster (14).
- Retraining or re-tuning the model; multi-incident correlation beyond one-per-root-cause.
- Alarms on scorer failures (a CloudWatch alarm belongs with Stage 12's alerting).
- Commit/push: separate approvals after the checkpoint.

## "Small" variant (if you want less)

Table + stack tests + `verify:dynamodb` (11b-i) only, with the incident schema and a pure
`IncidentStore` helper; no scorer, no Neptune/SageMaker coupling, no live loop. Cost: pennies. The
scorer then moves to the start of Stage 12.

---

## Phase 11a as built (2026-10-13)

Everything below ran for real on this workstation (Docker: TinkerPop Gremlin Server 3.7.3 and
`amazon/dynamodb-local:3.1.0`); nothing touched AWS except read-only `list`/`describe` calls.

### Checkpoint 11a results

| Plan item | Result |
|---|---|
| 1. window/baseline logic | PASS. Counter reset, vanished edge, idle edge, new edge, empty window, no baseline, cold baseline, thin window, latency floor, fault-not-absorbed (30 windows of a 6x fault leave the baseline at 10.0 ms) all covered. |
| 2. lifecycle | PASS. 1 window opens nothing; 2 open at the *first* window's time; flapping never opens; 3 clean resolve; root-cause flip opens one and resolves the other. **8 concurrent commits from one version on DynamoDB Local: exactly 1 wins and the 7 losers' incidents are not written.** |
| 3. integration | PASS. Counters written by the production `GremlinWriter` into Gremlin Server, scorer + stub model + DynamoDB Local: 6 warm-up + 6 healthy windows with the model never consulted, fault opens exactly one incident (root, evidence, `at_risk`, TTL = last_seen + 30 d), updated in place, resolved after 3 clean windows, queryable through both GSIs. (The 10-window healthy soak is in the unit tests; the integration soak is 6.) |
| 4. golden request | PASS on both sides: `test/fixtures/scorer-request.json` (Jest) is accepted by `inference.input_fn`/`predict_fn` (pytest) and its topology equals the Boutique fixture's. |
| 5. synth + stack tests | PASS. All 9 stacks synthesize, no cycles. |

Totals: lambda-transformer 184 unit + 27 integration; ml-engine 51 pytest; infra-cdk 149 jest.

### What was built (vs the file table)

- `src/lambda-transformer/src/scorer/`: `config` (every threshold), `schema` (table/key names, shared
  with the CDK stack), `types`, `window`, `baseline`, `request`, `blast`, `lifecycle` (pure);
  `run` (one cycle, all I/O injected), `graph`, `store`, `endpoint`, `handler` (I/O). Third esbuild
  bundle `dist/scorer.js` (1.9 MB, SDK v3 clients bundled at 3.1141.0, chosen as the newest release
  older than two weeks).
- `DynamodbStack` (two tables, two GSIs, TTL, CMK with rotation, DESTROY) and new `ScorerStack`
  (Lambda in private-app, `rate(1 minute)`, 512 MB / 60 s, retries 0). IAM is minimal and tested:
  `neptune-db:ReadDataViaQuery` on the cluster, `sagemaker:InvokeEndpoint` on one endpoint ARN,
  state `GetItem`+`PutItem`, incidents `PutItem`, the table key. No `*` apart from ENI actions.
- Probe action `degrade` (bounded: 1-2000 calls, 0-60 s latency; needs an existing incoming edge)
  reusing the production writer, so synthetic calls go through the same counters.
- Scripts: `verify-dynamodb.ts` (11b-i), `verify-incidents.ts` (11b-ii), `ddb-cli.ts`,
  `incidents-live.ts` (pure, 16 tests), npm scripts `deploy|verify|destroy:dynamodb`,
  `deploy:scorer`, `verify:incidents`, `destroy:scorer`. `docker-compose.yml` gained
  `dynamodb-local` (profile `dynamodb`).

### Deviations and decisions taken during the build

1. **State + incidents are one `TransactWriteItems`, not two writes.** The plan's version check made
   the loser skip; a transaction additionally makes "incident recorded" and "state says it exists"
   atomic. Tested for real on DynamoDB Local, and `verify-dynamodb.ts` repeats it on the real service.
2. **The open incident record lives in the scorer state tracker**, so updates and resolution are full
   `Put`s that cannot fail on a missing or TTL-expired item.
3. **Latency floor (new, 1 ms).** Ratios are taken against `max(baseline, 1 ms)`: sub-millisecond
   jitter is not an incident. Consequence found by the contract test: the fixture's
   `paymentservice` baseline is 0.694 ms, so a 6x slow-down reads as own_delta 3.16, not 5 (still past
   the gate of 1.0). Real Boutique span latencies are unknown until 11b; if they are sub-millisecond
   the gate is less sensitive than the nominal 2x. The floor is one constant.
4. **Graph read has a 10 s timeout and reconnects.** A warm Lambda's sockets are frozen between runs;
   after a thaw a connection can hang instead of failing, which would stall until the 60 s Lambda
   timeout. Tested with a fake that hangs.
5. **Live-script rehearsal**: `verify-dynamodb.ts` runs against DynamoDB Local when
   `AWS_ENDPOINT_URL_DYNAMODB` is set (13/13 PASS, KMS and stack-output checks skipped and said so),
   which retired the script's own bugs before any AWS spend. `verify-incidents.ts` could not be
   rehearsed (it needs Neptune and the Lambdas); its pure parts are unit-tested.
6. **Degrade sizing** targets the scorer's floor, not the raw baseline: synthetic calls are about 4x
   the real ones per window at about 7x max(baseline, 1 ms), so the window average lands near a 5x
   deviation (inside the trained 2-9). A first version overshot to delta 11 for sub-ms baselines;
   caught by its test.

### Not proven by 11a (what 11b is for)

- The scorer's `project(...)` Gremlin read on **real Neptune** (the shape `listEdges` uses is proven
  there; this one adds 14 modulators) and its IAM action (`ReadDataViaQuery` alone is assumed).
- SDK calls from inside the VPC to DynamoDB and the SageMaker endpoint; the cold-start path.
- Whether windows of real Boutique traffic are stable enough for the healthy soak to stay at zero
  incidents, and whether enough services get >= 20 calls/min to have baselines at all (loadgenerator
  emits no spans; only 7 services emit any). `verify-incidents.ts` fails with the scorer state and
  rates if no service qualifies.
- That the model finds real faults. The 11b slow-down is synthetic by construction.
- Customer-managed key behaviour with DynamoDB transactions (checked by `verify-dynamodb.ts`).

### Resume instructions for 11b

```bash
cd infra-cdk
npm run deploy:dynamodb && npm run verify:dynamodb && npm run destroy:dynamodb   # 11b-i, cents
# 11b-ii (about 2 h, credits): VPC, EKS, MSK, Neptune, transformer (-c graphBackend=neptune),
# deploy:workloads, deploy:sagemaker, deploy:scorer, then:
npm run verify:incidents          # -- --soak=10 --warm=20 --inject=10 to lengthen
```

Teardown: `destroy:scorer`, `destroy:transformer`, `destroy:neptune`, `destroy:msk`,
`destroy:eks`, `destroy:vpc`, `destroy:sagemaker`, `destroy:dynamodb`; run
`npx tsx scripts/pre-destroy.ts` first; then `verify:dynamodb -- --after-destroy` and
`verify:sagemaker -- --after-destroy`.

---

## Phase 11b as run (2026-10-13, live, us-east-1)

### 11b-i: tables alone (`npm run verify:dynamodb`), 13/13 PASS

Both tables ACTIVE and on-demand; both encrypted with the stack's customer-managed key (ARN equals the
stack output); `by-status` and `by-service` ACTIVE with `status`/`root_cause` + `opened_at_ms`; TTL
ENABLED on `expires_at` and absent on the state table; both index queries find the live incident and the
filter drops an expired-but-present item; first state commit exclusive, stale version rejected, and **a
transaction that loses the version race writes no incident** (on the real service). Tables empty
afterwards. Destroyed, `--after-destroy` 2/2, the CMK is `PendingDeletion`.

### 11b-ii: the full loop

Stack set: Vpc, Eks, Msk, Neptune, Sagemaker, Dynamodb deployed in one `cdk deploy` (about 30 min), then
`deploy:workloads`, then `TransformerStack ScorerStack -c graphBackend=neptune`.

| Checkpoint | Result |
|---|---|
| `verify:eks` | 4/4 (2 nodes / 2 AZs, 12 pods, collector 2/2, 7 services' spans) |
| `verify:msk` | 5/5 (200 messages from all 7 emitters) |
| `verify:sagemaker` | 6/6 (cold 10.5 s / warm 1.8 s, parity 9.9e-10) |
| `verify:transformer --window=4` | 5/5 (89 invocations, 8,895 spans, 4,407 calls) |
| `verify:live --window=4` | 8/8 (14 live edges, counters growing) |
| `verify:incidents` | **22 PASS, 0 FAIL, 0 WARN** (below) |

`verify:incidents` in detail:

- **First read on real Neptune worked first time**, with `neptune-db:ReadDataViaQuery` alone (no
  widening needed); the scorer committed state through the CMK every minute from its first run.
- **Healthy soak, 8 min, 8 runs, 0 model calls, 0 deviating windows, 0 incidents.** The false-positive
  risk this stage cared most about did not materialise on real Boutique traffic (6 services had warm
  baselines: productcatalog 0.35 ms, shipping 0.54, cart 1.39, adservice 1.12, currency 1.63,
  recommendation 2.27).
- **Injection** into `productcatalogservice` (949 real calls/min over 3 edges): 317 synthetic calls x
  7 ms per edge, 4x/min. **Incident opened after 3.2 min (windows=3)**, root cause = the degraded
  service at top-1 score 0.994, model `d77fda205a82`.
- Persisted item passed all 11 schema checks (identity, id = `<opened_at_ms>-<root_cause>`, ordered
  times, `windows >= 2`, scores, ranking, blast-radius subset of at-risk, evidence past the gate,
  model version, `expires_at` = last_seen + 30 d).
- **Exactly one incident**, updated in place (windows 2 -> 4); **resolved 4.0 min after the fault
  stopped**; no open incidents remain.
- No scorer errors. 17 runs: average 1,125 ms, max 9,201 ms (the cold model call); a healthy run is
  about 100 ms.

### What this does and does not show

- **Shows:** graph -> windowed deltas -> baselines -> endpoint -> hysteresis -> DynamoDB works end to
  end on real infrastructure, with no false positives on real traffic and one clean incident
  lifecycle. The IAM scoping (Neptune read-only, one endpoint ARN, minimal DynamoDB, the CMK) is
  sufficient.
- **Does not show:** that the model finds real faults. The slow-down was synthetic and hit one service
  only, so top-1 was close to "the one service that is slow", the easy case. Real cascades
  (checkout slow because payment is slow) are Stage 14.
- **`blast_radius` stayed empty**: the synthetic calls only touched edges into the target, so no
  caller was itself anomalous. The `at_risk` list (frontend, checkout, recommendation) is populated
  and the subset logic is tested locally, but a live non-empty blast radius needs a real ripple.
- **Latency regime**: real Boutique edge latencies are 0.3-2.3 ms, i.e. at or below the 1 ms floor
  for most services. A 2x slow-down of a 0.35 ms service (0.7 ms) cannot cross the gate by design;
  only slow-downs past about 2 ms register there. The floor is one constant in `scorer/config.ts`
  if Stage 14 shows it should be lower.
- **Traffic**: checkout, payment and email never got a baseline (not enough calls per window from
  loadgenerator), so they cannot be implicated at the current traffic level. Stage 14 needs more load
  or a checkout-heavy generator.
