# Stage 9 — Amazon Neptune (knowledge graph) and parity check against Stage 2

Status: **Phase 9a APPROVED and COMPLETE (2026-10-12)** — see "Phase 9a as built" at the end.
Phase 9b (deploy and verify, billable) needs its own approval and has NOT been run. Phase 9c
(live end-to-end through MSK) is **deferred** until the MSK subscription is fixed; see "Resume
protocol". Phases are approved separately (CLAUDE.md "Stage implementation protocol").

## Why this stage exists, and why it runs before 7b/8b

Build-order item 9: deploy Neptune and verify the live topology against Stage 2's Neo4j
prototype. Stages 7b and 8b are blocked (account not subscribed to MSK), but **Neptune does
not depend on MSK or EKS**: it needs only `VpcStack`. The user chose to continue with
Stage 9 now and to jump back to 7b/8b as soon as the subscription is fixed. Stage 9 is
therefore split so nothing is left unproven:

- **9a/9b (now):** Neptune, IAM auth, SigV4 in the writer, and a parity check, all
  without MSK. The graph is fed by a short-lived probe Lambda instead of the live stream.
- **9c (after 7b/8b):** flip the transformer to the Neptune backend and watch real
  Boutique spans become the live graph.

## Current state (verified 2026-10-12)

- `infra-cdk/lib/neptune-stack.ts` is an empty stub; `bin/app.ts` constructs it with no
  VPC and only `neptuneStack.addStackDependency(vpcStack)`.
- `aws-cdk-lib/aws-neptune` has **L1 constructs only** (`CfnDBCluster`, `CfnDBInstance`,
  `CfnDBSubnetGroup`, ...), so the stack uses those.
- Neptune API is reachable on the account (`describe-db-engine-versions`,
  `describe-db-clusters` return normally; no clusters exist). Engine versions listed up to
  `1.4.8.0`; orderable classes include `db.t4g.medium`, `db.t3.medium`, `db.serverless`.
  This does NOT prove cluster creation is allowed on the Free Tier plan (see risks).
- A cost budget exists (`My Monthly Cost Budget`, $50), so the CLAUDE.md "budget alert
  before Neptune" guardrail is met.
- `GremlinWriter` (`src/lambda-transformer/src/writers/gremlin.ts`) refuses `iamAuth`
  ("implemented in Stage 9"); `handler.getWriter` already reads `GREMLIN_URL` and
  `NEPTUNE_IAM_AUTH`. `TransformerStack` hard-codes `GRAPH_BACKEND=log`.
- Stage 2 data: `Dataset/processed/nodes.csv` (7,384 rows) and `edges.csv` (16,115 rows;
  columns `um,dm,call_count,avg_latency_ms,p95_latency_ms,rpctype`). Neo4j's `MERGE` keys an
  edge on `(um, dm)` only, so duplicate pairs with different `rpctype` collapse there; the
  parity check must use distinct `(um, dm)` pairs, not CSV row count.
- **Docker Desktop is not running right now** (Docker API unreachable). 9a's integration
  tests need it started; unit and infra tests do not.

## Key design decisions (flag any you disagree with)

1. **Provisioned `db.t4g.medium`, one writer by default; read replica behind a prop**
   (`readReplica`, default `false`). CLAUDE.md's target is writer in AZ-1 plus replica in
   AZ-2; the replica doubles instance cost and adds nothing to verification. The subnet
   group still spans both private-data AZs. Enable the replica for the final demo.
   Alternative considered: `db.serverless` (no idle floor to reason about), rejected for
   now because a minimum capacity still bills and provisioned is simpler to tear down.
2. **IAM database authentication ON.** Resolves Stage 8 decision 9. The writer signs the
   WebSocket handshake with SigV4 (`@smithy/signature-v4`; credentials from the Lambda
   environment). Security group (8182 from the private-app subnets, same pattern as MSK) is
   the second layer. Cannot be fully proven locally (the local Gremlin Server has no IAM), so
   the signer is unit-tested with fixed credentials and time, and live-proven in 9b.
