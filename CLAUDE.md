# CLAUDE.md

This file gives any AI agent working in this repository full context before touching code. Read this in full before writing, editing, or deploying anything. If something here conflicts with what you're about to do, stop and flag it rather than proceeding on an assumption.

## Project identity

- **Name**: Intelligent Microservice Dependency Analysis & RCA (Root Cause Analysis) Framework
- **Course context**: BCSE355L — Cloud Architecture Design, School of Computer Science and Engineering, VIT Vellore
- **Repo naming convention**: `Intelligent-Microservice-RCA-Framework` (or `ShoppingPlatform_MicroserviceKG_Cloud_Project_2026` per the earlier GitHub collaboration doc — confirm which the team actually settled on before creating a new remote)
- **Status**: Architecture designed, IEEE Phase-I report written, Review-I completed. Implementation is now in progress, stage by stage (see "Build order" below). Do not assume later stages are done just because earlier planning docs exist.

## The problem this project solves

Large microservice platforms (e-commerce style) generate cascading failures where the customer-visible symptom (e.g. "checkout is slow") is rarely where the fault originates (e.g. a slow downstream payment or inventory service). Traditional per-service metric dashboards cause alert fatigue (many services light up for one root cause) and high MTTR (engineers manually trace logs across services). This project treats the whole system as a live dependency **graph** (services = nodes, calls = weighted edges) and uses a **Graph Neural Network** to identify which node structurally explains a pattern of degradation — i.e., the actual root cause and its blast radius — rather than just flagging every symptom independently.

**Novelty framing (keep consistent across any docs/report text you write):** the contribution is NOT a new GNN algorithm — graph-based RCA is existing, active research (see the 15-paper literature survey). The contribution is a **streaming, continuously-updated, cloud-deployed system** around that idea: live OTel ingestion → continuously updated knowledge graph → hosted GNN inference → automated alerting, versus prior work's typical offline/static-snapshot evaluation. Don't let generated content overclaim ML novelty.

## End-to-end architecture (target state — not all deployed simultaneously)

| Tier | AWS service | Role |
|---|---|---|
| Compute | Amazon EKS (multi-AZ managed node groups) | Hosts the actual microservices (demo app: Online Boutique or similar) |
| Telemetry capture | OpenTelemetry Collector (K8s DaemonSet) | Zero-code interception of RPC/gRPC calls, emits OTLP spans |
| Streaming | Amazon MSK (Kafka) | Durable buffer absorbing bursty trace volume; topics: `otel.traces`, `otel.metrics`, `svc.events` |
| Graph transform | AWS Lambda (TypeScript), MSK Event Source Mapping | Converts flat spans into Gremlin graph upserts |
| Knowledge graph | Amazon Neptune (primary writer AZ-1, read replica AZ-2) | Stores services as vertices, calls as weighted directed edges |
| Incident state | Amazon DynamoDB (TTL enabled) | Historical RCA/incident records |
| AI inference | Amazon SageMaker (hosted GNN endpoint) | Scores graph snapshots for anomaly/root-cause/blast-radius |
| Observability | Amazon CloudWatch | Logs/metrics for Lambda, SageMaker, system health |
| API | Amazon API Gateway | Serves topology reads (Neptune) and incident history (DynamoDB) to the dashboard |
| Visualization | Custom web dashboard (S3 + CloudFront + Cytoscape.js) and/or Amazon QuickSight | Live topology graph + executive metrics |
| Alerting | Amazon SNS → Lambda subscribers | Dispatches to Slack (Block Kit webhook) and PagerDuty (Events API v2) |
| Network | VPC (10.0.0.0/16, us-east-1), public/private-app/private-data subnet tiers, NAT/IGW/ALB, VPC endpoints for SageMaker/DynamoDB/SNS, KMS encryption at rest | Multi-AZ isolation; private data subnets have no internet route |

## Tech stack (do not deviate without discussion)

- **TypeScript**: AWS CDK infrastructure code, the Lambda graph-transformer
- **Python**: dataset preprocessing, GNN training (PyTorch + PyTorch Geometric), SageMaker inference script
- **Cypher (Neo4j)** locally in early stages → **Gremlin (Neptune)** once deployed — these are functionally parallel, not identical; don't assume Cypher syntax works against Neptune untranslated

## Repository structure

