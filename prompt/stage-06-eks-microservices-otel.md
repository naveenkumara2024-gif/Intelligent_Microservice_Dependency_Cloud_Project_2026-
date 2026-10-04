# Stage 6 — Microservices + OTel Collector on EKS

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol"). Phases are approved separately (6a code and
local validation, 6b deploy and verify), same as Stage 5.

## Why this stage exists

Build-order item 6. Gives the pipeline a live source of traces: the Online
Boutique demo app running on EKS, with an OpenTelemetry Collector DaemonSet
receiving spans. Stage 7 (MSK) later attaches a Kafka exporter to this
collector, and Stage 8 consumes those spans.

## Hard prerequisites

- **Stage 5b must be done first**: `VpcStack` deployed and verified. `EksStack`
  depends on it (already wired in `bin/app.ts`), and a cluster cannot be
  created without the VPC.
- AWS credentials configured, budget alert confirmed (`npm run preflight`
  passes). **Neither is true today.**
- Tools on the workstation. Verified on 2026-10-04: `kubectl` v1.34.1 is
  installed; `helm` and `eksctl` are not (this plan avoids needing either);
  `docker` is not needed for this stage (Online Boutique uses public images).

## Current state (verified)

- `infra-cdk/lib/eks-stack.ts` is an empty stack.
- `src/collector/` contains only `.gitkeep`.
- `aws-cdk-lib` 2.270.0 ships `aws-eks-v2` (native-resource EKS L2) alongside
  the older `aws-eks`.

## Correction to flag in CLAUDE.md

CLAUDE.md describes the collector as "zero-code interception of RPC/gRPC
calls". That is not what a DaemonSet collector does: it **receives** OTLP that
workloads send. Online Boutique's Go/Node/Python services emit OTLP when
`ENABLE_TRACING=1` and `COLLECTOR_SERVICE_ADDR` are set (to be confirmed
against the manifest version we pin, see gotchas). Auto-instrumentation
without code or env changes would need the OpenTelemetry Operator, which is out
of scope. I will correct that wording in CLAUDE.md when 6a is done.

## Design decisions (flag any you disagree with)

1. **Cluster**: EKS via `aws-eks-v2`, a recent supported Kubernetes version
   (confirmed against what the CDK version offers at implementation time),
   control plane in the VPC's private-app + public subnets, endpoint access
   public + private (so `kubectl` works from your laptop).
2. **Nodes**: one managed node group in the **private-app** subnets, spread over
   both AZs, 2 x `t3.large` (2 vCPU / 8 GB), min 2 / max 3, on-demand. Online
   Boutique's ~11 services plus the load generator and collector fit
   comfortably. Spot would be cheaper but adds interruption noise to the demo.
3. **Admin access**: an EKS access entry for your IAM user/role (the one that
   runs `cdk deploy`) with cluster-admin, so `aws eks update-kubeconfig` +
   `kubectl` works. No `aws-auth` ConfigMap editing.
4. **Workloads are applied with `kubectl`, not through CDK.** CDK's
   `cluster.addManifest` needs a kubectl-handler Lambda layer package plus a
   custom resource; for a course project, plain manifests in git applied by a
   script are simpler, easier to inspect, and keep `cdk synth` credential-free.
   CDK owns the cluster; `k8s/` manifests own what runs on it.
5. **Demo app**: Google's Online Boutique (microservices-demo) at a **pinned
   release tag**, its upstream `release/kubernetes-manifests.yaml`, vendored
   into `k8s/online-boutique/` (not applied from a moving `main` URL). Its
   built-in `loadgenerator` provides steady traffic.
6. **Collector**: OpenTelemetry Collector (contrib distribution, pinned
   image tag) as a DaemonSet in an `observability` namespace with a ConfigMap
   from `src/collector/otel-collector-config.yaml`:
   - receivers: `otlp` (gRPC 4317, HTTP 4318);
   - processors: `memory_limiter`, `batch`;
   - exporters: `debug` (spans visible in collector logs) for now. The `kafka`
     exporter to `otel.traces` is added in Stage 7, when MSK exists.
   - A `ClusterIP` Service exposes the collector so Online Boutique's
     `COLLECTOR_SERVICE_ADDR` can point at it (Service routes to the node-local
     DaemonSet pod via `internalTrafficPolicy: Local`).