3. **Encryption at rest with a customer-managed KMS key**, created in `NeptuneStack`
   (Stage 5 decision: keys live with the consuming stack). `RemovalPolicy.DESTROY`
   (KMS schedules deletion after its waiting period).
4. **Teardown safety:** CloudFormation's default for a Neptune cluster is to take a final
   snapshot on delete. Set `DeletionPolicy: Delete`, `deletionProtection: false`,
   `backupRetentionPeriod: 1`, so `destroy:neptune` leaves no billable snapshot.
5. **Private only.** Cluster and instances in `private-data` subnets, no public access,
   ingress TCP 8182 only from the private-app subnet CIDRs. The workstation cannot reach it
   (by design), so verification goes through a probe Lambda, not a bastion/EKS pod.
6. **Probe Lambda lives in `NeptuneStack`** (private-app subnets, role scoped to
   `neptune-db:*` on this cluster only, reuses the Stage 8 esbuild bundle via a second entry
   `probe.js`). It is a verification tool and is destroyed with the stack. Actions:
   `status`, `unsigned` (expects rejection), `smoke`, `concurrency`, `load` (rows from the
   payload), `stats`, `clear`.
7. **Transformer wiring is a deploy-time switch, not hard-coded.** `TransformerStack` reads
   CDK context `graphBackend` (`log` default, `neptune`). With `neptune` it sets
   `GRAPH_BACKEND=gremlin`, `GREMLIN_URL`, `NEPTUNE_IAM_AUTH=true`, the `neptune-db`
   policy and the SG ingress. Default stays `log`, so 8b can still be run first without
   dragging Neptune into its deploy and cost.
8. **Contract unchanged.** Neptune stores the Stage 8 contract (`call_count`,
   `latency_sum_ms`, `latency_recent_avg_ms`, `last_seen_ms`, `h0..h9`; nodes
   `total_calls_as_um/dm`). The Stage 2 `avg_latency_ms`/`p95_latency_ms` appear in the
   parity load only, as plain properties (documented), because Stage 2 data is already
   aggregated and cannot be replayed through the streaming writer.

## Phase 9a — Code and local validation (no AWS, no cost)

| File | Change |
|---|---|
| `src/lambda-transformer/src/writers/sigv4.ts` | SigV4 signer for the Gremlin WebSocket handshake (pure function of host, region, credentials, time). |
| `src/lambda-transformer/src/writers/gremlin.ts` | `iamAuth` builds signed headers per connection instead of throwing; region from `AWS_REGION`. |
| `src/lambda-transformer/src/probe.ts` (+ `build` entry) | Probe Lambda actions listed in decision 6; pure logic split out so it is unit-testable with a fake writer. |
| `src/lambda-transformer/package.json` | Add `@smithy/signature-v4`, `@aws-crypto/sha256-js`; `build` emits `dist/index.js` and `dist/probe.js`. |
| `infra-cdk/lib/neptune-stack.ts` | KMS key, subnet group, SG, cluster (IAM auth, encrypted, parameter group), writer instance, optional replica, probe Lambda, outputs (endpoint, resource id, probe name). |
| `infra-cdk/lib/transformer-stack.ts`, `bin/app.ts` | Pass `vpc` to `NeptuneStack`; `graphBackend` context switch (decision 7). |
| `infra-cdk/scripts/verify-neptune.ts` | AWS-CLI based checkpoint (see 9b). Pure CSV-to-expected-graph logic exported and unit-tested. |
| `infra-cdk/package.json` | `deploy:neptune` (preflight + build bundle + `cdk deploy NeptuneStack`), `verify:neptune`, `destroy:neptune`. |
| `infra-cdk/test/neptune-stack.test.ts` | Stack assertions (below). |
| `CLAUDE.md` | Status, build-order note, Stage 9 section, the 7b/8b/9c resume note. |

