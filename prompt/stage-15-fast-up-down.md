# Stage 15 — One-command `up` / `down` (faster deploy and teardown)

Status: **APPROVED 2026-10-15 (all three decisions, plus multiple alert emails). Phase 15a COMPLETE
(local, no AWS writes); 15b (first live run) NOT yet run. See "Phase 15a as built" at the end.**

## Goal

Make a full session deploy and teardown one command each, running stacks in parallel and with no
idle gaps, **without changing any stack, Lambda, Kubernetes manifest, model or threshold**. The
system must behave exactly as in the 2026-10-14 demo (`verify:demo` 19/19). Only the order and
timing of the commands we already run change.

## Evidence (read-only, 2026-10-15)

- 2026-10-13 session: the core stacks were deployed in one `cdk deploy ... --concurrency 3`
  (about 30 min, Stage 11 notes).
- 2026-10-14 session: stacks were created one after another (CloudFormation creation times):
  VPC 13:53, EKS 13:56, MSK 14:11, Neptune 14:43, SageMaker 14:57, DynamoDB 15:01, Transformer 15:16,
  Scorer 15:54, Alerting 16:10, Api 16:26, Frontend 16:31. Deletions completed one after another
  from 17:44 to 19:51 (about 2 h). Some of those gaps were verification work, not waiting.
- The installed CDK CLI (2.1142.0) supports `--concurrency` on **both** `cdk deploy` and
  `cdk destroy` ("dependency permitting").
- **Cross-stack references are weak** (`@aws-cdk/core:defaultCrossStackReferences: weak` in
  `cdk.json`; templates use `Fn::GetStackOutput`, no `Fn::ImportValue`). CloudFormation therefore
  does **not** stop a stack from being deleted while another reads its outputs; delete order is
  enforced only by CDK's dependency graph, and that graph depends on the context flags (e.g.
  `-c topology=neptune` is what makes ApiStack depend on VpcStack and NeptuneStack). A destroy run
  with different flags than the deploy could delete the VPC while the API's in-VPC Lambda still
  exists. `down` must always synthesize with the full flag set.

## What gets built

| File | Purpose |
|---|---|
| `infra-cdk/scripts/session-plan.ts` | Pure functions: stack list, context flags, the exact `cdk` arguments for up/down, stack-state gating, teardown-sweep judging. No AWS calls, unit-tested. |
| `infra-cdk/test/session-plan.test.ts` | Jest tests for the above. |
| `infra-cdk/scripts/up.ts` | `npm run up [-- --email=<addr> \| --no-email] [--no-dashboard] [--dry-run]` (email from `.env` by default) |
| `infra-cdk/.env` / `.env.example` | Alert email (`RCA_ALERT_EMAIL`); `.env` gitignored, the example committed. Both created 2026-10-15. |
| `infra-cdk/scripts/down.ts` | `npm run down [-- --yes] [--dry-run]` |
| `infra-cdk/scripts/verify-teardown.ts` | `npm run verify:teardown`: read-only sweep proving nothing billable is left. |
| `infra-cdk/package.json` | Add `up`, `down`, `verify:teardown`. Existing per-stack scripts stay unchanged. |
| `CLAUDE.md`, this file | Flow and as-built notes. |

No file under `src/` or `k8s/` changes. The one infrastructure change (added on approval) is multiple
alert emails: `AlertingStack` takes `alertEmails: string[]` and `bin/app.ts` parses
`-c alertEmail=a@x.com,b@y.com` with `parseAlertEmails` (trimmed, de-duplicated, validated). Each
subscription's construct id is its address, so one address synthesizes exactly as before.

## `npm run up`

1. `preflight` (existing: credentials, budget alert, CDK bootstrap).
2. **State gate (read-only):** list this app's stacks. Stop with the exact fix command if any is
   `*_IN_PROGRESS`, `ROLLBACK_COMPLETE`, `*_FAILED` or `UPDATE_ROLLBACK_*`. Absent or `*_COMPLETE`
   stacks are fine (re-running `up` on a deployed system is a no-op for unchanged stacks).
3. Builds, once: Lambda bundles (`src/lambda-transformer`), model artifact (`build:model`), and the
   dashboard (`src/web-dashboard`, skipped with `--no-dashboard`).
4. One `cdk deploy` of every stack, final configuration, in parallel:
   `cdk deploy VpcStack EksStack MskStack NeptuneStack SagemakerStack DynamodbStack TransformerStack
   ScorerStack AlertingStack [ApiStack FrontendStack] --concurrency 10 --require-approval never
   -c graphBackend=neptune -c topology=neptune [-c alertEmail=<addr>]`.
   CDK starts each stack as soon as its dependencies finish. `--require-approval never` is needed
   for an unattended run; the templates it approves are proven identical to 10-14 (check below).
