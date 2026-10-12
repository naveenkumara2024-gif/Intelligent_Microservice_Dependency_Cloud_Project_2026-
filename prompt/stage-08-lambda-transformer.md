# Stage 8 — Lambda graph transformer (MSK spans -> Gremlin graph upserts)

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol"). Phases are approved separately: 8a (code, local
tests, free, **no AWS needed**) and 8b (deploy and verify, billable, blocked by the
account issues below).

## Why this stage exists

Build-order item 8. Turns the stream of spans in Kafka (`otel.traces`, written by
Stage 7's collector as `otlp_json`) into the dependency graph: services as vertices,
calls as weighted directed edges. Stage 9 provides Neptune as the real target; this
stage builds and proves the transformation logic first, locally, and wires the
MSK -> Lambda path.

## Blockers (same account issues as Stage 7)

- **8b needs MSK** to exist, and the account is not subscribed to MSK
  (`SubscriptionRequiredException`). It also cannot create load balancers.
  Recheck for free: `aws kafka list-kafka-versions --region us-east-1`.
- **8a is unaffected**: everything runs on the workstation (Docker is installed:
  Docker 29.4.3 / Compose v5.1.4).

## Current state (verified)

- `src/lambda-transformer/` has only a bare `package.json`/`tsconfig.json`
  (TypeScript ^7, `@types/node`, CommonJS, `outDir: dist`); no source, no tests, no
  dependencies. `node_modules` exists but is empty of project deps.
- Stage 2 prototype schema (from `Dataset/load_to_neo4j.py`, `MERGE`-based, batched
  with `UNWIND`): `(:Service {name, total_calls_as_um, total_calls_as_dm})` and
  `(:Service)-[:CALLS {call_count, avg_latency_ms, p95_latency_ms, rpctype}]->(:Service)`.
  Names are hashed in the Alibaba data; in Online Boutique they are readable
  (`frontend`, `checkoutservice`, ...).
- Stage 3 model (`src/ml-engine/model.py`): `GATv2Conv` + 3 x `SAGEConv` + linear, **no
  node-ID embeddings**, so it is inductive and can in principle score any graph that
  supplies the same feature schema: 4 static node features (min-max of
  `total_calls_as_um`, `total_calls_as_dm`, in-degree, out-degree), per-node dynamic
  latency-delta features, and a 9-dim edge attribute (min-max `avg_latency_ms`,
  `p95_latency_ms`, log1p `call_count`, ...).
- `docker-compose.yml` runs only Neo4j 5 today.
- Stage 6/7: only 7 Online Boutique services emit spans (frontend, checkout, currency,
  email, payment, productcatalog, recommendation).

## Key design decisions (flag any you disagree with)

1. **Derive edges statelessly from CLIENT spans.** A CLIENT span carries the caller
   (resource `service.name`) and, in its attributes, the callee (`peer.service`, or
   `server.address` / `net.peer.name` with the port stripped) and the call latency
   (span duration). Deriving from CLIENT spans means each Kafka message is
   self-contained; the alternative (join a SERVER span to its parent CLIENT span via
   `parentSpanId`) needs cross-message state because parent and child arrive in
   different batches. Bonus: callees that emit no spans themselves (cart, shipping,
   ad) still appear as nodes with incoming edges, because the *caller* reports them.
   **Risk:** the exact attribute names the Boutique services emit are unverified (the
   cluster is down). Fixtures use plausible semconv names and the code tries several
   fallbacks; the first real capture in 7b/8b must confirm them, with the fallback
   being the stateful parent-join.
2. **Aggregate per Lambda batch before writing.** Group the batch's spans by
   (caller, callee), then issue one upsert per edge and per node — fewer writes and
   less contention (CLAUDE.md: batch writes, never one statement per row).
3. **Counters, not snapshots.** Streaming cannot reproduce Stage 2's batch aggregates
   exactly, so edges store `call_count`, `latency_sum_ms` (readers derive
   `avg_latency_ms = sum / count`), `latency_ewma_ms` (alpha 0.1, a "recent" signal),
   `latency_max_ms`, `last_seen_ms`, and a 10-bucket log-spaced latency histogram
   (`h0`..`h9`) from which readers estimate p95. Nodes store `total_calls_as_um` /
   `total_calls_as_dm` as in Stage 2. This is a deliberate contract change from Stage 2
   (`avg_latency_ms`/`p95_latency_ms` become derived), documented for Stage 9/10.
4. **Gremlin only, behind a small `GraphWriter` interface.** Implementations:
   `GremlinWriter` (Neptune and local Gremlin Server), and `LogWriter` (prints the
   upserts; used in 8b so the MSK -> Lambda path is provable before Neptune exists in
   Stage 9). No Cypher writer: Stage 2's Neo4j stays a reference, and the Gremlin
   logic is validated against a real local Gremlin Server instead (CLAUDE.md: Cypher
   is not Gremlin).
5. **Idempotent upserts** with the `coalesce(unfold(), addV/addE)` pattern. Counters use
   `property(single, k, union(values(k), constant(n)).sum())`. Note: Kafka delivery is
   at-least-once, so a retried batch double-counts; metrics are approximate and
   documented as such (exact dedup by span ID would need extra state; deferred).
6. **Concurrency**: parallel Lambda invocations updating the same edge can raise
   Neptune `ConcurrentModificationException`; the writer retries with jittered backoff,
   and the event source mapping's concurrency is capped low (e.g. 2).
7. **Local test target**: Apache TinkerPop Gremlin Server in Docker, added to
   `docker-compose.yml` under a `gremlin` profile so `docker compose up neo4j` is
   unchanged.
8. **Bundling**: esbuild to a single `dist/index.js` (Node 22 runtime); CDK uses
   `Code.fromAsset`. Chosen over `NodejsFunction` to avoid CDK needing Docker/esbuild at
   synth time (keeps `cdk synth` credential- and Docker-free).
9. **Neptune auth**: the writer supports IAM (SigV4) and unauthenticated via a flag;
   which one Neptune uses is a Stage 9 decision.
10. **Where it deploys**: a new `TransformerStack` (Lambda in the private-app subnets,
    event source mapping on MSK `otel.traces`, batch window ~5 s, starting position
    LATEST, low max concurrency, CloudWatch log group with 1-week retention). Depends on
    `VpcStack` and `MskStack`. Until Stage 9, it runs with `GRAPH_BACKEND=log`.

## Phase 8a — Code and local validation (no AWS, no cost)

| File | Change |
|---|---|
| `src/lambda-transformer/package.json` | Scripts (`build` via esbuild, `test`), deps: `gremlin`; dev deps: `esbuild`, `jest`, `@swc/jest`, `@types/jest`. |
| `src/lambda-transformer/src/otlp.ts` | Types + parser for the `otlp_json` message (Kafka record value). |
| `src/lambda-transformer/src/edges.ts` | CLIENT spans -> `(caller, callee, latency)`; attribute fallbacks; port stripping; skips malformed spans without throwing. |
| `src/lambda-transformer/src/aggregate.ts` | Batch aggregation (counts, sum, max, ewma, histogram, node counters). |
| `src/lambda-transformer/src/writers/` | `GraphWriter` interface, `GremlinWriter`, `LogWriter`. |
| `src/lambda-transformer/src/handler.ts` | MSK event (base64 record values grouped by topic-partition) -> parse -> aggregate -> write; reports counts; never fails the batch on a single bad record. |
| `src/lambda-transformer/test/` | Unit tests with synthetic fixtures; integration test against local Gremlin Server. |
| `docker-compose.yml` | Add `gremlin-server` under the `gremlin` profile. |
| `infra-cdk/lib/transformer-stack.ts`, `bin/app.ts`, tests | The stack and tests (synth-only in 8a). |
| `CLAUDE.md` | Status, structure, the contract change. |

Fixtures are **synthetic** (hand-written to the OTLP JSON shape and labelled as such);
they are not captured Online Boutique traffic.

Local validation commands:

```bash
cd src/lambda-transformer && npm ci && npm test && npm run build
docker compose --profile gremlin up -d gremlin-server
npm run test:integration          # real Gremlin Server
cd ../../infra-cdk && npx tsc && npx jest && npx cdk synth
```

### Checkpoint 8a

1. Unit tests pass: edge derivation incl. attribute fallbacks, port stripping,
   malformed/empty input, aggregation arithmetic, histogram bucketing.
2. Integration test against a real local Gremlin Server: running the same batch twice
   yields the expected vertices/edges (no duplicate vertices or edges: idempotent
   upsert), counters add correctly across batches, and property names match the
   contract.
3. `esbuild` bundle builds; `cdk synth` for all stacks succeeds with no cycles;
   `TransformerStack` tests pass.

## Phase 8b — Deploy and verify (separate approval; billable; BLOCKED)

Needs: MSK subscription cleared, `VpcStack` + `MskStack` + `EksStack` deployed, collector
on the Kafka overlay (Stage 7b passed). User runs `cdk deploy` (the permission
classifier blocked my own deploy commands earlier; scripts that only call
AWS/kubectl have run fine).

```bash
npm run deploy:transformer        # preflight + cdk deploy TransformerStack
npm run verify:transformer
```

Checkpoint 8b: the event source mapping is `Enabled`; CloudWatch shows the Lambda
invoked with no errors; `LogWriter` output shows real edges derived from live Boutique
spans (e.g. `frontend -> productcatalogservice`), which also confirms or corrects the
attribute-name assumption in decision 1. Teardown right after.

## Estimated cost while running

Lambda and logs at demo volume are cents. Dominated by what it needs running:
EKS + MSK + NAT/endpoints, about $0.47/hr (about $11/day). Destroy right after the
checkpoint.

## Known gotchas

- Lambda attached to a VPC reaches the MSK cluster through the private-app subnets and
  needs outbound access (NAT, already present) for the event source mapping.
- MSK's security group (Stage 7) allows TCP 9094 from the private-app subnets; the Lambda
  must run in those subnets or the poller cannot connect.
- The Lambda execution role needs the MSK/ENI permissions (managed
  `AWSLambdaMSKExecutionRole` is the starting point) and, later, Neptune access; roles
  stay in the stack that owns the function (Stage 5 decision 8).
- Online Boutique's `loadgenerator` and the services' internal calls produce high span
  volume; batch size and window are tuned to keep each invocation small.

## Heads-up for Stage 10 (not in scope here)

The GNN is inductive, but its inputs are normalized against the **Alibaba** graph's value
ranges and its latency-delta feature assumes a per-edge baseline. Scoring the live
Boutique graph will need either re-derived normalization constants plus a baseline
tracker, or a short retrain on a Boutique-shaped synthetic graph. Stage 8's stored
counters (sum, ewma, histogram) are chosen so both options stay open.

## Explicitly out of scope

- Neptune itself (Stage 9) and SageMaker inference (Stage 10).
- Exact exactly-once counting, SigV4 decisions, DLQ / replay tooling.
- Metrics or logs signals; only traces.
- Commit/push: separate approvals after each checkpoint.

---

## Phase 8a as built (2026-10-09) — deviations from the plan above

- **Gremlin client pinned to `gremlin@3.7.3`, not the npm default 3.8.2.** Neptune's docs list
  TinkerPop 3.7.1-3.7.3 for engine >= 1.3.2.0 and warn that a mismatched client "can result in
  connection failures". The local server image is `tinkerpop/gremlin-server:3.7.3` for the same
  reason. The client ships no type declarations, so `src/gremlin.d.ts` declares the module and all
  use is confined to `src/writers/gremlin.ts`.
- **Stored edge properties changed from decision 3:** the EWMA and max latency were dropped
  (computing them in Gremlin needs `math()` / read-modify-write, and Neptune's support was not
  verified). Edges store `call_count`, `latency_sum_ms`, `latency_recent_avg_ms` (this batch's mean,
  overwritten), `last_seen_ms` and the sparse histogram `h0`..`h9`. Nodes store
  `total_calls_as_um` / `total_calls_as_dm`. `estimateP95()` in `aggregate.ts` is the reader helper.
- **A real server caught a bug mocks could not:** `property(single, ...)` is rejected on edges
  ("Property cardinality can only be set for a Vertex"). Vertex counters keep `single`; edge
  properties pass no cardinality. A unit test now asserts no edge property step carries one.
- **Node upserts use `mergeV`; edge upserts use `coalesce(inE, addE)`** with the endpoints looked up
  by name; a whole chunk (20) is one request. Counters are `union(values(k), constant(n)).sum()`.
- **Bundle**: `npm run build` (esbuild, 620 KB, handler export `handler`). `TransformerStack` uses a
  placeholder inline function plus a CDK warning when the bundle is missing, so a fresh checkout
  still synthesizes; `deploy:transformer` builds the bundle first.
- **Trigger**: `ManagedKafkaEventSource` (L2), unauthenticated cluster so no secret; batch 100 / 5 s,
  `LATEST`, 3 retries, 1 h max record age. No reserved concurrency (a new account's quota is low);
  parallelism is bounded by the topic's 3 partitions.
- **8b cost note:** `cdk deploy TransformerStack` also deploys its dependencies `VpcStack` and
  `MskStack` (about $0.09/hr for the VPC plus MSK at about $0.09/hr), and the live checkpoint also
  needs EKS and the collector on the Kafka overlay (about $0.47/hr total).

### 8a checkpoint results

- `src/lambda-transformer`: `tsc --noEmit` clean; **77/77 unit tests** (otlp, edges, aggregate,
  handler, offline Gremlin traversal structure); `npm run build` bundles and the bundled handler
  ran end to end against the log writer.
- **6/6 integration tests against a real TinkerPop Gremlin Server 3.7.3** (Docker): documented
  properties, idempotent structure over repeated writes, additive counters across batches, a service
  as both caller and callee, a batch over one chunk (45 edges), and base64 event -> handler -> graph.
- `infra-cdk`: **32/32 tests** (9 new `TransformerStack` tests); full `cdk synth`, 8 stacks, no cycles.
- `verify:transformer` fails cleanly when nothing is deployed. Nothing was deployed to AWS.

### Not proven (needs real services)

- The attribute names Online Boutique's spans actually carry (fixtures are synthetic).
- Neptune-specific behaviour: concurrent-modification retries, SigV4 (refused until Stage 9),
  and whether `property(key, traversal)` on edges behaves the same (TinkerGraph is not Neptune).
- The MSK event source mapping delivering real records, and Kafka redelivery double-counting.
