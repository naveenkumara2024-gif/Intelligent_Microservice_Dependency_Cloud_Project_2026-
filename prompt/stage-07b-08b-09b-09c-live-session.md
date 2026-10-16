# Stages 7b / 8b / 9b / 9c — the live session (2026-10-12/13)

Status: **COMPLETE and verified live.** All four stages that had only passed local tests were
deployed together and verified against real services after the account was upgraded from the
Free Tier plan to the paid plan (`aws freetier get-account-plan-state`: `PAID`, `ACTIVE`, 159.47 USD
of credits carried over). One session deployed `VpcStack`, `EksStack`, `MskStack`, `NeptuneStack`
and `TransformerStack` and ran every checkpoint; the stacks are destroyed afterwards.

This is the highest-value document in the project for "what only a real deployment taught us":
**nine defects were invisible to 137 unit tests, 18 integration tests against a real Gremlin
Server, and 97 infrastructure tests.** Each was found by a live checkpoint and now has a regression
test (the one that cannot run in jest has a subprocess test) or a documented reason.

## Order and result

| Phase | Checkpoint | Result |
|---|---|---|
| Deploy | `cdk deploy EksStack MskStack NeptuneStack --concurrency 3 --require-approval never` | all `CREATE_COMPLETE` (MSK `ACTIVE`, Neptune `available`, engine 1.4.8.0, `db.t4g.medium`) |
| 7b | `verify:eks` | PASS 4/4 (2 nodes across 2 AZs, 12 pods, collector 2/2, spans seen) |
| 7b | `verify:msk` | PASS 5/5 (cluster ACTIVE, 3 topics, **200 messages carrying spans from all 7 tracing services**) |
| 9b | `verify:neptune` | PASS, every check (control plane, signed + unsigned, smoke, 8-writer concurrency, parity vs CSV **and** Neo4j) |
| 8b | `verify:transformer --window=4` | PASS 5/5 (130 invocations, 15,152 spans, **7,549 calls derived**, no errors) |
| 9c | `verify:live --window=4` | PASS 8/8 (14 live edges, only the 7 emitters as callers, counters growing, newest span recent, no errors) |