5. `deploy:workloads` (existing script, unchanged), once the deploy has finished.
6. Prints the dashboard URL (FrontendStack output), the cluster name, the time each phase took,
   and the next commands (`verify:eks`, `verify:live`, `verify:demo`).

**Alert email (decided 2026-10-15):** read from `RCA_ALERT_EMAIL` in `infra-cdk/.env` (gitignored,
created 2026-10-15; template `infra-cdk/.env.example` is committed). Order: `--email=<addr>` flag,
else `RCA_ALERT_EMAIL` from the shell environment or `.env`, else `--no-email` must be given; with
none of these `up` stops, so a run can never silently drop the SNS email subscription (the Stage 12
gotcha). The value must look like an email address; `up` prints which source it came from.
Loaded with Node's built-in `process.loadEnvFile` (Node 24), no new dependency.

`--dry-run`: steps 1-3 plus `cdk synth` and `cdk list --show-dependencies` with the same flags;
prints the exact commands and dependency order; deploys nothing.

## `npm run down`

1. Lists which of this app's stacks exist. Nothing exists: says so and runs `verify:teardown`.
2. Asks you to type `destroy` (skipped with `--yes`).
3. If EksStack exists: `aws eks update-kubeconfig` + the cluster-admin access entry (same helper as
   `deploy:workloads`; fixes the known `pre-destroy` 401 when workloads were not deployed by you in
   that session), then:
   - `fault clear` if `.fault-state.json` records a fault (a failure is reported, not fatal: the
     cluster is about to be deleted);
   - `pre-destroy` (existing: deletes LoadBalancer Services, waits until no ELBv2 is left);
   - additionally checks that no **Classic** ELB is in the VPC (read-only; `pre-destroy` only
     checks ELBv2). Any load balancer left: stop.
4. **Dependency guard:** `cdk list --show-dependencies` with
   `-c graphBackend=neptune -c topology=neptune` must show ApiStack -> VpcStack/NeptuneStack and
   TransformerStack -> NeptuneStack; otherwise stop. The full flag set only ever adds ordering
   constraints, so it is safe even if a stack was deployed with fewer flags.
5. One `cdk destroy <deployed stacks> --force --concurrency 10 -c graphBackend=neptune
   -c topology=neptune`. CDK deletes dependents first and in parallel. CDKToolkit is never touched.
6. `verify:teardown`, then prints the time each phase took.

`down` is safe to re-run: if a stack ends in `DELETE_FAILED`, the sweep names it; fix and run again.

## `npm run verify:teardown` (read-only)

PASS only if: no CloudFormation stack except `CDKToolkit` (any non-`DELETE_COMPLETE` status);
no EKS cluster, MSK cluster, Neptune cluster, SageMaker endpoint, `rca-*` DynamoDB table, or
"RCA dashboard" CloudFront distribution; no VpcStack-tagged VPC, NAT gateway, Elastic IP, load
balancer (ELBv2 or Classic), non-terminated EC2 instance, or Lambda function of this app. A query
that fails or returns something unexpected is a FAIL, never a pass. KMS keys in `PendingDeletion` and
small orphan log groups are expected after a teardown and are not checked.

## Safety rules

- No resource definition changes; same stacks, same flags as the 10-14 session's final state.
- `up` never destroys anything; `down` never deploys anything.
- I still do not run `cdk deploy`/`destroy` myself (the auto-mode classifier blocks it): **you** run
  `npm run up` / `npm run down`. I run dry runs, tests and read-only checks.
- If anything fails mid-way, nothing is rolled back automatically beyond CloudFormation's own
  rollback; the script stops and prints the failing stack and the command to continue.

## Proof that the system is unchanged (local, before any live run)

**Template equivalence:** synthesize with `up`'s flags and compare every stack's template against
the template that was **actually deployed on 2026-10-14** (`aws cloudformation get-template` on the
deleted stack IDs, read-only). Asset hashes, `aws:cdk:path` metadata and `CDKMetadata` are
normalized. Expected: identical. Any difference is reported and stops the stage. (Result: identical
for all 11; see "Phase 15a as built".)

## Checkpoint

**15a (local, no AWS writes):**
- `session-plan` unit tests pass; full infra suite (232) still green; `cdk synth` clean.
- Template equivalence as above.
- `npm run up -- --no-email --dry-run` prints the expected command and dependency order.
- `npm run down -- --dry-run` (nothing deployed today) reports "nothing deployed" and
  `verify:teardown` PASS on the real, empty account.

**15b (live, next session you choose to run; you run up/down):**
- `npm run up -- --email=<addr>` completes; `verify:eks` 4/4 and `verify:live` 8/8.
- Optional full proof: `verify:demo` latency fault 19/19 again.
- `npm run down` completes; `verify:teardown` PASS.
- Record the measured phase times here.