Neptune engine version is pinned explicitly (not the default). Before choosing, re-check
the Neptune release notes for which TinkerPop series the `1.4.x` engines run; Stage 8 pinned
the client to 3.7.3 based on the docs for >= 1.3.2.0 and a mismatch "can result in
connection failures". If 1.4.x is not on 3.7.x, pin the newest engine that is.

Local validation commands:

```bash
cd src/lambda-transformer && npm ci && npm test && npm run build
# start Docker Desktop first, then:
docker compose --profile gremlin up -d gremlin-server
npm run test:integration            # must still be 6/6 with the SigV4 change
cd ../../infra-cdk && npx tsc && npx jest && npx cdk synth
```

### Checkpoint 9a

1. Unit tests: SigV4 headers match a fixed known-answer vector (credentials/time pinned);
   `iamAuth: true` no longer throws and passes headers; probe actions behave with a fake
   writer; CSV -> expected distinct nodes/edges/degrees logic (collapses duplicate
   `(um, dm)`).
2. Integration tests against the real local Gremlin Server still pass (no regression from
   the writer change).
3. `NeptuneStack` assertions: cluster encrypted with the CMK; IAM auth enabled; subnet
   group uses only private-data subnets; not publicly accessible; SG allows only 8182 from
   private-app CIDRs; `DeletionPolicy: Delete` and `DeletionProtection: false`;
   `BackupRetentionPeriod: 1`; replica present only when `readReplica` is true; probe role
   limited to this cluster; engine version pinned.
4. `TransformerStack` tests cover both `graphBackend` values; full `cdk synth` for all
   stacks, no cycles.

## Phase 9b — Deploy and verify (separate approval; billable)

Needs only `VpcStack` + `NeptuneStack` (no EKS, MSK, or collector). User runs the
`cdk deploy` (the permission classifier blocked my own deploy commands earlier; scripts that
only call AWS/kubectl have run fine). Order:

```bash
npm run deploy:neptune        # preflight + bundle + cdk deploy (also deploys VpcStack)
npm run verify:neptune
npm run destroy:neptune
npm run destroy:vpc
```

### Checkpoint 9b (each line shown with real output)

1. Cluster `available`, KMS-encrypted, IAM auth enabled, instance `available`, in
   private-data subnets, not publicly accessible; `status` probe reports healthy.
2. **Unsigned request is rejected** (proves IAM auth is enforced, not just configured);
   signed request via the real `GremlinWriter` succeeds.
3. **Neptune-specific behaviour Stage 8 could not prove:** the same synthetic batch written
   twice gives the expected vertices/edges (idempotent) and additive counters; N parallel
   probe invocations hitting one edge end with the exact expected `call_count` (the
   `ConcurrentModification` retry path works); `property(key, traversal)` on edges works.
4. **Parity vs Stage 2:** load a deterministic subset of `edges.csv` (top 2,000 distinct
   `(um, dm)` pairs by `call_count`, plus their endpoint nodes; `--full` loads everything).
   Compare against the same subset computed from the CSV, and against Neo4j if it is up:
   node count, distinct edge count, per-node in/out degree (all nodes), `call_count` sum,
   and the top-10 edges by `call_count` (the Stage 2 Part-B verification query).
5. Teardown: after `destroy:neptune`, CLI shows no cluster, no instance, no cluster
   snapshot; after `destroy:vpc`, no VPC.

Pass means every item above prints OK. Anything not run is reported as not run.

## Phase 9c — Live end-to-end (DEFERRED; needs 7b and 8b)

