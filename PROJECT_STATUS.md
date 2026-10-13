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
| 13a | Dashboard (React + Cytoscape) + read-only API + `FrontendStack` | Built and tested locally |

Tests passing: 282 unit (Lambdas), 46 (dashboard), 202 (infra), 51 (Python). Full `cdk synth` clean.

## In progress / not yet done

- **13b — live check of the dashboard.** Needs you to deploy (`deploy:dynamodb`, then
  `deploy:frontend`), then I run `verify:dashboard`. Known risk: CloudFront may refuse to create a
  distribution on a new account; if so we stop and decide.
- **Stage 13 is uncommitted** on branch `stage-13-dashboard-api`. Commit and merge need your approval.
- **Nothing has been pushed.** `main` (Stages 11 and 12) is ahead of `origin/main`.
- **Two stacks are still deployed** (idle, cents): `DynamodbStack`, `AlertingStack`. Tear down with
  `destroy:alerts` then `destroy:dynamodb` when finished.

## Next steps, in order

1. Deploy and verify Stage 13 tier 1 (DynamoDB only); then optionally tier 2 with Neptune
   (about 1 h, roughly $0.5).
2. Commit and merge Stage 13; decide when to push.
3. Optional: set the Slack webhook and PagerDuty key (SSM parameters) and re-run `verify:alerts`
   to prove the real HTTP legs (only unit-tested so far).
4. **Stage 14 — end-to-end fault-injection demo:** bring the whole stack up, inject a real fault
   into a Boutique service, and watch it flow through to an incident, an alert and the dashboard.
   Needs the public storefront switched from an NLB to an ALB/Classic ELB (see below).
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