7. **No ALB / ingress**: access the storefront with `kubectl port-forward`
   during this stage. The AWS Load Balancer Controller (needs helm or manifests
   + an IRSA role) is deferred until the dashboard stage unless you want a
   public URL now.
8. **IAM**: only what the EKS construct creates (cluster role, node role). No
   extra application roles in this stage.

## Phase 6a — Code + local validation (no credentials, no cost)

| File | Change |
|---|---|
| `infra-cdk/lib/eks-stack.ts` | Cluster, managed node group, access entry. Takes `vpc: ec2.IVpc` via props. |
| `infra-cdk/bin/app.ts` | `new EksStack(app, 'EksStack', { env, vpc: vpcStack.vpc })`. |
| `infra-cdk/test/eks-stack.test.ts` (new) | Assertions: node group size/type/subnets, access entry, no public node IPs. |
| `src/collector/otel-collector-config.yaml` (new) | Collector config described above. |
| `k8s/observability/collector-daemonset.yaml` (new) | Namespace, ConfigMap (generated from the config file), DaemonSet, Service. |
| `k8s/online-boutique/*.yaml` (new) | Pinned upstream manifest, with tracing env vars pointed at the collector Service. |
| `infra-cdk/scripts/deploy-workloads.ts`, `verify-eks.ts` (new) | Same style as Stage 5b: update kubeconfig, apply manifests, then verify. Not run until credentials exist. |
| `infra-cdk/package.json` | npm scripts `deploy:eks`, `deploy:workloads`, `verify:eks`, `destroy:eks`. |
| `CLAUDE.md` | Status line, repo structure (`k8s/`), and the zero-code wording fix. |

Local validation commands:

```bash
cd infra-cdk
npx tsc
npx jest
npx cdk synth
kubectl apply --dry-run=client -f ../k8s/observability -f ../k8s/online-boutique   # schema check, no cluster needed
```

(`--dry-run=client` can still try to reach an API server for discovery; if it
needs one, I will validate the YAML with a local schema check instead and say so.)

### Checkpoint 6a

1. `cdk synth` succeeds for all stacks with `EksStack` using the VPC from
   `VpcStack`; no cycles.
2. Jest passes.
3. Manifests validate locally.

## Phase 6b — Deploy and verify (separate approval; costs money)

Preconditions: Stage 5b done, `npm run preflight` passes.

```bash
npm run deploy:vpc          # if not already deployed (Stage 5b)
npm run deploy:eks          # cdk deploy EksStack; ~15-20 min for the control plane
npm run deploy:workloads    # aws eks update-kubeconfig + kubectl apply
npm run verify:eks
```

### Checkpoint 6b (real output required)

1. `kubectl get nodes` shows 2 `Ready` nodes in 2 AZs.
2. `kubectl get pods -A` shows all Online Boutique pods `Running`.
3. `kubectl -n observability get ds` shows the collector DaemonSet fully
   scheduled.
4. `kubectl -n observability logs ds/otel-collector` shows spans from several
   distinct Online Boutique services (this is the proof that traces flow and
   what Stage 7 will forward to Kafka).
5. Storefront loads through `kubectl port-forward`.

## Estimated cost while running (us-east-1, approximate)

| Item | ~Cost |
|---|---|
| EKS control plane | $0.10/hr |
| 2 x t3.large nodes | ~$0.166/hr |
| NAT + interface endpoints (from Stage 5) | ~$0.09/hr |
| **Total** | **~$0.36/hr, about $8.70/day** |

I will recommend `cdk destroy EksStack` (then `VpcStack`) after the checkpoint
unless you want it left up for the Stage 7 session. Workloads in `k8s/` are
re-appliable in minutes, so tearing down loses nothing.