Only after MSK is available: 7b passes, 8b passes with `graphBackend=log`, then redeploy
`TransformerStack -c graphBackend=neptune`. Checkpoint: Boutique load -> collector -> MSK ->
Lambda -> Neptune; the probe `stats` action shows `frontend -> *` edges with growing
`call_count`; also confirms or corrects the CLIENT-span attribute-name assumption (Stage 8
decision 1). Needs EKS + MSK + NAT + Neptune, roughly $0.6-0.8/hr; destroy right after.

## Resume protocol (the user's standing instruction)

The user will say when the MSK subscription is fixed. On that message, before anything
else, I will: (1) run the free recheck `aws kafka list-kafka-versions --region us-east-1`;
(2) stop Stage 9+ work and go back to **Stage 7b**, then **8b**, each with its own
approval, each followed by teardown; (3) then run **9c**; (4) only then continue to
Stage 10. Until then Stages 10+ are not started, and CLAUDE.md records 7b/8b as pending.

## Estimated cost while running (9b)

Neptune `db.t4g.medium` roughly $0.07-0.10/hr per instance (confirm on the pricing page
before deploying; not quoted from a live source), plus the VPC about $0.09/hr (NAT and
interface endpoints), plus storage/I/O at cents for this data size, plus Lambda cents. A 9b
session of 1-2 hours is therefore on the order of a few tenths of a dollar. Destroy right
after the checkpoint.

## Known gotchas / risks

- **Free Tier plan restrictions surface at create time.** EC2 types, load balancers and MSK
  were each only discovered by attempting them. Neptune may be restricted too; the likely
  failure is a CloudFormation `CREATE_FAILED` that rolls back at no cost. If so, stop and
  report; do not work around it.
- Neptune IAM auth ARN uses the cluster **resource id** (`cluster-XXXX`), not the
  identifier: `arn:aws:neptune-db:us-east-1:<acct>:<resourceId>/*`.
- Neptune does not support all of TinkerPop; `mergeV`/`coalesce` upserts and
  `union(values, constant).sum()` are exactly what 9b exercises against the real engine.
- Lambda in a VPC needs no internet for SigV4 (credentials come from its environment), but
  the probe stays in private-app so the Neptune SG rule is the same one the transformer will
  use.
- Neo4j parity needs Neo4j running (`docker compose up -d neo4j`, Docker Desktop on). If it
  is off, the CSV-derived expectation is the baseline and the output says so.
- Neptune writes are at-least-once under Kafka redelivery (Stage 8 known limitation); not
  changed here.

## Heads-up for Stage 10 (unchanged)

The GNN is normalized against the Alibaba graph; scoring Boutique needs re-derived
normalization constants plus a baseline tracker, or a short retrain. The sum/histogram
counters stored here keep both options open. Stage 10 also needs a read path from SageMaker
to Neptune (the read replica is useful there).

## Explicitly out of scope

- SageMaker inference (Stage 10), DynamoDB (11), API Gateway reading Neptune (13).
- Neptune Analytics, bulk loader from S3, Streams, global database.
- Making Neptune reachable from the workstation (no bastion, no public endpoint).
- Commit/push: separate approvals after each checkpoint.

---

## Phase 9a as built (2026-10-12) — deviations and corrections to the plan above

**Corrections to "Current state":**

- Stage 2's `edges.csv` has **no duplicate `(um, dm)` pairs**: 16,115 rows are 16,115 distinct
  edges (the Neo4j count agrees). 235 are self-loops (`um == dm`), all endpoints exist in
  `nodes.csv`, and there are no nulls. The "collapse duplicates" logic is kept (it is Stage 2's
  documented MERGE semantics and is unit-tested) but nothing in the real data exercises it.
- Engine **1.4.8.0's release page documents Gremlin 3.7.1 as both earliest and latest**, while the
  general compatibility table lists 3.7.1-3.7.3 for >= 1.3.2.0. The client stays at `gremlin@3.7.3`
  (inside the table range, same minor series). **Unproven until 9b**; if the signed connection or
  the smoke test fails with a protocol error, the fallback is pinning the client to 3.7.1.