```
Intelligent_Microservice_Dependency_Cloud_Project_2026-/   # actual folder name on disk
├── .github/workflows/
├── Architecture/                 # diagrams (case-insensitive match for "architecture/" on Windows)
├── Docs/                         # literature survey, novelty summary, phase-1 report (.docx)
├── infra-cdk/
│   ├── bin/app.ts
│   └── lib/                     # vpc-stack.ts, eks-stack.ts, msk-stack.ts,
│                                 # neptune-stack.ts, dynamodb-stack.ts,
│                                 # sagemaker-stack.ts, frontend-stack.ts,
│                                 # infra-cdk-stack.ts (default cdk-init leftover, unused)
├── src/
│   ├── collector/                # OTel Collector DaemonSet config
│   ├── lambda-transformer/       # TypeScript, MSK → Neptune
│   ├── ml-engine/                 # Python, GNN train + inference
│   └── web-dashboard/             # React + Cytoscape.js, deployed S3+CloudFront
├── Dataset/                       # case-insensitive match for "dataset/" on Windows
│   ├── raw/                       # downloaded Alibaba trace subset (gitignored, ~1.4GB)
│   ├── processed/                 # nodes.csv, edges.csv output (gitignored, regenerable)
│   ├── preprocess_traces.py
│   └── load_to_neo4j.py
├── docker-compose.yml             # local Neo4j 5 community (Stage 2)
├── prompt/                        # one saved prompt per implemented stage —
│   │                               # NOTE: folder is singular "prompt/", not "prompts/";
│   │                               # current filenames (stage0.md, stage1and2md) don't yet
│   │                               # follow the stage-NN-name.md convention below
│   └── stage-00-environment-setup.md   # convention to use going forward
├── result/                        # empty placeholder, purpose TBD
├── README.md
└── CLAUDE.md                      # this file
```

## Build order (do not skip stages or assume a later stage works without its checkpoint passing)

0. Environment setup (tools installed, AWS IAM user + **budget alert set**, repo scaffolded)
1. Dataset acquisition + `preprocess_traces.py` (local, no AWS)
2. Local graph prototype in Neo4j (Docker) — free stand-in for Neptune
3. GNN model trained offline (PyTorch Geometric, synthetic fault injection for labels)
4. CDK infra scaffolding + `cdk synth` validated
5. Core networking (VPC, IAM roles, VPC endpoints)
6. Microservices + OTel Collector deployed to EKS
7. MSK streaming pipeline wired
8. Lambda graph transformer deployed (port logic from step 1)
9. Neptune deployed, live topology verified against Stage 2's Neo4j prototype
10. SageMaker endpoint hosting the trained model
11. DynamoDB incident persistence
12. SNS alerting (Slack/PagerDuty)
13. Web dashboard + API Gateway
14. End-to-end fault-injection demo rehearsal
15. Ongoing: `cdk destroy` idle stacks between sessions to control cost

**Stages 0–2 complete, checkpoints passed (2026-09-21). Ready to start Stage 3.**

## Stage implementation protocol

When told to implement a specific stage (e.g. "implement Stage 3"), follow this sequence — do not skip straight to writing files or running commands:

1. Produce a complete, self-contained master prompt/spec for that stage first: what's being built, exact files to create or modify, exact commands to run, any schema/API details already confirmed in this document, known nuances/gotchas relevant to that stage, and the specific checkpoint that defines "done." Save this as its own file in `prompt/` (e.g. `prompt/stage-03-gnn-training.md`) before presenting it, so there's a durable, reviewable record of exactly what was planned and approved for each stage.
2. Present that master prompt and explicitly ask for confirmation before executing anything. No file writes, no `cdk deploy`, no `docker run`, no destructive or resource-creating commands until the user has reviewed the plan and approved it.
3. Only after explicit approval, execute the stage — showing real command output at each step, not a summary or a claim of success without evidence.
4. Stop and re-confirm before moving to the next stage. Do not chain multiple stages together on a single approval.
5. Once a stage's checkpoint passes, do not commit or push automatically — this is a separate approval from step 2. Show a summary of what changed (`git status` / `git diff` or equivalent) and explicitly ask for permission before `git commit`, then ask again before `git push`. Never assume a passed checkpoint implies consent to commit or push.

The point is to prevent a large, hard-to-undo mistake (a bad AWS deploy, a corrupted dataset transform, an overwritten file, an unwanted commit history) from happening before the user has actually seen what was about to run.

## Critical, verified dataset facts — do not regenerate these from assumption