## Known gotchas

- Pin the Online Boutique tag and verify its tracing env var names against the
  actual manifest before wiring the collector address; do not assume them.
- Node group in private subnets needs the NAT for image pulls
  (`us-docker.pkg.dev`, Docker Hub); this is why Stage 5 keeps one NAT.
- The collector is a DaemonSet; on a 2-node cluster that is only 2 pods, so
  the `ClusterIP` Service's node-local routing needs a check that every node
  running Online Boutique pods also runs a collector pod.
- CloudFormation EKS creation is slow; a failed deploy can leave a stack in
  `ROLLBACK`, which I would diagnose from real events, not retry blindly.

## Explicitly out of scope

- MSK / Kafka exporter (Stage 7); Lambda transformer (Stage 8).
- ALB / ingress controller, OpenTelemetry Operator, service mesh.
- Persisting any traces; the `debug` exporter only logs.
- Commit/push: separate approvals after each checkpoint.

---

## Phase 6a as built (2026-10-04) — deviations from the plan above

Facts verified while implementing, which changed or refined the plan:

- **Only 7 of 11 Online Boutique services emit spans.** Verified against
  upstream v0.10.7 (`kustomize/components/google-cloud-operations`): frontend,
  checkoutservice, currencyservice, emailservice, paymentservice,
  productcatalogservice, recommendationservice. adservice ("not yet
  implemented"), shippingservice, cartservice, redis-cart and loadgenerator
  emit none. **Consequence for later stages:** live traces cover only those 7
  as span sources, so the knowledge graph will lack edges originating from the
  other nodes (frontend's client spans may still name them as callees).
- **Env vars** (confirmed from upstream, not assumed): `ENABLE_TRACING=1`,
  `COLLECTOR_SERVICE_ADDR=<host>:4317`, `OTEL_SERVICE_NAME`. Upstream's own
  collector is a GCP-exporting gateway, so it is not reused; our DaemonSet is.
  `OTEL_SERVICE_NAME` comes from each pod's `app` label via the downward API.
- **Layout changed**: the collector's DaemonSet/Service/namespace live in
  `src/collector/` (matches CLAUDE.md's repo structure) with a kustomization
  that generates the ConfigMap from `otel-collector-config.yaml`. `k8s/` holds
  only `online-boutique/` (vendored unmodified manifest + a kustomization that
  adds the tracing env vars). No `k8s/observability/`.
- **EKS 1.35** via `aws-eks-v2` with access-entry auth (`API` mode); control
  plane in private-app subnets only; no kubectl-handler Lambda. Cross-stack
  subnet references synthesize as `Fn::GetStackOutput` (new CDK behavior) so
  `EksStack` needs `cloudformation:DescribeStacks` on `VpcStack` at deploy
  time, which admin credentials have.
- **Local validation limit**: `kubectl apply --dry-run=client` needs a
  reachable API server even with `--validate=false` (discovery), so offline
  schema validation was not possible. Validated instead by `kubectl kustomize`
  rendering both layers (35 documents for Boutique) plus a per-service check
  that exactly the 7 tracing services received the env vars. Full schema
  validation happens at 6b's `kubectl apply`.
- **Wrong-cluster hazard found**: the workstation's kubeconfig has another
  context (`127.0.0.1:54631`, currently down). The 6b scripts pin every
  `kubectl` call to the EKS cluster's context (`--context arn:aws:eks:...`) and
  refuse to run if `EksStack` isn't deployed, so they can never act on a
  different cluster.

### 6a checkpoint results

- `npx tsc`: clean. `npx cdk ls`: 7 stacks. `npx cdk synth` (all): success, no
  cycles.
- `npx jest`: 3 suites, 15/15 pass (5 new EKS tests).
- `kubectl kustomize` renders `src/collector` (Namespace, ConfigMap, DaemonSet,
  Service) and `k8s/online-boutique` (35 documents).
- 6b scripts (`deploy-workloads`, `verify-eks`) fail cleanly with
  `NoCredentials`; not yet run against AWS.
