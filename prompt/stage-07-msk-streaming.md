# Stage 7 — MSK streaming pipeline (collector -> Kafka)

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol"). Phases are approved separately: 7a (code and
local validation, free) and 7b (deploy and verify, billable).

## Why this stage exists

Build-order item 7. Puts a durable buffer between the telemetry source and the
graph builder: the OTel Collector DaemonSet (Stage 6) exports spans to an Amazon
MSK (Kafka) cluster; Stage 8's Lambda later consumes them. Topics per CLAUDE.md:
`otel.traces`, `otel.metrics`, `svc.events`.

## BLOCKER found while drafting (verified 2026-10-06)

`aws kafka list-clusters-v2` and `list-kafka-versions` both fail with:

    SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service

The account is not yet subscribed to Amazon MSK. This is the same family of new-
account restriction as the load-balancer block seen in Stage 6b
(`OperationNotPermitted ... account does not support creating load balancers`).
**Phase 7b cannot succeed until the account is cleared.** Phase 7a (everything
that runs without AWS) is unaffected. Ways to clear it (the user's decision):

1. Open an AWS Support case (Account and billing) naming both symptoms: MSK
   `SubscriptionRequiredException` and ELB `OperationNotPermitted`, account
   958772492481. Basic support is free.
2. Upgrade from the Free plan to the paid plan in Billing (credits carry over);
   this often clears both restrictions at once.
3. Wait: some restrictions lift after account verification completes.

Recheck command (read-only, no cost): `aws kafka list-kafka-versions --region us-east-1`
— success (a version list) means MSK is available.

## Hard prerequisites for 7b (not for 7a)

- The MSK subscription block above is cleared.
- Stage 6's `EksStack` deployed and `npm run deploy:workloads` done (the
  collector must be running to export, and a consumer pod runs in the cluster).
- Budget alert present (`npm run preflight` passes; it does today).

## Current state (verified)

- `infra-cdk/lib/msk-stack.ts` is an empty stack; `bin/app.ts` already makes
  `MskStack` depend on `VpcStack`.
- `aws-cdk-lib` exposes `aws-msk` L1 constructs `CfnCluster`, `CfnConfiguration`,
  `CfnServerlessCluster` (no L2; L1 it is).
- `src/collector/otel-collector-config.yaml` has `otlp` receiver, `debug`
  exporter, and a `traces` pipeline only.
- Collector image `otel/opentelemetry-collector-contrib:0.160.0` includes the
  `kafka` exporter. Its config (from the v0.160.0 README): `brokers` (list),
  per-signal `traces: { topic, encoding }`, `partition_traces_by_id`, `tls`,
  `auth.sasl.*`. `encoding` default is `otlp_proto`.
- The workstation has no Kafka client; consuming is done from a pod in the
  cluster, so no local install is needed.

## Design decisions (flag any you disagree with)

1. **Provisioned MSK, not Serverless.** 2 x `kafka.t3.small` brokers (one per
   AZ, in the private-data subnets) is about $0.09/hr; MSK Serverless costs
   roughly $0.75/hr just to exist. t3.small is the cheapest broker type.
2. **Auth: TLS in transit, no client authentication, access restricted by
   security group** (port 9094 from the private-app subnet CIDRs only, which
   covers EKS pods now and the Lambda in Stage 8). Rationale: the collector's
   `AWS_MSK_IAM_OAUTHBEARER` path needs pod-level IAM (IRSA / Pod Identity) —
   real extra work and a new failure mode. The cluster sits in subnets with no
   internet route and no ingress except that one rule. Trade-off: any workload
   in private-app can read/write; acceptable for a course project, to be
   revisited (IAM auth) if time allows.
3. **Security group source = private-app subnet CIDRs, not the EKS cluster
   security group.** Keeps `MskStack` dependent on `VpcStack` only (no
   `MskStack -> EksStack` coupling, no cycle risk).
4. **Encryption at rest**: the AWS-managed KMS key (default). A customer-managed
   key is deferred (consistent with Stage 5 decision 8: keys live with their
   owning stack, and a CMK adds cost/complexity for no checkpoint value).
5. **Small and cheap**: 10 GB EBS per broker, log retention 24 h
   (`log.retention.hours=24`), no broker log delivery, no enhanced monitoring.
6. **Topics created explicitly**, not by auto-create: a Kubernetes Job
   (`k8s/kafka-topics/`) running the Apache Kafka CLI image creates
   `otel.traces`, `otel.metrics`, `svc.events` (3 partitions, replication 2).
   Only `otel.traces` will receive data: Online Boutique emits traces only, and
   the collector has no metrics pipeline. The other two exist for later use.
