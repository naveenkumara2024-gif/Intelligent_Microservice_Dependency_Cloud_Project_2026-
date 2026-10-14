# Project status — Intelligent Microservice Dependency Analysis & RCA Framework

As of 2026-10-14. For the full detail see `CLAUDE.md` (architecture and per-stage notes) and
`prompt/stage-NN-*.md` (the plan and as-built record of each stage).

## What the system does

Treats a microservice platform as a live dependency graph and uses a GNN to name the service that
structurally explains a pattern of slowdown (root cause + blast radius), then alerts and shows it.
The contribution is the **streaming, cloud-deployed pipeline** around graph-based RCA, not a new
GNN algorithm.

```
Online Boutique on EKS -> OTel Collector -> MSK (Kafka) -> Lambda transformer -> Neptune (graph)
                                                                  |
                          DynamoDB incidents <- scorer Lambda (every minute) -> SageMaker GNN
                                  |
                      stream -> SNS -> Slack / PagerDuty / email        API Gateway -> dashboard
```

## Completed

| # | Stage | State |
|---|---|---|
| 0-4 | Environment, dataset prep, Neo4j prototype, GNN training, CDK scaffolding | Done |
| 5 | VPC, subnets, endpoints | Verified live |
| 6 | EKS + Online Boutique + OTel Collector | Verified live |
| 7 | MSK streaming | Verified live |
| 8 | Lambda graph transformer (spans -> Gremlin) | Verified live |
| 9 | Neptune graph store (parity with the Neo4j prototype) | Verified live |
| 10 | SageMaker serverless GNN endpoint | Verified live |
| 11 | DynamoDB incidents + scorer Lambda | Verified live |
| 12 | SNS alerting (Slack / PagerDuty / email) | Verified live |
| 13 | Dashboard (React + Cytoscape) + read-only API + CloudFront site | Tier 1 verified live; recent-window fix built locally |
| 14 | **Real fault-injection demo** | **14b latency fault verified live 19/19 (2026-10-14)**; CPU fault not detectable as designed (see below) |

Tests passing: 289 unit (Lambdas), 50 (dashboard), 232 (infra), 51 (Python). Full `cdk synth` clean (11 stacks).

## Stage 14b result (2026-10-14, live, real fault, real traffic)

`npm run verify:demo` with `EXTRA_LATENCY=300ms` on productcatalogservice: **19 PASS / 0 FAIL / 0 WARN.**
Healthy 8-min soak: 0 model calls, 0 incidents. Latency into the service 0.37 ms -> 302 ms (x819).
Exactly one incident opened 0.6 min after the fault rolled out, **root cause productcatalogservice
ranked #1 (score 0.932)**, blast radius `recommendationservice` (itself 39x slower, correctly not
blamed), at risk checkout/frontend/recommendation. Resolved 3.9 min after clearing. Exactly one
"opened" and one "resolved" alert; SNS 3 delivered / 0 failed; DLQ empty; no scorer errors.

The CPU-starvation fault (`--limit=15m` on currencyservice) **never reached traffic**: the starved pod
failed its 1 s readiness/liveness probes, never became Ready, and the old pod kept serving. Nothing to
detect, so no incident (correctly). A milder limit (e.g. 50m) is untested.

## In progress / not yet done

- **Dashboard recent-window fix** (built and tested locally, NOT deployed): the graph showed lifetime
  average latency, which hid a fault and kept showing it long after (46 ms shown 40 min after the fault
  was cleared). It now shows the last 20-80 s and a "Slow now" marker; needs `deploy:scorer` and
  `deploy:frontend -- -c topology=neptune`, then a live check.
- **13b tier 2** (topology through CloudFront) served real Neptune data during 14b, but the formal
  `verify:dashboard -- --topology` has not been run; re-run the 19/1 tier-1 check now that the
  concurrency limit is 1000.
- **Nothing pushed since `8769cdc`.**

## Next steps, in order

1. Deploy and live-check the dashboard fix; run `verify:dashboard -- --topology`.
2. Optional: CPU fault at `--limit=50m`; set the Slack webhook and PagerDuty key (SSM) and re-run
   `verify:alerts` to prove the real HTTP legs (only unit-tested so far).
3. **Stage 15 — teardown discipline:** `cdk destroy` idle stacks between sessions.

## Things to remember

- **AWS account:** paid plan (credit remaining). **Network Load Balancers are still refused**; ALB and
  Classic ELB work. **Lambda concurrency limit is now 1000** (raised from 10; seen 2026-10-14).
- **Known limits, stated honestly:** all GNN fault labels are synthetic; the model was fine-tuned on
  small Boutique-shaped graphs; the live demo is one single-service latency fault (one run, not a
  statistic); the dashboard guard is not real user login; a TLS minimum cannot be enforced on the
  default CloudFront certificate.
- **Unproven so far:** SSM secret decryption and real Slack/PagerDuty delivery.
- **Shell tips (Windows):** use PowerShell for `aws ssm put-parameter` (Git Bash rewrites paths that
  start with `/`); repeat `-c alertEmail=...` on every `deploy:alerts` or the email subscription is removed.
