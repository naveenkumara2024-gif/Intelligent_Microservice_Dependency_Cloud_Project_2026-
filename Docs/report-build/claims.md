# Claims ledger — AWS_Cloud_Project_Report_Final.docx

Every number, status and comparative statement in the report, with its source. "Evidence" means
`result/report-evidence/2026-10-15/` (gitignored; masked copies in `text-masked/`).

## Live system (15 October 2026)

| Claim | Source |
|---|---|
| 11 stacks deployed 15:50:17 → 16:30:59 UTC (~41 min) | CloudFormation stack events (VpcStack…TransformerStack), queried 2026-10-15 |
| verify:eks 4/4 (2 nodes in 1a/1b, 12 pods, collector 2/2, 7 services) | Evidence text/verify-eks.txt |
| verify:msk 5/5 (ACTIVE, 2 brokers, 200 messages, 3 topics) | text/verify-msk.txt |
| verify:transformer 5/5 (308 invocations, 29,391 spans, 14,581 calls, 0 errors) | text/verify-transformer.txt |
| verify:live 8/8 (14 edges, counters 15,389 → 17,247, newest span 4 s) | text/verify-live.txt |
| verify:sagemaker 6/6 (fault #1 at 0.939, parity 9.9e-10, malformed → 400) | text/verify-sagemaker.txt |
| verify:dashboard --topology 20 PASS / 2 WARN / 0 FAIL; burst 30 × 200 | text/verify-dashboard-topology.txt |
| verify:demo 19/19; 0.88 → 301.29 ms (x344), 982 → 619 calls/min; opened 1.1 min; #1 at 0.950; resolved 3.9 min; SNS 3/0; DLQ 0 | text/verify-demo-latency.txt |
| Incident record: blast radius recommendationservice (3.029 → 52.57 ms), at risk checkout/frontend/recommendation, windows 4 | text/incident-item.txt |
| Scorer runs: model calls 17:11:08–17:14:07, resolve at 17:16:59 | text/scorer-logs-fault-window.txt |
| Scorer metrics: 75 invocations, 0 errors, 0 throttles, avg 630 ms, max 17,302 ms | screenshots/10a-scorer-lambda-monitoring.png |
| ReadOnlyAccess session denied kms:Decrypt on incident items | screenshots/07c-dynamodb-cmk-denies-readonly.png |
| 647 tests pass (289 + 50 + 257 + 51) | text/test-suites.txt |
| Budget USD 50; USD 8.51 usage before credits (1–15 Oct) by service | screenshots/16-budgets.png; text/cost-evidence.txt (Cost Explorer, RECORD_TYPE=Usage) |
| Hourly prices (EKS 0.10, m7i-flex.large 0.09576, kafka.t3.small 0.0456, Neptune db.t4g.medium 0.093, NAT 0.045, endpoint 0.01) | text/cost-evidence.txt (AWS Price List API, us-east-1, 2026-10-15) |

## Earlier verified results

| Claim | Source |
|---|---|
| verify:demo 19/19 on 14 Oct (#1 at 0.932); CPU fault at 15m never reached traffic | prompt/stage-14-fault-injection-demo.md ("Phase 14b as run") |
| verify:vpc (6 Oct), verify:neptune (13 Oct, parity top-2,000 and 16,115 edges; unsigned refused; 8 writers) | CLAUDE.md Stages 5, 7b/8b/9b/9c; prompt/stage-07b-08b-09b-09c-live-session.md |
| verify:dynamodb 13/13; verify:incidents 22 PASS (3.2 min, 0.994, 4.0 min) | CLAUDE.md Stage 11; prompt/stage-11-incident-persistence.md |
| verify:alerts 18 PASS / 2 WARN | CLAUDE.md Stage 12 |
| 13 Oct burst: 503s at Lambda concurrency limit 10 | CLAUDE.md Stage 13b |
| SageMaker cold 13.7 s / warm 1.9 s | CLAUDE.md Stage 10 |
| Nine live-only defects | prompt/stage-07b-08b-09b-09c-live-session.md |

## Model and data

| Claim | Source |
|---|---|
| Boutique eval: proportional 65.5/98.7 (trivial 37.3/98.0, random 9.1/27.3); faithful 40.7/81.7 (trivial 21.2/64.7); 600 scenarios, 11 candidates, 12 nodes | src/ml-engine/models/boutique_eval.json |
| Alibaba test 62.9/91.8 → 52.0/89.3 after fine-tuning | CLAUDE.md Stage 10 |
| 3,000 scenarios, 70/15/15, 60 epochs, lr 1e-3 | src/ml-engine/train.py |
| Fine-tune: 8–30-service random graphs and ego subgraphs, Boutique held out | src/ml-engine/train_small.py docstring |
| Features (4 static + 3 dynamic node, 9 edge), GATv2 + 3 SAGE, fault injection details | Docs/gnn-model-explained.md |
| 6,088,846 records (6,088,847 lines incl. header); 1,329,657,626 B CSV; 161,892,812 B tar.gz | wc -l and ls on Dataset/raw, 2026-10-15 |
| 7,384 nodes, 16,115 edges | wc -l Dataset/processed/*.csv (minus header) |
| Schema, no error column, rpctypes, RPC double recording | CLAUDE.md "Critical, verified dataset facts" |
| 25 GiB, no licence file, "cite our paper" | github.com/alibaba/clusterdata/.../cluster-trace-microservices-v2021 (fetched 2026-10-15); GitHub license API: none |

## Literature (verified 2026-10-15)

| Paper | Verified against |
|---|---|
| P1, P2, P13 (MDPI, 2026, not 2024 as in Phase I) | Crossref DOI records + OpenAlex abstracts |
| P10 (Wiley SP&E 54(6) 1118–1140) | Crossref DOI 10.1002/spe.3317 |
| P11 (IEEE TSC 16(5) 3493–3507) | Crossref DOI 10.1109/tsc.2023.3293890 + OpenAlex abstract |
| P12 (CyS 27(3) 791–800; DOI 4498, not 4670 as in Phase I) | Crossref + journal page |
| P14 (Eastasouth JISCS 2(02) 265–274; content differs from Phase-I notes) | Crossref DOI 10.58812/esiscs.v2i02.1077 + abstract |
| P3–P9, P15 (arXiv; venues from Comments field) | arxiv.org/abs pages |
| [16] Luo et al. SoCC'21; [17]–[19] GATv2, GraphSAGE, PyG | Crossref; arXiv export API |
| [20]–[30] software and AWS documentation | URLs returned HTTP 200 on 2026-10-15 |
| P3 author order "Wang Dawei, Chen Liqun, Li Jin" read as family name first | arXiv listing (interpretation) |

## Git

| Claim | Source |
|---|---|
| 61 commits all branches; Naveen Kumar 53, Kabilesh SN 8; 32 with a Claude co-author trailer | git shortlog -sn --all; git log --all --format=%B |
| PRs #1–#9 and their branches; stage branches | git log --format="%ad %s" |
| GitHub: 56 commits on main, 14 branches, 3 contributors, usernames | screenshots/17-github-repository.png |
