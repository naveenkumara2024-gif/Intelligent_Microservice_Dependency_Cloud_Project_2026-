# Stage 13 — Web dashboard + API Gateway

Status: **APPROVED 2026-10-13 with the plan's recommendations (origin-secret guard, lifetime figures + incident overlay, stop if CloudFront is refused, Vite + React + Cytoscape, QuickSight excluded). Phase 13a COMPLETE (local, no AWS). Phase 13b (live) NOT yet run: it needs your deploys. See "Phase 13a as built" at the end.**
- API: every response shape, status code and header (incl. 403 without the origin secret, 400 on
  bad input, 503 without a graph backend); the topology builder against the Stage 11 Boutique
  fixture incl. the status precedence and the baseline join; incidents with expired-but-present
  items filtered; golden files written and read by both packages.
- Dashboard: builds; graph elements match the golden; renders the three states (data, API error,
  stale) in a real browser against a local mock of the API (screenshots reviewed by me, not
  asserted by a script).
- Infra assertions: bucket private + SSL only + no public policy; distribution uses OAC, HTTPS,
  security-headers policy and `/api/*` behaviour; origin header present and not in any Lambda
  *bundle*; `api.incidents` has no VPC config and only `dynamodb:Query/GetItem` (+ key decrypt) on
  the incidents table and its indexes; `api.topology` (when enabled) is private-app only with
  `neptune-db:ReadDataViaQuery` and read-only DynamoDB; stage throttling set; nothing granted on `*`
  except what AWS requires (VPC ENI actions).
- Existing suites unchanged and green; full `cdk synth` clean.

## Phase 13b — live (user runs deploys; I run verification)

Two tiers so the cheap one can be done on its own:

**13b-i, DynamoDB only (cents):** `npm run deploy:dynamodb`, then `npm run deploy:frontend`
(no Neptune). `verify:dashboard` writes synthetic incidents (id prefix `verify-`), then checks, through the
**CloudFront URL** (not the API URL): `/` serves the SPA over HTTPS with the security headers;
`/api/health` 200; `/api/incidents?status=OPEN` returns exactly the synthetic one with the contract
fields; resolving it moves it to RESOLVED; `/api/incidents/{id}` 200 and an unknown id 404; the
raw `execute-api` URL answers 403; bad input 400; `/api/topology` 503 with the documented body;
and a burst past the throttle yields 429s, not Lambda errors. The SPA itself is then opened in a
browser and reviewed visually.

**13b-ii, with the graph (about 1 h of Neptune, roughly $0.5):** `npm run deploy:vpc`,
`npm run deploy:neptune`, `npm run deploy:frontend -- -c topology=neptune`. Seed a Boutique-shaped
graph with the existing `npm run probe -- load` (no EKS/MSK/SageMaker needed), then `verify:dashboard
-- --topology`: nodes/edges match Neptune's own counts, an injected `degrade` shows up as a
root-cause node when an incident is open, response is cached (second call within 10 s does not
reach Neptune), and a cold topology call stays inside API Gateway's 30 s limit.

Teardown, as always: `destroy:frontend`, `destroy:neptune`, `destroy:vpc`, `destroy:dynamodb`
(run `npx tsx scripts/pre-destroy.ts` first when the VPC is up), then
`verify:dashboard -- --after-destroy`.

## Known unknowns (only a live run can retire them)

- **CloudFront account verification.** New AWS accounts are sometimes refused distribution
  creation until verified (`Your account must be verified before you can add new CloudFront
  resources`), a restriction in the same family as this account's NLB block. I cannot test it
  cheaply (a distribution takes ~15 min to create and to delete). If it is refused, the fallback
  is the S3 *website* endpoint behind public-read plus the API URL called directly (CORS enabled
  and the origin-header scheme dropped), which is weaker and which I would only build after you
  agree.
- Whether the in-VPC Lambda's cold start (SigV4 handshake plus a 2-query read) fits comfortably
  inside the 30 s HTTP API limit; the scorer's cold run took ~100 ms warm / seconds cold, so
  expected yes, measured in 13b-ii.
- Whether concurrency 10 is tight in practice (scorer + API); mitigated by caching and throttling,
  confirmed by the 429-not-error check.

## Cost

13b-i: S3, CloudFront, HTTP API, Lambda, DynamoDB reads: cents (free-tier-sized). 13b-ii: Neptune
`db.t4g.medium` plus the VPC's NAT gateway and interface endpoints for roughly an hour: about
$0.5, covered by the remaining credit ($177.71). Everything is destroyed afterwards.

## Out of scope (stated so it is not assumed)

User login / per-user authorization; custom domain and ACM certificate; live per-second rates (needs
a scorer change); write actions (acknowledge/resolve from the UI); QuickSight; the storefront's
public exposure; the real cascading-fault demo (Stage 14).

## Decisions I need from you

