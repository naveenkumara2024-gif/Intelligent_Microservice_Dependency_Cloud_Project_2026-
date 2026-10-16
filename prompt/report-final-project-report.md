# Report prompt — BCSE355L AWS Cloud Project Report (final, in the course template)

Status: **DRAFT 2026-10-15, awaiting the user's review. Not executed.** Execution starts only after
(a) the user confirms the live deployment is up (next `npm run up` session), (b) the inputs in §2 are
answered, and (c) the user approves this prompt. Follow the CLAUDE.md stage protocol: present each
phase's output, show real command output, never commit or push without separate approval.

---

## 0. The task in one paragraph

Produce the final project report as a Word document that **is the course template filled in**, not
a look-alike: open a copy of `Docs/AWS_Cloud_Project_Report_Template.docx`, keep its page setup,
styles, headings, tables and footer, replace every bracketed placeholder with accurate,
evidence-backed content about this project, remove the template's instruction text, and deliver
`Docs/AWS_Cloud_Project_Report_Final.docx` plus a Word-rendered `Docs/AWS_Cloud_Project_Report_Final.pdf`.
Every number, status and claim must trace to a source in this repository or to evidence captured in
the live session (§5). Readers are the course evaluators (Dr. Priya V and the BCSE355L review panel):
formal academic register, third person ("this project", "the system"), spelling as in the template
(British/Indian: organisation, analyse, authorisation, behaviour).

## 1. Sources of truth, in priority order

When two sources disagree, the higher one wins and the conflict is noted in the claims ledger (§9).

1. **Evidence captured in the live session** (`result/report-evidence/<date>/`, §5).
2. **As-built records**: `CLAUDE.md`, `PROJECT_STATUS.md`, the "as run" / "as built" sections of
   `prompt/stage-*.md` (stages 03-15), `Docs/gnn-model-explained.md`,
   `src/ml-engine/models/boutique_eval.json`.
3. **Code and configuration**: `infra-cdk/lib/*.ts`, `infra-cdk/bin/app.ts`, `src/**`,
   `k8s/**`, `package.json` / lockfiles / `requirements*.txt` (for versions), test suites (run them
   for counts; do not copy old counts).
4. **Git history**: `git log`, `git shortlog -sne --all`, branches, and `gh pr list --state all`
   if `gh` is authenticated (read-only).
5. **Phase-1 documents** (`Docs/Phase1_Report_Microservice_Analysis_v2.docx`,
   `Docs/Novelty_Summary (1).docx`, `Docs/lit_survey_papers_1_5.docx`): use ONLY for the 15-paper
   list, the students' own gap analyses, the original objectives and task allocation, and as the
   "planned" side of planned-vs-built. They contain known errors (§4); never copy a Phase-1 fact
   without checking it against 1-4.

Read every one of these before writing. Do not rely on memory or general knowledge for any
project fact.

## 2. Inputs needed from the user before writing (blocking)

| # | Input | Why |
|---|---|---|
| 1 | Full names and register numbers of every team member | Cover page, contribution table |
| 2 | Programme / branch / year | Cover page |
| 3 | Team number (or "Individual project") | Cover page |
| 4 | Who the third student is, if any. Phase-1 and the template assume 3 students (A: papers 1-5, B: 6-10, C: 11-15); git shows 2 authors (A Naveen Kumar, Kabilesh SN) | Contribution table, gap analysis ownership |
| 5 | What each member actually did (to be checked against git) | Chapter 12 must not invent contributions |
| 6 | Approved project title: the Phase-1 title "Intelligent Microservice Dependency Analysis Framework for Online Shopping Platforms using Knowledge Graphs" (default) or the current "Intelligent Microservice Dependency Analysis & RCA Framework" | Cover page, header text |
| 7 | Date of submission (DD/MM/YYYY) | Cover page |
| 8 | Diagrams: agent redraws both as-built diagrams (default, §7) or the user re-exports them from eraser.io using the correction list in §7 | Figures 1-2 |
| 9 | Screenshot masking: mask the AWS account ID, email addresses and CloudFront domain (default) or show the domain | Every screenshot |

Use `[TO CONFIRM: ...]` only in the review draft for an unanswered input; the final document must
contain none.

## 3. Template contract (measured from the template file on 2026-10-15)

Work on a **copy** of the template with python-docx (installed: 1.2.0); never rebuild the document
from scratch, never pretty-print or reformat its XML. Measured properties to preserve:

