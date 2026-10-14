# Stage 14 — End-to-end fault-injection demo

Status: **APPROVED 2026-10-13 with all four recommendations (both faults, the API split, storefront private, Stage 13 committed first). Phase 14a COMPLETE (local, no AWS). Phase 14b latency fault VERIFIED LIVE 2026-10-14 (19/19); CPU fault at 15m never reached traffic. See "Phase 14b as run" at the end.**
- Spans flowing; soak produced 0 incidents and 0 model calls after warm-up.
- After the fault: the slowed edges' window latency rises in Neptune (read through the probe),
  the scorer's gate fires, the model is called.
- Exactly one incident opens within 5 windows; `root_cause` is the faulted service (reported
  as top-1 hit or miss, with the rank of the true service); `blast_radius` and `at_risk` listed.
- Exactly one "opened" alert published, SNS delivered, 0 failed; the incident is updated in place
  while the fault holds; no second open.
- After clearing: resolved within 6 windows, one "resolved" alert, DLQ empty, no Lambda errors.
- The fault was actually removed (deployment env and CPU limit back to the manifest).

Teardown: `fault clear` (always, even after a failure), then destroys in the usual order with
`npx tsx scripts/pre-destroy.ts` first; then the `--after-destroy` checks. I will remind you.

## Known unknowns (only the live run answers them)

- **Whether the model names productcatalogservice top-1** on a real fault where its callers slow
  down too. Synthetic Boutique top-1 was 65.5%; a real cascade is harder. A miss is a result to
  report honestly, not a reason to retune during the demo.
- **Whether 300 ms per call starves the loadgenerator** (10 users, so throughput falls). Too few
  calls per window would hide the fault from the scorer; the script reports calls per window and
  100 ms is the fallback delay.
- Whether the CPU-limit fault produces a large enough slowdown under this light load (measured).
- Neptune counter growth under slower traffic, and the 1 ms floor interplay (expected harmless at
  this size of fault).

## Cost

About 2-3 hours of the full stack (EKS nodes, NAT, MSK, Neptune, SageMaker serverless, Lambdas):
roughly $3-5 from the remaining credit, similar to the Stage 7b-11b sessions. Everything is
destroyed afterwards.

## Out of scope

Retuning scorer thresholds or retraining the model; multi-fault scenarios; chaos tooling (Chaos
Mesh, Litmus); faults in services that emit no spans (cart, shipping, ad, redis); load testing.

## Decisions I need from you

1. **Faults:** primary `EXTRA_LATENCY` only, or also the CPU-starvation fault (recommended both,
   the second only if the first passes)?
2. **Decision 8:** split the API out of `FrontendStack` so a live dashboard can join the demo
   without CloudFront (recommended), or wait for AWS Support?
3. **Public storefront:** keep it private (recommended), or switch `expose:storefront` to a
   Classic ELB for a presentation URL?
4. **Branching:** Stage 13 is still uncommitted on `stage-13-dashboard-api`. Commit Stage 13 first
   (recommended, so Stage 14 starts from a clean branch), or keep going on the same branch?

## Phase 14a as built (2026-10-13)

Stage 13 was committed first (`8cb8a8e`, branch `stage-13-dashboard-api`, not merged: 13b has not
passed); Stage 14 works on `stage-14-fault-injection`, branched from it.

Checkpoint 14a output (all run for real): infra **232 tests** (202 + 30 new: 13 fault-plan, 14
demo-live, and the split stack tests), full `cdk synth` clean for **11 stacks** (ApiStack added);
Lambda 282, dashboard 46, pytest 51, all unchanged and green.

What exists:
- `scripts/fault-plan.ts` (pure, tested) and `scripts/fault-k8s.ts` + `scripts/fault.ts`
  (`npm run fault -- latency|cpu|clear|status`). The undo is recorded in `infra-cdk/.fault-state.json`
  (gitignored) BEFORE the change is applied, so `clear` works even after a crash.
- `scripts/demo-live.ts` (pure verdict rules, tested with recorded timelines) and
  `scripts/verify-demo.ts` (`npm run verify:demo`), which clears the fault on every exit path it
  controls.