**Deviations from the file table:**

- No cluster parameter group (nothing needed one). Added `lib/lambda-bundle.ts` (shared
  `BUNDLE_DIR`, avoids a circular import between the two stacks), `src/probe-actions.ts` (graph
  operations shared by the probe and the integration tests), `scripts/neptune-parity.ts` and
  `scripts/neo4j-baseline.ts` (pure parity logic and the Neo4j reader, both unit-tested).
- Signing uses `@smithy/signature-v4` with `applyChecksum: false`: the default adds an S3-style
  `x-amz-content-sha256` header that Neptune's flow does not sign. The headers are
  `host`, `x-amz-date`, `x-amz-security-token`, `authorization`, handed to
  `DriverRemoteConnection(url, { headers })` as in AWS's Gremlin JavaScript IAM guide.
- `GremlinWriter` under IAM opens its connection on **first use** (signing is async) and
  re-opens it with a fresh signature after a lost socket; `source` throws a clear error before
  the first connection, `connectedSource()` is the async accessor.
- Probe actions: `status`, `unsigned`, `smoke`, `concurrency`, `load`, `stats`, `clear`.
  The concurrency test has a **warm** case (vertices and edge exist; total must be exact) and a
  **cold** case (everything is created concurrently; duplicates are reported as WARN, a finding
  about `coalesce(addE)` races, not a failure). If the cold case duplicates on Neptune, the
  transformer needs an upsert-race mitigation before 9c.
- Neo4j baseline is read with `docker exec rca-neo4j cypher-shell`; if the container is not
  running the output says so and Neptune is compared with the CSV only (WARN, not FAIL).
- `-c graphBackend=bogus` makes `cdk synth` fail loudly instead of silently logging.

### 9a checkpoint results (real output)

- `src/lambda-transformer`: `tsc --noEmit` clean; **110/110 unit tests** (was 77; new: SigV4
  known-answer vector from the AWS test suite, signing headers for `neptune-db`, writer connection
  handling with a mocked driver, probe validation, `isConnectionError`).
- **16/16 integration tests against a real Gremlin Server 3.7.3** (6 existing + 10 new for load,
  stats, ordering/ties, idempotent re-load, chunking, clear, smoke test, concurrency run).
  Both bundles build (`dist/index.js`, `dist/probe.js`, about 960 KB each); the bundled
  `probe.handler` loads and fails cleanly without `GREMLIN_URL`.
- `infra-cdk`: `tsc` clean; **68/68 tests** (was 32; new: 15 `NeptuneStack`/`TransformerStack`
  assertions, 16 parity logic, 5 Neo4j baseline parsing). Full `cdk synth` clean for the default,
  `-c graphBackend=neptune` and `-c neptuneReplica=true`, no cycles.
- **Local rehearsal of the whole 9b parity path** (same code as `verify-neptune.ts`, local Gremlin
  Server in place of Neptune, the real CSVs and the real Neo4j container): top-2,000 subset
  (1,086 nodes, 2,000 edges) **and** the full graph (7,384 nodes, 16,115 edges, 71 s load): node
  count, edge count, call_count sum, node counter sums, per-node out/in degree (every node, self-loops
  included) and top-10 edges are identical across Gremlin, CSV and Neo4j.
- `verify:neptune` with nothing deployed fails cleanly ("not deployed"). **Nothing was deployed to
  AWS and no AWS resources were created in 9a.**

### Not proven by 9a (this is what 9b exists to prove)

- Neptune accepts the cluster on this Free Tier plan account (restrictions surface at create time).
- The signed WebSocket handshake is accepted by Neptune, and unsigned requests are refused.
- The 3.7.3 client works against engine 1.4.8.0.
- Neptune-side behaviour of `property(key, traversal)` on edges, the `ConcurrentModification` retry
  path, and the cold-create race.
- Probe Lambda reaching Neptune through the SG rule from the private-app subnets.