- US Letter 8.5 x 11 in, portrait, 1.0 in margins all round, one section; footer = centred `PAGE`
  field (page numbers bottom centre).
- `Normal`: Times New Roman 12 pt, line spacing 1.5. `Heading 1`: TNR 16 pt bold, colour 365F91,
  24 pt before. `Heading 2`: TNR 14 pt bold, colour 4F81BD, 10 pt before. Lists use the built-in
  `List Bullet` / `List Number` styles (never literal bullet characters).
- 11 tables, style `Table Grid`; header row bold TNR 10 pt shaded `D9EAF7`; body cells TNR 10 pt,
  not italic. Add rows by deep-copying an existing body row (keeps borders, widths, fonts); delete
  unused placeholder rows. Long tables (literature, gap analysis) must repeat the header row on each
  page (`w:tblHeader`) and must not split a row across pages (`w:cantSplit`).
- Placeholders are grey italic (`5A5A5A`) `[bracketed]` paragraphs: replace each with normal body
  text (remove the grey colour and italics), keeping the paragraph's style.
- Figure captions follow the template's form: a `Normal` paragraph "Figure N. Caption." directly
  below the image, numbered in order of appearance and referred to in the text ("Figure 3 shows ...").
  Tables keep the template's convention (no captions) unless a table is added by us; added tables get
  "Table N. Caption." above them.
- **Remove before submission** (the template says so): the "Document Preparation Instructions"
  page, and every guidance sentence addressed to the student, e.g. "Review 15 relevant research
  papers...", "Write 4-6 specific, measurable, achievable objectives.", "Limit this section to
  approximately one page...", "Complete this section if the project uses a dataset...", "List only
  services relevant to this project...", "For Phase I, document completed work...", "For team
  projects, clearly document...", "Use APA style consistently...", "Suggested structure:" (replace
  that list with the real repository structure), and "In Microsoft Word, use References -> Table of
  Contents...".
- **Table of Contents**: replace the static bullet list with a real Word TOC field (Heading 1-2),
  updated by Word (§10). **Resolve the template's own inconsistency**: its static list has 14
  chapters with a separate "3. Research Gap Analysis", but its body headings number 13 chapters
  with the gap analysis inside chapter 2 (2.2, 2.3). Follow the body headings; the TOC field then
  matches automatically.
- Keep every body heading's exact text and numbering (e.g. "5.2 Diagram 1 – AWS Cloud
  Architecture (Mandatory)"). Do not add or rename chapters; extra sub-sections (e.g. "10.5") only
  where the content needs one, numbered consistently.
- **References**: the template asks for APA style but shows a numbered list "[1] Author(s). (Year).
  Title...". Do exactly that: APA 7 entries in a numbered list, where reference [n] is paper Pn for
  n = 1-15, then [16]+ for datasets, AWS documentation, libraries and tools. In-text citations use
  APA author-date form, e.g. "(Wang et al., 2024)", and the literature table's Paper ID column uses
  P1-P15.
- **Appendix B – Review Checklist**: keep it; tick (☑) only items that are actually satisfied and
  leave the rest ☐ with a one-line reason.

## 4. Known errors in the Phase-1 documents (do not repeat them)

| Phase-1 statement | What is actually true (source) |
|---|---|
| Dataset "~50 GB", "over 10 million spans", "15+ features (... Status Code)", "MIT license" | Alibaba `cluster-trace-microservices-v2021`, MS_CallGraph table; one part file used (`MSCallGraph_0`, ~154 MB compressed, ~6.09M rows); 8 data columns `traceid, timestamp, rpcid, um, rpctype, dm, interface, rt` (+ a leading index), `dm` BEFORE `interface`; **no status/error column**; rpctypes rpc, db, mc, http, mq, userDefined. Licence: verify on the dataset repository; do not state MIT unless the repository says so. (CLAUDE.md "Critical, verified dataset facts", `prompt/stage1and2md`) |
| QuickSight dashboard | Custom dashboard: Vite + React 19 + Cytoscape.js SPA on S3 + CloudFront, API Gateway HTTP API (Stage 13). QuickSight was not used: state the change and why |
| API Gateway "REST/WebSocket" | HTTP API, 4 GET routes, stage throttle 5 rps / burst 10, read-only (Stage 13) |
| "Better Algorithm", "infinitely scalable", "predicts cascading failures before they reach users", "first" | The contribution is the **streaming, continuously updated, cloud-deployed system** around graph-based RCA, not a new GNN; scale was demonstrated on Online Boutique only; the system detects and ranks a fault after it is observed (1-minute windows), it does not forecast. (CLAUDE.md "Novelty framing") |
| Neptune read replica, ALB, NAT per AZ (architecture diagrams) | Writer only by default (`-c neptuneReplica=true` adds the replica); one NAT gateway; no load balancer (NLBs refused on the account; storefront reached by port-forward) |
| "Automatic schema discovery", "authenticated and encrypted trace data" | Neptune is schema-less (new services appear as new vertices); MSK is TLS in transit with **unauthenticated clients restricted by security group** (port 9094 from private-app only), not client authentication |
| Repository "ShoppingPlatform_MicroserviceKG_Cloud_Project_2026" | Actual repository: https://github.com/naveenkumara2024-gif/Intelligent_Microservice_Dependency_Cloud_Project_2026- (state the actual URL; mention the planned name only if relevant) |
| Literature entries (URLs truncated, MDPI ID/year mismatches, e.g. "2079-9292/15/11/235" labelled 2024 while volume 15 is 2026) | Verify every paper (§6) |