- **Decision 8, the split:** `lib/api-stack.ts` (secret, both Lambdas, HTTP API; no CloudFront) and
  `lib/frontend-stack.ts` (bucket, CloudFront, site deployment) taking the API and secret from it.
  `npm run deploy:api` deploys the API alone; `npm run dashboard:local` serves the SPA on
  http://127.0.0.1:5173 against the deployed API through a Vite proxy that adds the origin header
  (secret fetched from Secrets Manager into the dev server's environment, never printed or bundled);
  `npm run verify:dashboard -- --api-only` checks the API without CloudFront.

Verified locally, beyond the unit tests:
- **The fault commands are valid Kubernetes changes.** Rendered the real Boutique manifests with
  `kubectl kustomize`, applied the exact latency and CPU commands with `kubectl --local`, then their
  undo: the env and resources came back **identical to the manifest** (compared field by field).
- **The CPU fault must lower the request too** (100m request > 15m limit is rejected by the API
  server); the plan does both and restores both.
- **The dev proxy** was run against a throwaway upstream: it added `x-rca-origin`, kept path and
  query, the secret was absent from the served bundle, and a half-configured setup is refused.
- **Every new script, run against the account now, fails cleanly** with the next command to run
  (nothing deployed except DynamodbStack and the rolled-back FrontendStack).

Deviations and notes:
- `frontend` is excluded as a CPU target: nothing that emits spans calls it (the loadgenerator does
  not), so a slowdown there would not show on any edge.
- Ctrl-C cannot run cleanup (the scripts wait synchronously); the state file plus
  `npm run fault -- clear` covers that, and the script says so.
- The rolled-back `FrontendStack` still exists (old single-stack template). It must be deleted with
  `npm run destroy:frontend` before either new stack is deployed under that name; ApiStack is a new
  name and is unaffected.

## What 14b needs from you

1. Optional, cheap, and possible today: `npm run destroy:frontend` (clears the rolled-back stack),
   then `npm run deploy:api`, then I run `verify:dashboard -- --api-only` and you can open the live
   dashboard with `npm run dashboard:local`. That closes most of 13b without CloudFront.
2. The demo session (about 2-3 h, roughly $3-5 of credit), from `infra-cdk/`:
   `deploy:eks`, `deploy:msk`, `deploy:neptune`, `deploy:workloads`, `deploy:sagemaker`,
   `deploy:dynamodb`, `deploy:transformer -- -c graphBackend=neptune`, `deploy:scorer`,
   `deploy:alerts -- -c alertEmail=<addr>`, and optionally `deploy:api -- -c topology=neptune`.
   Then I run `npm run verify:demo` (latency fault) and, if it passes,
   `npm run verify:demo -- --fault=cpu --service=currencyservice`.
3. Teardown afterwards, in the usual order, with `npx tsx scripts/pre-destroy.ts` first.

## Phase 14b as run (2026-10-14)

Pre-flight: budget alert "My Monthly Cost Budget" ($50, $5.55 spent); **Lambda concurrency now 1000**
(the 13b blocker is gone); MSK reachable. You deployed all 9 stacks (dashboard stacks added later);
`verify:eks` 4/4, `verify:live` 8/8 (14 edges, about 1,700 calls/min).

**Latency fault, `npm run verify:demo`: 19 PASS / 0 FAIL / 0 WARN.**
- Warm-up: productcatalogservice baseline 0.38 ms over 18 windows. Soak 8 min: 0 model calls, 0 open.
- Fault: 0.37 ms (1,010 calls/min) -> 302 ms (665 calls/min), x819; throughput fell but stayed far
  above the 20-call minimum (the 100 ms fallback was not needed).
- Incident `1791995781541-productcatalogservice` opened 0.6 min after rollout; root cause
  productcatalogservice **rank #1, score 0.932** (peak 0.932, then 0.917), 2nd recommendationservice
  0.083. Evidence: productcatalogservice own_delta 98.7, recommendationservice own_delta 38.9 (2.4 ->
  96.5 ms because it calls productcatalog) = blast radius; at risk checkout/frontend/recommendation.
- Cleared at 16:38:25; resolved 3.9 min later (4 windows). Alerts opened=1, resolved=1; SNS 3
  delivered / 0 failed; DLQ 0; no scorer errors; deployment back to manifest values.

**CPU fault, `npm run verify:demo -- --fault=cpu --service=currencyservice`: did not reach traffic.**
Warm-up and soak passed (baseline 1.39 ms, 0 model calls). At a 15m limit the new pod failed its
1 s gRPC readiness and liveness probes (`failed to connect service ":7000" within 1s`), was restarted,
never became Ready; the rolling update kept the old 200m pod serving, so latency never changed and
no incident opened (correct). The rollout timed out and the run cleaned up. Findings: 15m is too
severe for a probe-checked Node.js service (try 50m); the verifier should say "fault never reached
traffic" rather than "no window data"; and the CPU run's cleanup also listed the already-cleared
productcatalog latency entry (harmless, the cluster was clean; worth a look).

**Dashboard finding (fixed in code, not yet deployed):** during the session the live topology still
showed `frontend -> productcatalogservice avg = 46 ms` 40 minutes after the fault was cleared (real
latency 0.4 ms): the labels were lifetime averages, and node colour only changes when an incident
opens. The API now derives a recent window from the scorer's stored counters (see CLAUDE.md, Stage 14).
Lambda 289 (+7), dashboard 50 (+4), infra 232 tests green; `cdk synth` clean.