9b before 9c on purpose: `verify:neptune` clears and loads parity data, so it must not run after
the live graph is built (the first 9c run was polluted by 9b's leftovers; `probe -- clear` fixed it).

## The nine defects, in the order they appeared

1. **Kafka topics Job `CreateContainerConfigError`.** `runAsNonRoot: true` cannot be verified for a
   *named* image user (`appuser`). Fix: numeric `runAsUser: 1000`, confirmed with `id` inside the
   image. (`k8s/kafka-topics/job.yaml`)
2. **`verify:msk` reported no topics although they existed.** `kubectl run -i --rm` drops anything
   the container prints before kubectl attaches, which lost the `==TOPICS==` marker. Fix: detached
   pod + `kubectl logs`.
3. **Neptune signed WebSocket refused (the subtle one).** The signature was correct (a raw `ws`
   handshake with the same headers returned 101). The Gremlin driver does
   `globalThis.WebSocket ?? import('ws')`, and **Node 22 defines a global `WebSocket`**, which the
   driver constructs with *no options*, so the SigV4 headers were silently dropped. Fix:
   `useNodeWebSocketLibrary()` hides the global under IAM auth. Regression test runs in a real Node
   subprocess (jest's VM cannot do the driver's dynamic import) and is proven to fail with the fix
   removed; a control test pins the upstream behaviour.
4. **MSK trigger refused: "MaximumRetryAttempts is only available for provisioned mode".** For MSK,
   retry caps and max record age exist only in provisioned mode (dedicated, separately billed
   pollers). Fix: removed both; on-demand mode retries a failing batch until it succeeds or the record
   leaves the topic, and the handler skips malformed records so a poison record cannot wedge a
   partition.
5. **Trigger status `PROBLEM: Connection error` (event source VPC must reach Lambda and STS).** The
   poller runs in the cluster's VPC, whose data subnets are deliberately isolated. Fix: Lambda and
   STS **interface endpoints** (PrivateLink) in `VpcStack`, instead of a NAT route that would break
   the isolation rule. Note the status string stayed `PROBLEM` for a long time after it was fixed
   (stale); CloudWatch's `Invocations` metric (361 in 30 min) was the truth, and CloudTrail and the
   ENI list were the way to diagnose.
6. **Zero edges from 54,290 real spans (`"spans":443,"calls":0`).** The Stage 8 rule expected a
   hostname in `server.address`. Online Boutique puts the callee's **ClusterIP** there and carries the
   callee in the gRPC method: Go services send `rpc.method = hipstershop.ProductCatalogService/GetProduct`,
   Python sends `rpc.service = hipstershop.ProductCatalogService` + a bare method. Also every
   service's exporter is itself instrumented (`TraceService/Export` to the collector) and kubelet
   health-checks every pod. Fix: derive the callee from the gRPC service (lower-cased), prefer
   `peer.service` and real hostnames, drop infrastructure RPCs. Driven by **6 spans captured verbatim
   from the live cluster** (`src/lambda-transformer/test/fixtures/boutique-live-spans.json`).
7. **`verify:transformer` blind to its own logs.** Lambda prefixes log lines with
   `<timestamp>\t<request id>\tINFO\t`, so the whole line is not JSON. Fix: extract from the first
   `{`.
8. **Neptune write rejected: not authorized to perform `neptune-db:DeleteDataViaQuery`.** Overwriting
   a property value (the counters, `last_seen_ms`) is authorized as delete-old + write-new. The
   Stage 9 assertion "the transformer may NOT delete" was an intuition real Neptune disproved. Fix:
   grant it, cluster-scoped, with the reason documented; the test asserts the exact three actions and
   that no administrative action is ever granted.
9. **Bursts of `Unexpected server response: 403` at the WebSocket handshake.** After a socket closes,
   the driver reopens it from the *original* `options.headers`, replaying a signature that is minutes
   old (SigV4 signatures live 5 minutes). Fix: a handshake 401/403 drops the connection and re-signs
   (bounded to 4 attempts), and a connection that closed since its last use is re-signed before the
   next request. A query-level "not authorized" is still not retried.

Two smaller verification-tooling fixes: the 9c recency check tolerates 60 s of clock skew between the
cluster and the workstation (it read "-4 s old"), and `--window=N` lets a run count only post-fix
behaviour.

## What the live graph looks like (9c)

14 of the 16 manifest-derived configured edges were observed; 7 services appear as callers
(frontend, checkoutservice, recommendationservice, ...), and cart/shipping/ad/redis/loadgenerator have
no outgoing edges, as the Stage 6 finding predicted (they emit no spans). Busiest, after about 4 hours:

```
frontend -> productcatalogservice        24,656 calls   avg 0.3 ms
frontend -> currencyservice              15,738 calls   avg 1.4 ms
frontend -> cartservice                   4,701 calls   avg 1.4 ms
frontend -> recommendationservice         3,749 calls   avg 2.3 ms
recommendationservice -> productcatalogservice  3,739   avg 0.9 ms
frontend -> adservice                     3,008 calls   avg 0.7 ms
```

## What this changes for later stages

- **Stage 10's `own_delta` input is now feasible from real data:** each edge stores
  `latency_sum_ms`, `call_count` and `latency_recent_avg_ms`, so a per-service "observed / normal - 1"
  can be computed from the live graph. A baseline tracker is still needed (the lifetime average
  contains the fault once it starts).
- **Service names in the graph are the lower-cased gRPC service names** (`productcatalogservice`), which
  equal the Boutique deployment names, so they match the Stage 10 fixture topology directly.
- The transformer's `Delete` permission and the Lambda/STS endpoints are now part of the stacks; a
  fresh deploy needs no manual steps.

## Cost

About 4 hours of EKS (2 x m7i-flex.large), MSK (2 x kafka.t3.small), Neptune (db.t4g.medium), one NAT
gateway and 6 interface endpoints, roughly $0.65-0.75/hour: on the order of $3, covered by credits.
Teardown order is the reverse of dependency: transformer, Neptune, MSK, EKS, then the VPC.

## Not proven

- The model scoring *live* Neptune data end to end (Stage 10's endpoint was verified on synthetic
  payloads; the scorer Lambda that joins them belongs to Stages 11-12).
- Behaviour over days (Kafka redelivery double-counting is still an accepted, documented
  approximation).
- Real failures: fault injection in the live cluster is Stage 14.

---

## Addendum (2026-10-13): the load-balancer block did NOT lift

The upgrade cleared MSK and Neptune, but an attempt to make the storefront public (an internet-facing
NLB via `type: LoadBalancer`) was refused by AWS, on the paid plan:

> `OperationNotPermitted: This AWS account currently does not support creating load balancers. For more
> information, please contact AWS Support.`

So the Free Tier errors were two different mechanisms: MSK/Neptune were plan gates (cleared by the
upgrade); load balancers are a separate new-account restriction that needs an AWS Support case. The
mechanism for going public is built, tested and left in place for when it clears:

- `k8s/online-boutique-public/` (kustomize overlay: only `frontend-external` becomes an NLB; the base
  stays private, and a test asserts it),
- `npm run expose:storefront [-- --allow=<cidr>[,<cidr>]] [-- --off]`,
- `scripts/pre-destroy.ts` already deletes LoadBalancer Services before teardown.

Nothing was left behind: the attempt was reverted with `--off`, and `describe-load-balancers` showed none.
Still unblocked-by-support: Stage 13's API Gateway VPC link (needs an ELB) and any public ingress.

Ways to a public URL that do not need an ELB, none built yet, each a decision for the account owner:
a Cloudflare quick tunnel run in-cluster (third party, ephemeral URL), or API Gateway HTTP API with a
Cloud Map private integration (registers node IPs and a NodePort; more moving parts).