7. **Message encoding: `otlp_json`** for `otel.traces`. Larger than protobuf,
   but the Stage 8 TypeScript Lambda can parse it with plain `JSON.parse` and no
   protobuf dependency. `partition_traces_by_id: true` keeps a trace's spans on
   one partition (ordered together).
8. **Broker addresses are not known at synth time** (CloudFormation does not
   expose the bootstrap string). `deploy-workloads` fetches them with
   `aws kafka get-bootstrap-brokers`, writes them into a ConfigMap
   (`kafka-bootstrap` in `observability`), and the DaemonSet reads them as env
   `KAFKA_BROKERS`. The collector config uses `${env:KAFKA_BROKERS}`; the
   collector parses the env value as YAML, so the script formats it as
   `[host1:9094,host2:9094]` (to be confirmed on the first real run).
9. **The `debug` exporter stays** next to `kafka`, so Stage 6's `verify:eks`
   keeps working unchanged.
10. **Stage 7 makes MSK a hard requirement for the collector.** Once the config
    references `${env:KAFKA_BROKERS}`, deploying the collector without MSK
    would crash it. `deploy-workloads` will fail early with a clear message if
    `MskStack` is not deployed, rather than ship a crashing collector.

## Phase 7a — Code and local validation (no credentials needed, no cost)

| File | Change |
|---|---|
| `infra-cdk/lib/msk-stack.ts` | `CfnConfiguration` (`auto.create.topics.enable=false`, `default.replication.factor=2`, `min.insync.replicas=1`, `num.partitions=3`, `log.retention.hours=24`), `CfnCluster` (2 x kafka.t3.small, private-data subnets, TLS-only client-broker, unauthenticated, 10 GB), security group (9094 from private-app CIDRs), outputs `ClusterArn`. Takes `vpc` via props. |
| `infra-cdk/bin/app.ts` | Pass `vpc: vpcStack.vpc` to `MskStack`. |
| `infra-cdk/test/msk-stack.test.ts` (new) | Broker count/type/subnets, TLS-only, no public access, SG only 9094 from private-app CIDRs, config properties. |
| `src/collector/otel-collector-config.yaml` | Add `kafka` exporter on the traces pipeline; `traces.topic: otel.traces`, `encoding: otlp_json`, `partition_traces_by_id: true`, `tls: {}`. |
| `src/collector/collector.yaml` | `KAFKA_BROKERS` env from the `kafka-bootstrap` ConfigMap. |
| `k8s/kafka-topics/` (new) | Kustomize dir with the topic-creation Job. |
| `infra-cdk/scripts/deploy-workloads.ts` | Early MSK check, fetch brokers, create `kafka-bootstrap` ConfigMap, run topic Job before the collector. |
| `infra-cdk/scripts/verify-msk.ts` (new) | Checkpoint script (below). |
| `infra-cdk/package.json` | `deploy:msk`, `verify:msk`, `destroy:msk` scripts. |
| `CLAUDE.md` | Status, repo structure, the account constraint. |

Local validation:

```bash
cd infra-cdk && npx tsc && npx jest && npx cdk synth
kubectl kustomize ../k8s/kafka-topics ../src/collector   # renders
```

The collector config cannot be run locally without Docker; if Docker is
available I will validate it with `otelcol-contrib validate`, otherwise I will
say it was not validated until 7b.

### Checkpoint 7a

1. `tsc` clean; Jest all pass (current 15 plus the new MSK tests).
2. `cdk synth` succeeds for all stacks with no cycles; `MskStack` template shows
   2 brokers, `kafka.t3.small`, TLS-only.
3. Both kustomize dirs render.

## Phase 7b — Deploy and verify (separate approval; billable; BLOCKED until the
MSK subscription is cleared)

Order (user runs the `cdk deploy` themselves; the permission classifier has
blocked my own deploys, while `deploy:workloads`/`verify` scripts ran fine):

```bash
npm run deploy:eks          # if not already up (~20 min)
npm run deploy:msk          # preflight + cdk deploy MskStack (~25-35 min; MSK is slow)
npm run deploy:workloads    # topics Job, kafka-bootstrap ConfigMap, collector restart
npm run verify:msk
```

### Checkpoint 7b (real output required)

`verify:msk` checks, read-only except for a short-lived consumer pod:

1. MSK cluster state `ACTIVE`, 2 brokers (`aws kafka describe-cluster-v2`).
2. The 3 topics exist (consumer pod listing).
3. Collector pods Ready with no Kafka errors in their logs.
4. A consumer pod reads real messages from `otel.traces`, and the JSON contains
   `service.name` values from several Online Boutique services (the same
   evidence Stage 6 got from the debug exporter, now arriving via Kafka).

## Estimated cost while running (us-east-1, approximate)

