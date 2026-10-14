# Stage 14 — End-to-end fault-injection demo

Status: **APPROVED 2026-10-13 with all four recommendations (both faults, the API split, storefront private, Stage 13 committed first). Phase 14a COMPLETE (local, no AWS). Phase 14b (live) NOT yet run: it needs the full stack set deployed by you. See "Phase 14a as built" at the end.**
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