Source of truth: the actual downloaded `MSCallGraph_0.csv` file, inspected directly with pandas during Stage 1 (2026-09-21) — the dataset's own docs/fetchData.sh comments are NOT reliable for schema details; always verify against the real file, not this doc or general knowledge.

`MS_CallGraph_Table` raw columns — **the CSV DOES have a header row** (a leading unnamed index column, then):
```
traceid, timestamp, rpcid, um, rpctype, dm, interface, rt
```
Note `dm` comes before `interface` — a commonly-assumed order of `..., interface, dm, rt` is WRONG and will silently swap those two columns.

Actual `rpctype` values observed in part 0: `rpc`, `db`, `mc`, `http`, `mq`, and also `userDefined` (not documented anywhere) — treat `userDefined` like the other non-`rpc` types (no dedup, `abs(rt)` defensively).

Nuances that WILL cause silent bugs if ignored:

- **No error/status/failure column exists in this table.** Do not invent an `error_rate` field from this raw data — any fault/anomaly label has to come from synthetic injection at the GNN training stage (Stage 3), not from the dataset itself. If you see generated code or docs implying the raw dataset has error rates, that's wrong — correct it.
- **`rpcid` is hierarchical** (e.g. `0.1.1.2.50`); the parent call's rpcid is this string with its last `.`-segment removed. Useful for reconstructing per-trace call trees, not just flat pairwise edges.
- **RPC calls (`rpctype == "rpc"`) are recorded TWICE** per `(traceid, rpcid)` — once logged by the um (positive `rt` = um's round-trip time) and once by the dm (negative `rt` = negative of dm's processing time). Must deduplicate to one edge per call using `abs(rt)`; do not sum or average the signed values together, and do not treat both rows as separate calls.
- Non-RPC rows (`db`, `mc`, `http`, `mq`) don't follow the same double-recording pattern — don't apply the RPC dedup logic to them.
- Service names (`um`/`dm`) are **anonymized hashes**, not readable names like `payment-service`. Some rows have missing/garbage values (`NAN`, `(?)`, empty string) — filter these, log counts, don't silently drop without reporting.
- Full `MSCallGraph` directory is ~25GB across many part files (`MSCallGraph_<N>.tar.gz`). Never download the whole thing for prototyping — one part file is more than enough (part 0 alone is ~154MB compressed and ~6.09M rows, well over "hundreds of thousands").

## Cost and safety guardrails

- **Never deploy Neptune, MSK, or a SageMaker endpoint without confirming an AWS budget alert exists first.** These bill hourly even when idle.
- Prefer `cdk synth` to validate before every `cdk deploy`.
- Default to tearing down (`cdk destroy`) non-essential stacks between work sessions unless explicitly told to leave something running for a demo.
- Never commit AWS access keys, `.env` files, or credentials — verify `.gitignore` covers them before any commit.
- IAM roles should move toward least-privilege over time; `AdministratorAccess` on the dev IAM user is a Stage-0 bootstrap convenience, not a permanent state — flag if asked to add more permissions casually later.
- Don't fabricate AWS resource ARNs, endpoint URLs, or console screenshots — if something needs a real value from a deployed resource, say so and ask for it or fetch it via CLI, don't invent a plausible-looking placeholder and present it as real.

## Working conventions

- CDK stacks depend on each other in a fixed order: VPC first, then anything needing the VPC (Neptune, MSK, EKS), then SageMaker last (needs a trained model artifact to actually deploy). Don't reorder without reason.
- Cypher writes in `load_to_neo4j.py` must use `MERGE`, not `CREATE`, so re-running the script is idempotent.
- Batch graph writes (`UNWIND` + parameterized Cypher/Gremlin), never one statement per row in a loop — this is a real performance cliff at scale, not a style preference.
- Each stage has an explicit checkpoint (see stage list above / prior conversation history). Do not report a stage "done" without actually running and showing that checkpoint's output.
- If a stage's dataset, config, or AWS behavior doesn't match what's documented here, treat the live system as ground truth, but flag the mismatch so this file can be corrected — don't quietly work around a wrong assumption without surfacing it.

## Keeping this file current

This file should be updated (not just appended to) whenever: a stage is completed and verified, a schema/API assumption above turns out to be wrong, the repo structure changes, or a new architectural decision is made that a future session would need to know. Stale context here is worse than no context — correct it in place rather than leaving contradictory notes.