| Item | ~Cost |
|---|---|
| 2 x kafka.t3.small | ~$0.091/hr |
| EBS 2 x 10 GB | ~$0.003/hr |
| Existing EKS + 2 nodes + NAT + endpoints | ~$0.38/hr |
| **Total with MSK** | **~$0.47/hr, about $11/day** |

MSK has no stop button; the plan is `npm run destroy:msk` right after the
checkpoint, then `destroy:eks` and `destroy:vpc`. Destroying MSK deletes its
data (nothing valuable at this stage; the load generator regenerates traffic).

## Known gotchas

- MSK creation is the slowest deploy so far (commonly 20-35 minutes).
- `kafka.t3.small` has low throughput limits; fine for the demo load generator,
  not for stress tests.
- The `${env:KAFKA_BROKERS}` list-from-env behavior and the exact exporter keys
  must be confirmed against the first real collector start (config validated
  against the v0.160.0 README, not yet run).
- MSK security groups are stateful per-cluster; changing the SG later can
  restart brokers. Keep it simple and get it right the first time.
- Online Boutique only emits traces from 7 services (Stage 6 finding), so the
  topic carries spans for those 7 only.

## Explicitly out of scope

- The Lambda consumer / event source mapping (Stage 8) and Neptune (Stage 9).
- IAM (SASL) authentication, a customer-managed KMS key, broker log delivery.
- Metrics or logs pipelines (the topics exist but stay empty).
- Commit/push: separate approvals after each checkpoint.

---

## Phase 7a as built (2026-10-06) — deviations from the plan above

- **Kafka overlay instead of an unconditional exporter** (replaces design
  decision 10). Making the exporter unconditional would crash the working Stage 6
  collector whenever MSK is absent, and the account currently cannot deploy MSK.
  Instead: `src/collector/` stays the Stage 6 debug-only collector, and
  `k8s/collector-kafka/` is a kustomize overlay (new config with the `kafka`
  exporter + `KAFKA_BROKERS` env on the DaemonSet). `deploy-workloads` picks the
  overlay when `MskStack` exists and otherwise warns and deploys the Stage 6
  collector. The overlay lives outside `src/collector/` because kustomize rejects a
  base that contains its own overlay ("cycle detected").
- **Kafka version `3.9.x`** (MSK docs: recommended, last version supporting both
  ZooKeeper and KRaft). The version list could not be queried from the CLI
  (subscription block), so the doc page was the source; confirm with
  `aws kafka list-kafka-versions` once the account is cleared. `kafka.t3.small`
  is a supported standard broker type per the docs.
- **Files added**: `lib/msk-stack.ts`, `test/msk-stack.test.ts` (7 tests),
  `k8s/collector-kafka/`, `k8s/kafka-topics/`, `scripts/verify-msk.ts`;
  `deploy-workloads.ts` publishes the `kafka-bootstrap` ConfigMap (`brokers` as a
  YAML list for the collector, `bootstrap` as a plain comma list for the Job),
  runs the topic Job, and restarts the DaemonSet; npm scripts `deploy:msk`,
  `verify:msk`, `destroy:msk`.
- **Not yet proven** (needs a real MSK): that `${env:KAFKA_BROKERS}` expands to a
  list in the collector, the exporter key names against a running v0.160.0, the
  topic Job's `apache/kafka:3.9.0` client against TLS brokers, and
  `otlp_json` message shape as `verify-msk` parses it.

### 7a checkpoint results

- `npx tsc` clean; `npx jest`: 4 suites, 23/23 pass (8 new MSK tests).
- `npx cdk synth` (all stacks): success, no cycles. `MskStack` template: 1
  cluster, 1 configuration, 1 security group, no IAM roles or Lambdas.
- `kubectl kustomize` renders `src/collector`, `k8s/collector-kafka` (DaemonSet has
  `KAFKA_BROKERS` from `kafka-bootstrap`, ConfigMap has the Kafka exporter) and
  `k8s/kafka-topics`.
- `verify:msk` / `mskInfo()` fail or report `deployed:false` cleanly when MSK or EKS
  is absent. Nothing was deployed to AWS.

### Self-audit correction (2026-10-06)

The first 7a version had a real bug that its own tests encoded: the broker security
group allowed only client TCP 9094 and blocked all egress, with no rule letting the
two brokers talk to each other (replication / metadata). A real deploy would likely
have hung or never become healthy. Fixed: open egress (the private-data subnets have
no internet route, so it cannot leave the VPC) plus a self-referencing all-traffic
ingress rule; a test now asserts both, and a clean synth confirms them. Also corrected
the Stage 6 collector config comment, which still said Kafka would be added to that file.
Lesson for 7b: the first MSK deploy is still the real test of broker health.