## Expected times (estimates; the scripts will print the real ones)

- `up`: about 35-50 min, set by MSK (25-35 min to create) + TransformerStack + workloads; every
  other stack is created alongside it.
- `down`: about 30-45 min, set by the slowest chain (CloudFront delete -> ApiStack -> Neptune ->
  VPC, or MSK/EKS -> VPC). VPC deletion can wait on AWS releasing the in-VPC Lambda network
  interfaces; nothing in this stage changes that.
- Compared with about 2-3 h each way on 2026-10-14.

## Known unknowns

- How `cdk destroy` treats a named stack that does not exist; `down` only names deployed stacks, so
  this should not arise.
- ~~The first `up` also deploys the recent-window dashboard fix for the first time.~~ Wrong (found in
  15a): it already ran on 10-14 after the demo; it has only not been live-checked.
- Real parallel times on this account (only 15b measures them).

## Out of scope

Option 2 (moving the API's Neptune lookup to run time), option 3 (keeping cheap stacks up between
sessions), MSK Serverless, any change to stack contents, storefront exposure, the CPU-fault findings.

## Decisions for you

All decided 2026-10-15:
1. Alert email from `infra-cdk/.env` (`RCA_ALERT_EMAIL`), see `up` above; a comma-separated list of
   addresses is allowed (each owner confirms their own subscription after every `up`).
2. `down` asks you to type `destroy` before deleting; `--yes` skips it.
3. Dashboard stacks are deployed by default; `--no-dashboard` skips them.

## Phase 15a as built (2026-10-15, local, no AWS writes)

Files: `infra-cdk/scripts/{session-plan,session-run,up,down,verify-teardown}.ts`,
`infra-cdk/test/session-plan.test.ts`, `infra-cdk/package.json` (`up`, `down`, `verify:teardown`),
`infra-cdk/.env` (gitignored) + `.env.example`, `lib/alerting-stack.ts` + `bin/app.ts` (multiple
emails), `test/alerting-stack.test.ts`. Commands are started with this Node binary and the CLI's JS
entry point (`aws-cdk/bin/cdk`, `tsx/dist/cli.mjs`, `npm_execpath`), never through a shell, so
`alertEmail=a@x.com,b@y.com` reaches CDK intact on Windows.

| Check | Result |
|---|---|
| Infra Jest suite | **257 passed** (232 before + 21 session-plan + 4 alert-email) |
| `tsc --noEmit` | clean |
| `npm run up -- --dry-run` | preflight PASS (budget "My Monthly Cost Budget"), gate clean, 3 builds, synth; dependency order printed and guard passed; email taken from `infra-cdk/.env`; 52 s |
| `npm run down -- --dry-run` | "Nothing of this app is deployed" -> `verify:teardown` **13/13 PASS** on the real account |
| Template equivalence | **all 11 stacks IDENTICAL** to the templates CloudFormation ran on 2026-10-14 (64-hex asset hashes, resource Metadata and CDKMetadata normalized) |
| Code inside the assets | old asset downloaded from the bootstrap bucket: `index.js`, `alerts.js`, `probe.js` **byte-identical** to today's build; `scorer.js` / `api.js` differ = the recent-window fix, which Scorer/Api/FrontendStack already ran (updated 17:16-17:19 UTC on 10-14) |

Findings:
- **`verify-teardown` crashed on its first real run**: `aws cloudfront list-distributions` prints
  nothing at all when there are no distributions, and the shared JSON helper threw on empty output.
  Fixed locally in the sweep: empty output means "none" for that one call; any other missing or
  unparseable response is a FAIL.
- **Every Lambda asset is the whole `src/lambda-transformer/dist` folder** (`Code.fromAsset(BUNDLE_DIR)`),
  so rebuilding any one bundle changes all five Lambda stacks' asset hashes and makes CDK update
  them. Harmless (the handler file each function runs is unchanged), but it is why a "code-only"
  change redeploys more than expected. Not changed here (out of scope).
- **CLAUDE.md was wrong** that the recent-window fix was never deployed: CloudFormation shows
  Scorer/Api/FrontendStack `UPDATE_COMPLETE` at 17:16-17:19 UTC on 10-14 with today's bundles, after
  the 19/19 demo. It has not been live-checked; corrected in CLAUDE.md and PROJECT_STATUS.md.
- The CDK CLI prints "AI agent detected" before its output; `parseCdkList` skips anything before the
  JSON array.

Still unproven (15b only): real parallel deploy/destroy times, `cdk destroy --concurrency` behaviour
on this account, and the `down` kubectl path (access entry, `fault clear`, `pre-destroy`) on a live
cluster.
