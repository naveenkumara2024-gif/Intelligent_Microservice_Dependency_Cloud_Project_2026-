# Project status — Intelligent Microservice Dependency Analysis & RCA Framework

As of 2026-10-13. For the full detail see `CLAUDE.md` (architecture and per-stage notes) and
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
| 12 | SNS alerting (Slack / PagerDuty / email) | Verified live; merged to `main` |
| 13a | Dashboard (React + Cytoscape) + read-only API (`ApiStack`) + site (`FrontendStack`) | Built and tested locally; committed |
| 14a | Real fault injection (`npm run fault`) + demo verifier (`npm run verify:demo`) | Built and tested locally |

Tests passing: 282 unit (Lambdas), 46 (dashboard), 232 (infra), 51 (Python). Full `cdk synth` clean (11 stacks).

## In progress / not yet done

- **13b — dashboard live through CloudFront: 19 PASS / 1 FAIL.** The failure is the account's Lambda
  concurrency limit of 10 (quota increase to 1000 requested; AWS Support case open). The topology tier
  (with Neptune) is not yet verified.
- **Stage 13 is committed** on `stage-13-dashboard-api` (not merged: 13b not passed). Stage 14 work is
  uncommitted on `stage-14-fault-injection`.
- **14b — the live fault-injection demo** needs the full stack set deployed (about 2-3 h, $3-5).
- **Nothing has been pushed.** `main` (Stages 11 and 12) is ahead of `origin/main`.
- **Deployed right now:** `DynamodbStack`, `ApiStack`, `FrontendStack` (idle; CloudFront and the rest cost cents).

## Next steps, in order

1. Deploy and verify the API now (`deploy:api`, `verify:dashboard -- --api-only`); the full site once
   AWS verifies CloudFront.
2. Commit Stage 14a; decide when to merge Stages 13-14 and push.
3. Optional: set the Slack webhook and PagerDuty key (SSM parameters) and re-run `verify:alerts`
   to prove the real HTTP legs (only unit-tested so far).
4. **Stage 14b — the live demo:** bring the whole stack up, run `verify:demo` (a real 300 ms latency
   fault in productcatalogservice), then the CPU fault. The storefront stays private (not needed).
5. **Stage 15 — teardown discipline:** `cdk destroy` idle stacks between sessions.

## Things to remember

- **AWS account:** paid plan (credit remaining). **Network Load Balancers are still refused**; ALB and
  Classic ELB work. The account's Lambda concurrency limit is 10.
- **Known limits, stated honestly:** all GNN fault labels are synthetic; the model was fine-tuned on
  small Boutique-shaped graphs; the graph shows lifetime counters, not live rates; the dashboard guard is
  not real user login; a TLS minimum cannot be enforced on the default CloudFront certificate.
- **Unproven so far:** SSM secret decryption and real Slack/PagerDuty delivery; CloudFront creation;
  a real scorer-driven incident through the whole pipeline (Stage 14).
- **Shell tips (Windows):** use PowerShell for `aws ssm put-parameter` (Git Bash rewrites paths that
  start with `/`); repeat `-c alertEmail=...` on every `deploy:alerts` or the email subscription is removed.