1. **Access control**: the demo-grade origin secret (recommended, decision 5), fully open, or a
   real login (Cognito: adds a user pool and roughly a day of work)?
2. **Live rates**: accept lifetime volume/latency plus incident status (recommended, decision 3),
   or include the small scorer change so the graph shows last-window latency?
3. **If CloudFront is refused**: stop and tell you (recommended), or go straight to the weaker
   S3-website fallback?
4. **Scope**: confirm Vite + React + Cytoscape with polling and the five views above, and QuickSight
   excluded.

## Phase 13a as built (2026-10-13)

Checkpoint 13a output (all run for real): `src/lambda-transformer` typecheck clean, **282 unit tests
(232 + 50 new)**, 5 bundles build (`dist/api.js` 1.9 MB); `src/web-dashboard` typecheck clean,
**46 tests**, production build 672 kB (212 kB gzip, mostly Cytoscape); `infra-cdk` **202 tests
(180 + 22 new)**, full `cdk synth` clean for all stacks; pytest 51.

What exists: API in `src/lambda-transformer/src/api/` (`types`, `names`, `http`, `incidents`,
`topology`, `handler`); the SPA in `src/web-dashboard/` (pure `graph`, `layout`, `format`, `api`,
React components, `scripts/mock-api.mjs` that serves the Lambda tests' golden files); the real
`infra-cdk/lib/frontend-stack.ts`; `scripts/verify-dashboard.ts` (13b); `-c topology=neptune`
in `bin/app.ts`; npm scripts `deploy:frontend`, `verify:dashboard`, `destroy:frontend`.

### Visual review (headless Chrome, driven from a scratch directory)

Real screenshots were reviewed for: incident overview, incident selected, service selected, healthy,
topology backend absent (503), API down, dark mode and phone width. It found four defects that no
unit test would have:

1. **A misleading layout.** Cytoscape's breadthfirst put connected services in one row, so
   `checkoutservice -> productcatalogservice` was drawn straight through `currencyservice` and read
   as a call that never happened. Replaced by `layout.ts` (longest-path layers, barycenter
   ordering) with a test that no edge passes through a third node.
2. **Edges and arrowheads were too heavy** and hid their labels (max width 8 -> 5, arrows 0.8x).
3. **API down on first load said "Loading..." forever with a count of 0**, which reads as "nothing
   open". It now says the incidents could not be loaded and shows no count until a feed answers.
4. **Phone width squeezed the graph** until labels were unreadable (tighter columns and padding
   below 600 px, wrapped labels, resize handling).

### Deviations from the plan and findings

- React 19.3 instead of 18 (current stable). `loadIncident` (detail fetch) was removed from the
  SPA as unused; the detail endpoint stays in the API for other consumers.
- The list and detail endpoints return the same `IncidentView` (the plan said `IncidentRecord`
  for detail); it omits persistence bookkeeping (`expires_at`, `schema_version`).
- **The topology Lambda always exists.** Without `-c topology=neptune` it simply has no graph
  endpoint and answers 503, so the route and the SPA's "unavailable" state are identical in both modes.
- **A minimum TLS version cannot be enforced** on the default `*.cloudfront.net` certificate
  (CloudFront ignores it without a custom domain); the stack no longer sets it and the test says
  so, rather than implying a guarantee that does not exist.
- The origin secret is a Secrets Manager secret resolved by CloudFormation into the CloudFront
  header and the Lambda environment (visible to anyone who can read the function configuration).
  Secrets Manager keeps a deleted secret for a recovery window, so `destroy:frontend` leaves one
  pending-deletion secret for days (cents; reported as a WARN by `--after-destroy`).
- The fixture's node baseline (10 ms, scorer state) and incident evidence baseline (1.02 ms) come
  from two different test helpers; it is a fixture inconsistency, not an API behaviour.

### What 13b needs from you (user-run deploys; the classifier blocks mine)

Tier 1, DynamoDB only (cents), from `infra-cdk/`:
`npm run deploy:dynamodb` then `npm run deploy:frontend` (builds the API bundle and the SPA,
approve the IAM prompt), then tell me and I run `npm run verify:dashboard`. CloudFront takes
about 5-15 minutes to become reachable; the script waits. **If CloudFront refuses to create the
distribution, I stop and report (decision 3 of the approval); I do not build the S3-website fallback.**

Tier 2, with the graph (about 1 h of Neptune, roughly $0.5): `deploy:vpc`, `deploy:neptune`,
`deploy:frontend -- -c topology=neptune`, seed at least one edge with the existing probe, then
`verify:dashboard -- --topology`.

Teardown: `destroy:frontend`, `destroy:neptune`, `destroy:vpc`, `destroy:dynamodb` (run
`npx tsx scripts/pre-destroy.ts` first when the VPC is up), then `verify:dashboard -- --after-destroy`.