## 5. Evidence to capture in the live session (do this BEFORE `npm run down`)

The report's live chapters need fresh evidence; nothing can be captured after teardown. Store
everything under `result/report-evidence/<YYYY-MM-DD>/` (keep raw outputs out of git until masked:
they contain the account ID and ARNs).

**Text evidence (the agent runs these, read-only or verification scripts, saving full output):**
`npm run up` timing summary (the user's terminal; paste it), `verify:eks`, `verify:msk`,
`verify:transformer`, `verify:live`, `verify:sagemaker`, `verify:dashboard -- --topology`,
`verify:demo` (latency fault; the full run), `npm run probe -- stats` / `edges`, a sample incident
item from `rca-incidents` (masked), `aws cloudformation list-stacks` (deployed set),
CloudWatch metrics for the demo window (scorer invocations/errors/duration, SNS delivered/failed,
SageMaker invocations/latency), then after the session `npm run down` timing summary and
`verify:teardown`. Record the actual session cost from Cost Explorer
(`aws ce get-cost-and-usage`, daily, the session's dates; note each call costs USD 0.01).

**Screenshots (the user takes these in the AWS console / browser; the agent may capture the
dashboard with headless Edge/Chrome):**
1. CloudFormation stacks list (all 11 `CREATE_COMPLETE`).
2. EKS cluster overview + node group (2 nodes, 2 AZs); `kubectl get pods -A` terminal.
3. MSK cluster (ACTIVE, 2 brokers) and its topics (terminal is fine).
4. Neptune cluster (available, `db.t4g.medium`, engine 1.4.8.0).
5. SageMaker endpoint `rca-root-cause` InService (serverless config visible).
6. Lambda functions list; the transformer's MSK trigger enabled.
7. DynamoDB `rca-incidents` item for the demo incident (opened -> resolved).
8. SNS email alert received ("[RCA] Incident opened" and "... resolved"), sender visible, recipient masked.
9. Dashboard (CloudFront URL masked): healthy topology; during the fault with the "Slow now" marker
   and the open incident; after resolution.
10. CloudWatch: scorer log lines for the fault window; a metric graph of edge latency or scorer runs.
11. VPC resource map (subnets in 3 tiers, endpoints).
12. GitHub repository page, branch list, and commit history.
13. AWS Budgets page showing the budget alert (amount visible, account masked).

Each screenshot: PNG, full window, date visible where possible, file name `NN-short-name.png`.
Mask the account ID, email addresses and secrets before insertion (a filled rectangle, not blur).

## 6. Literature survey rules (chapter 2)

- Start from the 15 papers in the Phase-1 table (P1-P15 in that order). **Verify each one** with
  WebFetch/WebSearch: the title exists at the URL/DOI, the authors, year, venue, volume/issue/pages
  or arXiv ID, and that the claimed method/dataset/findings are in the paper (read the abstract at
  least). Record each check in the claims ledger.
- If a paper cannot be verified, or its year/venue differs from Phase-1, correct it; if it does not
  exist or does not match, **stop and report it to the user** with a proposed replacement (2023-2026,
  IEEE/ACM/Springer/Elsevier/Wiley/MDPI/Nature/Scopus-indexed preferred). Never invent authors,
  DOIs or findings. Note in the ledger which sources are arXiv preprints rather than peer-reviewed.
- Table 0 (literature): one row per paper with full APA citation + DOI/URL, problem, method/
  architecture, dataset/evaluation, key findings, in the paper's own terms.
- 2.1 Synthesis: compare by approach (causal graph, GNN, LLM/agentic, rule-based, tracing
  pipelines), data used (traces, logs, metrics; offline benchmark vs live), evaluation (offline
  datasets vs deployed), cloud integration, cost and limitations; name trends and conflicts; end
  with where this project sits (streaming cloud deployment of graph-based RCA).
- 2.2 Individual research gap analysis (Table 1): one row per paper, grouped by student, using the
  **students' own Phase-1 analyses** (method, advantages, limitations, gap, improvement), lightly
  edited for the column format; attribute each block to its student by name. Do not author new
  "independent" gaps on a student's behalf; anything newly written is marked for that student's
  review in the draft.
- 2.3 Consolidated gap: most graph-based RCA work is evaluated offline on static snapshots or
  benchmarks; few systems continuously build the dependency graph from live traces and score it in
  a deployed cloud pipeline with alerting. Support it with specific papers from the table.

## 7. Figures

- **Figure 1, AWS Cloud Architecture (as built)** and **Figure 2, Complete System Architecture
  (as built)** are mandatory. The PNGs in `Architecture/` are the Phase-1 designs (30 July) and are
  wrong in the points of §4 and also miss: the scorer Lambda (EventBridge `rate(1 minute)`), the
  alert dispatcher + Slack/PagerDuty Lambdas + SQS DLQ, the Lambda and STS interface endpoints, the
  probe Lambda, the API Lambdas, CloudFront + S3 (outside the VPC), Secrets Manager, KMS keys, and
  they show "OTLP -> Kafka via NAT" (the collector reaches MSK directly, private-app -> private-data
  on 9094). Their dark background also prints poorly. Redraw both (light background, AWS service
  names on every box, labelled arrows, VPC/AZ/subnet tiers for Figure 1; layers input -> streaming
  -> graph -> ML -> incidents -> alerts/dashboard with the feedback/monitoring loop for Figure 2),
  as SVG rasterised to PNG at >= 2000 px wide (headless Edge/Chrome), from the component list in
  `infra-cdk/lib/*.ts` and `bin/app.ts`, not from memory. Keep the Phase-1 diagrams only as an
  appendix figure "planned design (Phase I)" if the user wants the comparison.
- Figure 3: the fault-to-alert sequence (fault injected -> slower spans -> MSK -> transformer ->
  Neptune counters -> scorer window delta -> gate -> SageMaker ranking -> incident (2 windows) ->
  SNS -> email/Slack/PagerDuty; resolution after 3 clean windows).
- Figure 4: the GNN (GATv2Conv -> 3 x SAGEConv -> linear score per node) and the root-cause
  fingerprint (high own delta, normal downstream delta) from `Docs/gnn-model-explained.md`.
- Figures 5+: the screenshots of §5 in a sensible order, each referenced in the text.
- Optional charts (matplotlib, saved PNG): latency into productcatalogservice before/during/after
  the fault from the `verify:demo` output; model accuracy vs trivial and random baselines.

## 8. Chapter-by-chapter content (template headings; target lengths are guidance)

**Cover page.** Title (input 6), "Submitted by" names + register numbers, programme, course
"BCSE355L – Cloud Architecture Design" (keep), institution (keep), guide "Dr. Priya V" (keep), team
number, GitHub URL (actual), submission date.

**Abstract (200-300 words, count it) + Keywords (4-6).** Problem (cascading failures, alert
fatigue, MTTR), existing challenge, the solution (live OTel traces -> MSK -> Lambda -> Neptune
graph -> scheduled scoring with a hosted GNN -> DynamoDB incidents -> SNS alerts + dashboard), AWS
services, method (synthetic fault injection for labels, fine-tuning), status and the headline live
result (one real latency fault: incident in 0.6 min, root cause ranked #1 at 0.932, resolved 3.9
min after clearing, one alert each way), and the honest limit (single-fault demo, synthetic labels).

**1. Introduction** (1.1-1.5, ~2 pages). Background: microservices, distributed tracing,
observability on AWS. Problem statement: symptom vs origin (checkout slow, payment/inventory at
fault). Motivation: MTTR, alert fatigue. Scope: included (Online Boutique on EKS, 7 span-emitting
services, latency faults, single region us-east-1) and excluded (multi-fault, services that emit no
spans: cart, shipping, ad, redis, loadgenerator; production load; user authentication). 1.5
describes chapters 2-13.

**2. Literature Survey** (§6).

**3. Project Objectives** (4-6, measurable). Restate the Phase-1 objectives as measurable criteria
and say which changed, e.g.: (1) build the dependency graph continuously from live traces (criterion:
live edges in Neptune with growing counters, `verify:live` 8/8, 14 edges); (2) store a queryable
knowledge graph in Neptune with parity to the Stage-2 Neo4j prototype (criterion: identical top-2,000
and full 16,115-edge graph); (3) rank the root cause with a GNN served on SageMaker (criterion:
Boutique synthetic gate top-1 >= 60 %, top-3 >= 90 %; endpoint parity with local inference);
(4) open, update and resolve incidents and alert exactly once per transition (criterion:
`verify:incidents`, `verify:alerts`, `verify:demo`); (5) show live topology and incidents on a
dashboard (criterion: `verify:dashboard`; QuickSight replaced by the custom dashboard).
3.1 Expected outcomes mapped to evidence.

**4. Novelty Summary (about one page).** Fill the 4-row table: new feature = streaming trace-to-
graph transformation with continuously updated weighted edges; algorithm/processing = graph-based
ranking applied to live window deltas against learned baselines, with a gate that calls the model
only when a service is >= 2x its baseline (existing work: offline snapshots); cloud architecture =
the end-to-end AWS deployment and its verification; security/automation = least-privilege IAM,
private data subnets with no internet route, VPC endpoints, KMS, IaC with one-command up/down.
"How demonstrated" cites the verification run. Then 3-5 sentences stating the claim with the
CLAUDE.md framing; no "first", no new-algorithm claim.

**5. Proposed System and Architecture.** 5.1 overview (users: SRE/on-call, inputs: spans,
outputs: incidents, alerts, dashboard). 5.2 Figure 1 + component roles and data flow. 5.3 Figure 2
+ workflow. 5.4 numbered workflow / Figure 3. 5.5 security, availability, scalability: IAM per
consumer (e.g. scorer has `neptune-db:ReadDataViaQuery` only; transformer needed
`DeleteDataViaQuery` for property overwrites), Neptune IAM auth with SigV4, KMS at rest
(Neptune, DynamoDB, SNS), TLS in transit, private-data subnets without an internet route, VPC
endpoints, origin-secret guard on the API (state plainly: not user authentication), multi-AZ
(EKS nodes in 2 AZs, MSK brokers in 2 AZs, Neptune writer + optional replica), DLQ + alarm, TTL,
budget alert, and what is single-AZ or single-instance.

**6. Dataset Description.** Fill the 11-row table with verified facts (§4), measured sizes
(`Dataset/raw`, `Dataset/processed`), and record counts from the preprocessing log or by counting.
Explain the RPC double-recording dedup with `abs(rt)`, filtering of NAN/(?)/empty names with
counts, aggregation into 7,384 service nodes and 16,115 edges, that labels come from synthetic fault
injection (no failure column), that Online Boutique live traffic is the second data source, and
that names are anonymised hashes (privacy). 6.1: scenario generation and train/val/test splits as
implemented in `src/ml-engine` (read the code), leakage control, Boutique topology held out in
fine-tuning.

**7. AWS Services Planning.** Replace the generic rows with the services actually used, each
"Deployed" or "Tested" with the stage that verified it: VPC (+ NAT, IGW, gateway endpoints S3/
DynamoDB, interface endpoints SageMaker Runtime/SNS/Lambda/STS, reject flow log), EKS, MSK, Lambda
(transformer, scorer, probe, alert dispatcher, Slack, PagerDuty, API incidents, API topology),
EventBridge schedule, Neptune, DynamoDB (+ Streams, TTL), SageMaker serverless, SNS + SQS DLQ,
API Gateway HTTP API, S3 + CloudFront, CloudWatch, IAM, KMS, Secrets Manager, SSM Parameter Store,
AWS Budgets. Not used: RDS, EC2 outside EKS, Cognito, QuickSight; say why. 7.1 deployment and
network design: us-east-1, 10.0.0.0/16, 2 AZs, 3 subnet tiers, security groups, CDK stacks and
their dependency order, `npm run up` / `down` (Stage 15). 7.2 cost: (a) **measured** session cost
from Cost Explorer (§5) and the recorded earlier sessions (about USD 3 for ~4 h, Stages 7b-9c);
(b) an **estimated** monthly cost if left running 24 x 7, computed from current prices fetched
with `aws pricing get-products` (state the date) for each billable resource; (c) cost controls
(budget alert, tear-down between sessions, serverless SageMaker, on-demand DynamoDB, one NAT).
Label estimates as estimates.

**8. Methodology and Implementation Plan.** 8.1 the staged method (stages 0-15 with checkpoints,
local stand-ins before AWS: Neo4j, Gremlin Server, DynamoDB Local). 8.2 tools table with exact
versions read from the repo (CDK CLI, aws-cdk-lib, TypeScript, Node runtimes, Python, PyTorch, PyG,
gremlin 3.7.3, Neptune 1.4.8.0, Kafka version, EKS 1.35, Online Boutique v0.10.7, React, Vite,
Cytoscape, Jest, pytest), GitHub. 8.3 the seven steps mapped to stages. 8.4 metrics: top-1/top-3
ranking accuracy (synthetic), detection delay, resolution delay, alert exactly-once, false
incidents in healthy soak, endpoint latency (cold/warm), scorer run time, deploy/teardown time, cost.

**9. Implementation / Development.** 9.1 modules table, one row per module (telemetry + collector,
streaming, graph transformer, graph store, GNN training, model serving, scorer + incidents,
alerting, dashboard + API, fault injection, session automation), each with evidence = verification
result + commit hash/branch. 9.2 screenshots (§5) with explanations. 9.3 repository: actual URL, real
folder structure (`infra-cdk/`, `src/collector`, `src/lambda-transformer`, `src/ml-engine`,
`src/web-dashboard`, `k8s/`, `Dataset/`, `Docs/`, `Architecture/`, `prompt/`, `result/`).

**10. Testing, Results and Observations.** 10.1 test table T01-Tnn: one row per verification
script and the unit/integration suites (counts from running them), each with input/setup,
expected, observed and Pass/Fail exactly as recorded; include security tests (raw execute-api URL
403 without/with a wrong header; unsigned Neptune request refused; private-data subnet has no
default route), performance (SageMaker cold 13.7 s / warm 1.9 s; scorer about 100 ms; deploy and
teardown times from §5), and failures honestly (dashboard concurrency burst 503s at the old limit of
10; CPU fault at 15m never reached traffic). 10.2 results: model evaluation (deployed weights,
`boutique_eval.json`): proportional top-1 65.5 % / top-3 98.7 % vs trivial 37.3 % / 98.0 % and
random 9.1 % / 27.3 %; **faithful** top-1 40.7 % / top-3 81.7 % vs trivial 21.2 % / 64.7 %;
Alibaba test after fine-tuning top-1 52.0 % / top-3 89.3 % (from 62.9 % / 91.8 %); live demo
(both 2026-10-14 and the new session's run, labelled separately). 10.3 baseline comparison: GNN vs
trivial argmax-of-input vs random on the same scenarios; Neptune vs Neo4j parity; streaming vs
the Stage-2 offline batch graph. 10.4 objectives -> evidence.

**11. Discussion, Limitations and Risk Analysis.** Discussion of what the results show and do not.
Limitations (all of these): synthetic labels; one single-service latency fault (one or two runs, not
a statistic); model fine-tuned on small Boutique-shaped graphs; 1 ms latency floor makes the gate
insensitive below about 2 ms; checkout/payment/email often below 20 calls/min so no baseline;
cartservice, shippingservice and adservice (and redis-cart, loadgenerator) emit no spans, so they
have no outgoing edges and cannot be blamed for their own downstream calls; Slack/PagerDuty HTTP delivery and SSM decryption unproven live;
dashboard guard is not authentication; no TLS minimum on the default CloudFront certificate; NLBs
refused on the account; single region. 11.3 risk table: fill the template rows with real
mitigations (budget alert, `npm run down` + `verify:teardown`, `.gitignore` for secrets, SSM
SecureStrings, least privilege) plus project risks (account quotas, Lambda concurrency, MSK create
time, model domain shift).

**12. Team Contribution and GitHub Management.** Contribution table from input 5, checked against
`git shortlog` and branch history; columns per student (mark absent ones "Not applicable").
12.1 workflow actually used: one branch per stage (`stage-N-...`), `--no-ff` merges into `main`,
team branches `backend`, `frontend`, `aws-cloud-mlmodel` on origin; PRs and reviews only if they
exist. 12.2 evidence per student: GitHub username, commit count, key commits, PRs. Report the real
numbers even where they fall short of the guideline (20-30 commits per student, 2+ PRs); do not
pad.

**13. Conclusion and Future Enhancements.** Conclusion tied to objectives and evidence. Future
work: real multi-fault and cascade experiments, temporal model features, instrumenting the silent
services (cart, shipping, ad), real Slack/PagerDuty delivery, ALB/Classic ELB public storefront, Cognito login for the
dashboard, packaging each Lambda's bundle separately, multi-region.

**References.** §3 format; [16]+ include at least: the Alibaba trace dataset, Online Boutique,
OpenTelemetry, the GATv2 paper (Brody, Alon & Yahav, ICLR 2022) and GraphSAGE (Hamilton, Ying &
Leskovec, NeurIPS 2017) for the layers used, PyTorch Geometric, and the AWS documentation pages
actually relied on (EKS, MSK, Neptune IAM auth, SageMaker serverless inference, Lambda MSK event
source, DynamoDB TTL/Streams). Verify every entry like the papers.

**Appendix A – Project Timeline.** Real dates per phase from git history and the stage notes
(Stages 0-2 2026-09-21 ... Stage 15 2026-10-15), owner = from input 5, status/evidence = checkpoint.
**Appendix B** per §3.

## 9. Accuracy rules (non-negotiable)

- Keep a **claims ledger** `Docs/report-build/claims.md`: every number, date, status and
  comparative statement in the report -> its source (file + section, evidence file, or URL checked
  on date). The report is not done while any claim lacks a source.
- Planned vs built: anything not verified live is written as planned/unproven, never as done.
- Units and precision as in the source; no rounding that changes meaning; percentages with the
  scenario counts behind them (e.g. 600 scenarios).
- No marketing words: "first", "novel algorithm", "infinitely", "real-time" (say "within one-minute
  scoring windows"), "guarantees", "production-ready".
- No secrets or personal data: no access keys, account ID, ARNs with the account, origin secret,
  webhook URLs, routing keys, email addresses other than names on the cover. Grep the final
  document text for `AKIA`, the 12-digit account ID, `@`, `hooks.slack.com`, `x-rca-origin` value.
- Do not paste terminal output wholesale into the body; summarise and put long outputs in an
  appendix only if the user wants it.

## 10. Build procedure

1. Write the content first as reviewable source: `Docs/report-build/content.md` (all prose, by
   template heading) and `Docs/report-build/tables.json` (every table's rows), plus `claims.md`.
   **Present this draft to the user for review before building the .docx.**
2. `Docs/report-build/build_report.py` (python-docx): copy the template to
   `Docs/AWS_Cloud_Project_Report_Final.docx`; fill cover fields; delete the instruction page and
   guidance sentences; replace placeholders by locating them by their exact template text (fail
   loudly if a placeholder is not found); fill tables by cloning rows; insert figures (max width
   6.5 in) with captions; replace the static TOC list with a TOC field; insert references.
3. Word (COM, available: Word 16) opens the result, updates all fields (TOC, page numbers), saves,
   and exports `Docs/AWS_Cloud_Project_Report_Final.pdf`.
4. Read the PDF pages and check visually: cover, TOC page numbers, every table (header repeat, no
   split rows, no overflow), every figure readable, no orphan headings, page numbers centred.

## 11. Quality gate (all must hold; report each with evidence)

- Abstract 200-300 words; 4-6 keywords; 4-6 objectives; novelty about one page; 15 verified papers;
  both mandatory diagrams; dataset table complete.
- Zero remaining `[` placeholders, zero grey-italic `5A5A5A` runs, zero template guidance sentences,
  zero `[TO CONFIRM` markers.
- Fonts TNR throughout; Heading 1 16 pt / Heading 2 14 pt bold; body 1.5 spacing; 1 in margins;
  page number bottom centre; Letter size.
- Every figure and every reference cited in the text; figure numbers sequential.
- Claims ledger complete; secrets grep clean.
- Test counts and verification results re-run or taken from the session's evidence, not from older
  notes.

## 12. Out of scope

Changing any code or infrastructure to make results look better; re-running the model training;
writing on behalf of a student's individual analysis without marking it for their review;
committing or pushing (separate approvals).
