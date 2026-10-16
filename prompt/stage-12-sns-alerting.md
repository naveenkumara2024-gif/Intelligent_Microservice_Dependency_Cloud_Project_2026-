# Stage 12 — SNS alerting (Slack + PagerDuty)

Status: **APPROVED 2026-10-13 with the plan's defaults. Phase 12a COMPLETE (local). Phase 12b VERIFIED LIVE 2026-10-13 (18 PASS / 2 WARN / 0 FAIL) with Slack/PagerDuty unconfigured and a confirmed email subscription; the first two live runs delivered nothing and were fixed by removing the event filter and granting the table-key read (see "12b first live run" and "12b result after the fix" at the end). Teardown pending.**

## Why this stage, and what it really contains

Build-order item 12. Stage 11 persists incidents (OPEN, updated in place, RESOLVED) but nobody
hears about them. This stage turns an incident's two lifecycle transitions into notifications:

```
rca-incidents (DynamoDB, Stage 11)
   | DynamoDB Stream (NEW_AND_OLD_IMAGES)
   v
alerts.dispatch  (Lambda: classify transition, build the alert event)
   | sns:Publish
   v
rca-alerts (SNS topic, KMS)
   |-- alerts.slack      (Lambda, Block Kit -> Slack incoming webhook)
   |-- alerts.pagerduty  (Lambda, Events API v2: trigger / resolve, dedup_key = incident_id)
   '-- email (optional, `-c alertEmail=...`; the only delivery provable without a 3rd-party account)
```

This is the CLAUDE.md target ("Amazon SNS -> Lambda subscribers -> Slack and PagerDuty"). Stage
10's note put the scorer's SNS publish "with Stages 11-12"; this plan deliberately does NOT put it
in the scorer (decision 1).

## Current state (verified 2026-10-13, read-only)

- `main` = `1f89349` (Stage 11 merged locally, not pushed). Working tree clean.
- **All billable stacks are destroyed** (`list-stacks`: only `CDKToolkit`). Budget alert exists
  (`My Monthly Cost Budget`, $50). Load balancers are still refused by the account: this stage
  needs none.
- The incident record shape is `IncidentRecord` in `src/lambda-transformer/src/scorer/types.ts`
  (`incident_id`, `status`, `root_cause`, `score`, `peak_score`, `ranking`, `blast_radius`,
  `at_risk`, `evidence`, `opened_at_ms`, `resolved_at_ms`, `windows`, `model_version`).
- The scorer writes an incident with a transactional `Put`: a new `incident_id` on open (stream
  `INSERT`), the same item replaced every window while it lasts (`MODIFY`, status OPEN -> OPEN),
  and once more on resolve (`MODIFY`, OPEN -> RESOLVED). TTL deletion arrives as `REMOVE`.
- `DynamodbStack` has no stream yet (one property). The VPC already has an SNS interface endpoint
  (Stage 5), which this plan does not need (decision 3).
- Bundles are built by esbuild into `src/lambda-transformer/dist/` (`index.js`, `probe.js`,
  `scorer.js`); AWS SDK clients are bundled (pinned `3.1141.0`).

## Key design decisions (flag any you disagree with)

1. **Trigger = DynamoDB Streams on `rca-incidents`, not a publish inside the scorer.** The scorer's
   cycle is a tested, atomic, `retryAttempts: 0` path; a post-commit `sns:Publish` that fails has
   already advanced the lifecycle, so the alert would be silently lost. A stream gives durable,
   retried, at-least-once delivery without touching the scorer's code, permissions or its 184
   tests. Cost: ~1 s extra latency and one table property. *Alternative if you prefer fewer
   moving parts:* publish from the scorer after `commit()` (then loss-on-failure is accepted).
2. **Alert on exactly two transitions: opened and resolved.** Not on every update (an incident is
   rewritten every minute). A stream record becomes: `INSERT` with status OPEN -> `incident.opened`;
   `MODIFY` with old OPEN and new RESOLVED -> `incident.resolved`; everything else -> no alert
   (including `REMOVE` from TTL, and a RESOLVED item inserted by a replay). The rule lives in code
   (unit-tested). *As built:* there is no event-source filter in front of it (the planned filter was
   removed after the first live run delivered nothing; see "12b first live run").
3. **Notifiers run outside the VPC.** None touches Neptune or a private resource; Slack and
   PagerDuty are on the public internet, so a VPC placement would need the NAT gateway (hourly
   cost, and one more thing that must exist). Out of VPC they need nothing.
4. **Channels are optional at run time.** Credentials live in SSM Parameter Store `SecureString`
   (standard tier, free): `/rca/alerts/slack-webhook-url`, `/rca/alerts/pagerduty-routing-key`.
   CloudFormation cannot create a SecureString, so **you** put the values with the CLI; they are
   never in the repo, env vars or stack outputs, and they survive `cdk destroy` on purpose (so a
   redeploy needs no re-entry; delete them with `aws ssm delete-parameter` if you want them gone).
   If a parameter is missing the notifier logs `alert.skipped` plus the rendered payload and
   returns success. So the whole path can be deployed and verified with zero third-party accounts,
   and a real Slack/PagerDuty is a one-command switch-on.
5. **At-least-once, idempotent where the receiver allows.** PagerDuty: `dedup_key = incident_id`,
   `trigger` on open and `resolve` on resolve (a duplicate is a no-op on their side). Slack: a
   webhook cannot update a message, so a rare duplicate is a rare duplicate message (documented,
   not engineered away). Failed stream batches retry 3 times (bisect on error, max record age 1 h)
   then land in an SQS DLQ, which has a CloudWatch alarm (>= 1 message).
6. **PagerDuty severity rule (one function, one table in tests):** `critical` if `blast_radius` is
   non-empty (the fault is already propagating), else `error`. Resolve events carry no severity.
   Thresholds live in `src/alerts/config.ts` next to the message text limits.
7. **A pinned alert-event contract**, like Stage 11's request contract: `schema_version: 1`,
   `event` (`incident.opened` | `incident.resolved`), a flattened `incident` summary, and SNS
   message attributes `event_type`, `severity`, `root_cause` (so a subscriber can filter). Pinned
   by `test/fixtures/alert-event.json` (Jest). No dashboard link until Stage 13: an optional
   `DASHBOARD_URL` env var is rendered when set.
8. **A new `AlertingStack`** (depends only on `DynamodbStack`), so Stage 12 deploys and verifies
   without EKS, MSK, Neptune or SageMaker. It owns its CMK for the topic (Stage 5 convention).

## Files to create or modify

New:
- `src/lambda-transformer/src/alerts/types.ts` — `AlertEvent`, stream-record shapes (minimal local
  types; no `@types/aws-lambda` dependency).
- `src/lambda-transformer/src/alerts/classify.ts` — stream record -> `AlertEvent | undefined`
  (decision 2; unmarshalls the DynamoDB-JSON image).
- `src/lambda-transformer/src/alerts/config.ts` — severity rule, text limits, parameter names.
- `src/lambda-transformer/src/alerts/slack.ts` — Block Kit builder (pure) + webhook sender.
- `src/lambda-transformer/src/alerts/pagerduty.ts` — Events API v2 builder (pure) + sender.
- `src/lambda-transformer/src/alerts/secrets.ts` — SSM read with a short in-memory cache.
- `src/lambda-transformer/src/alerts/handler.ts` — exports `dispatch`, `slack`, `pagerduty`
  (one bundle `dist/alerts.js`, handlers `alerts.dispatch` / `alerts.slack` / `alerts.pagerduty`).
- `src/lambda-transformer/test/fixtures/alert-event.json`, `alert-classify.test.ts`,
  `alert-slack.test.ts`, `alert-pagerduty.test.ts`, `alert-handler.test.ts` (local `http` server
  as the Slack/PagerDuty stand-in; injected SNS/SSM clients).
- `infra-cdk/lib/alerting-stack.ts` — topic + CMK, dispatcher with the stream mapping, two
  subscriber Lambdas, DLQ + alarm, optional email subscription, outputs.
- `infra-cdk/test/alerting-stack.test.ts` — CDK assertions (see checkpoint).
- `infra-cdk/scripts/verify-alerts.ts` — the 12b live checkpoint.

Modified:
- `infra-cdk/lib/dynamodb-stack.ts` — `stream: NEW_AND_OLD_IMAGES` on the incidents table; export
  the stream ARN. `infra-cdk/test/dynamodb-stack.test.ts` — assert it.
- `infra-cdk/bin/app.ts` — instantiate `AlertingStack` (`-c alertEmail=<addr>` optional).
- `infra-cdk/package.json` — `deploy:alerts`, `verify:alerts`, `destroy:alerts`.
- `src/lambda-transformer/package.json` (+ lockfile) — `build:alerts`, include it in `build`;
  add `@aws-sdk/client-sns` and `@aws-sdk/client-ssm` pinned to `3.1141.0`.
- `CLAUDE.md` — Stage 12 status and repo-structure lines (only after the checkpoint passes).

Not touched: the scorer, its tests, the SageMaker/Neptune/MSK/EKS/VPC stacks.

## Alert event contract (v1)

```json
{
  "schema_version": 1,
  "event": "incident.opened",
  "occurred_at_ms": 1760000000000,
  "incident": {
    "incident_id": "...", "status": "OPEN", "root_cause": "productcatalogservice",
    "severity": "error", "score": 0.994, "peak_score": 0.994,
    "blast_radius": [], "at_risk": ["frontend"],
    "top_candidates": [{ "name": "productcatalogservice", "score": 0.994 }],
    "evidence": { "productcatalogservice": { "own_delta": 7.2, "window_avg_ms": 8.4, "baseline_ms": 1.0, "calls": 120 } },
    "opened_at_ms": 1760000000000, "resolved_at_ms": null,
    "windows": 2, "model_version": "..."
  }
}
```

`incident.resolved` carries `status: RESOLVED`, `resolved_at_ms`, and the duration is derived by
the renderers from the two timestamps.

## Phase 12a — local, no AWS, no cost

Commands (all from the repo, no deploy):

```bash
cd src/lambda-transformer && npm install && npm run typecheck && npm test && npm run build
cd ../../infra-cdk && npm test && npx cdk synth
```

**Checkpoint 12a (done = all true, with real output shown):**
- Classifier: every transition in the decision-2 table, incl. `REMOVE`, malformed image, and a
  RESOLVED `INSERT`, produces the expected event or none.
- Slack and PagerDuty payloads match fixtures; text limits truncate, never throw; severity rule
  covered; unconfigured channel -> `skipped` with payload, no HTTP call; sender errors surface (so
  the retry/DLQ path engages); HTTP leg proven against a local server (headers, body, status).
- Dispatcher publishes exactly one SNS message per qualifying record, with the three attributes,
  and a batch of mixed records publishes only the qualifying ones.
- Infra assertions: stream on the incidents table; mapping with batch size, bisect, retry 3,
  max age, `OnFailure` DLQ; topic encrypted with a CMK; notifiers subscribed; **no Lambda has a
  VPC config**; IAM is minimal (dispatcher: `sns:Publish` on the topic only; notifiers:
  `ssm:GetParameter` on their one parameter each + `kms:Decrypt` via SSM only); no parameter
  resource is created; DLQ alarm exists; email subscription present only with the context flag.
- Existing suites unchanged and green (184 unit + 149 infra counts will grow, not shrink); full
  `cdk synth` clean.

## Phase 12b — live (a short session; user-run deploys)

Needs only `DynamodbStack` and `AlertingStack`. Order, and why it is cheap: no EKS/MSK/Neptune.

```bash
# optional, once (values are never printed or committed):
aws ssm put-parameter --name /rca/alerts/slack-webhook-url --type SecureString --value '<url>'
aws ssm put-parameter --name /rca/alerts/pagerduty-routing-key --type SecureString --value '<key>'

cd infra-cdk
npm run deploy:dynamodb                       # user runs it (the classifier blocks my cdk deploy)
npm run deploy:alerts [-- -c alertEmail=you@example.com]   # user runs it
npm run verify:alerts                         # I run it
npm run destroy:alerts && npm run destroy:dynamodb         # user runs; then re-check list-stacks
```

`verify:alerts` writes **synthetic incident items** (id prefix `verify-`, the production record
shape) straight into `rca-incidents` and watches the chain, using CloudWatch Logs and metrics
rather than status strings:

1. Both stacks `CREATE_COMPLETE`; the table's stream is `NEW_AND_OLD_IMAGES`.
2. Put OPEN item -> within 60 s exactly one `alert.published` line (dispatcher) and one SNS
   message; Slack and PagerDuty notifiers each log `alert.sent` (or `alert.skipped` with the
   rendered payload when unconfigured).
3. Re-put the item (OPEN -> OPEN, as the scorer does every minute) -> **no** new alert.
4. Put RESOLVED -> exactly one `incident.resolved` alert.
5. DLQ is empty; no Lambda errors in the window.
6. With `alertEmail` set and the subscription confirmed (a click, by you): two emails received.
   With real Slack/PagerDuty values: a Block Kit message and a trigger + resolve pair.

The live proof of the **real producer** (the Stage 11 scorer opening an incident that then alerts)
is the Stage 14 demo; this stage proves the delivery chain from the table onward.

## Known unknowns (only a live run can retire them)

- Whether the stream's event source mapping needs `kms:Decrypt` on the table's CMK. Expectation:
  no (stream data is not encrypted with the table key). If denied, I read the denial and add the
  one grant, as in Stage 11; I do not pre-grant.
- SSM default-key decryption (`alias/aws/ssm`) for the notifiers' role: expected to work with the
  service-scoped `kms:Decrypt` described above; confirmed on the first read.
- DynamoDB Local stream parity is not relied on: the classifier is tested against hand-built
  stream records, and the real shapes are confirmed live (a real record is captured and added to
  the fixtures during 12b, the way Stage 8b captured real spans).

## Cost

Verification session: SNS/Lambda/SQS/SSM standard parameters/streams reads are free-tier-sized
(cents); a CMK is ~$1/month prorated (deleted with the stack after its 7-day pending window).
Nothing here bills hourly. Destroy both stacks afterwards as usual.

## Out of scope (stated so it is not assumed)

Escalation or re-notify while an incident stays open; alert grouping/suppression windows; SMS;
an on-call schedule; Slack interactivity (acknowledge buttons); the dashboard link (Stage 13);
real cascading-fault alerts (Stage 14).

## Decisions I need from you

1. **Trigger**: DynamoDB Streams (recommended, decision 1) or publish from the scorer?
2. **Channels for 12b**: do you have a Slack incoming-webhook URL and/or a PagerDuty Events-v2
   routing key to use? If not, the plan still verifies the full path up to the HTTP call (and the
   HTTP call against a local server); real delivery is then a one-command switch-on later.
3. **Email**: an address for the optional SNS email subscription (recommended: it is the one real,
   end-to-end delivery check that needs no third-party account). It will receive ~2 messages.

## Phase 12a as built (2026-10-13)

Checkpoint 12a output (all run for real): `src/lambda-transformer` typecheck clean, **232 unit tests
pass (184 existing + 48 new)**, `npm run build` produces `dist/alerts.js` (1.5 MB) exporting
`dispatch`, `slack`, `pagerduty`; `infra-cdk` **180 tests pass (149 existing + 31 new)**; full
`cdk synth` clean for all 10 stacks (`AlertingStack` added).

What exists, against the plan's file list:

- `src/alerts/`: `names.ts` (constants shared with the stack), `types.ts`, `config.ts` (severity
  rule, limits, TTLs), `classify.ts`, `format.ts`, `slack.ts`, `pagerduty.ts`, `http.ts`,
  `secrets.ts`, `handler.ts`. Beyond the plan: `format.ts` (pure formatters) and `http.ts` (one
  POST helper whose errors never contain the URL, because a Slack webhook URL is the credential).
- `infra-cdk/lib/alerting-stack.ts`, `bin/app.ts` wiring, `package.json` scripts
  (`deploy:alerts`, `verify:alerts`, `destroy:alerts`), `lib/dynamodb-stack.ts` stream +
  `IncidentsStreamArn` output.
- Tests: `alert-classify` (every transition incl. REMOVE, duplicates, malformed), `alert-render`
  (Slack + PagerDuty, truncation, escaping), `alert-golden` (contract v1 + rendered bodies, pinned
  in `test/fixtures/alert-event.json` and `alert-payloads.json`), `alert-handler` (dispatch, both
  notifiers against a local HTTP server, secret source), `alerting-stack.test.ts` (31 assertions
  incl. IAM minimality and "no Lambda in a VPC"), `alerts-live.test.ts` (the verify script's
  synthetic incidents are fed through the real classifier).
- `scripts/verify-alerts.ts` + `scripts/alerts-live.ts` (pure, unit-tested): the 12b checkpoint.

### Deviations and findings

1. **A real bug the tests caught before any deploy:** Slack renders the top-level `text` field as
   mrkdwn, so a service named `<!channel>` in the fallback text would have notified the whole
   channel. The header block is `plain_text` (shown literally, left raw); the fallback `text` and
   every other block are now escaped. Regression test: `Slack message › control characters...`.
2. **Dispatcher reports partial batch failures** (`reportBatchItemFailures`) and stops at the
   first failed publish, so a retry resumes at that record and a "resolved" can never overtake an
   "opened". The plan said "bisect on error"; both are configured.
3. **No notifier-side idempotency store** (as planned): PagerDuty folds duplicates by `dedup_key`;
   Slack can rarely duplicate. The DLQ holds anything undeliverable and has an alarm.
4. **Dropped from the plan:** "capture a real stream record into the fixtures". The fixtures are
   built with the same marshaller the scorer's DocumentClient uses, from the real
   `IncidentRecord` shape, and 12b classifies real stream records anyway (an `alert.published`
   line proves the real shape parses).
5. **The incident id** in fixtures follows the scorer's real format `${firstHitMs}-${service}`
   (my first draft invented a different one; found by reading `scorer/lifecycle.ts`).
6. The dispatcher is granted `dynamodb:DescribeStream/GetRecords/GetShardIterator` on the stream
   and `ListStreams` on `*` (no resource-level scope exists), **not** `table.grantStreamRead`,
   because that helper also adds the table CMK; a test asserts the dispatcher holds no key
   permission except on the topic's own key.

### What 12b needs from you

1. Deploy (the auto-mode classifier blocks my `cdk deploy`), from `infra-cdk/`:
   `npm run deploy:dynamodb`, then `npm run deploy:alerts` (add `-- -c alertEmail=<addr>` for the
   email check; confirm the subscription email once).
2. Optional, before `verify:alerts`, to turn the real channels on (values are never echoed):
   `aws ssm put-parameter --name /rca/alerts/slack-webhook-url --type SecureString --value '<url>'`
   and `--name /rca/alerts/pagerduty-routing-key`. Without them the run still verifies the chain
   up to the HTTP call and says so (WARN, not FAIL).
3. I run `npm run verify:alerts`; you then destroy (`destroy:alerts`, then `destroy:dynamodb`) and
   I run `verify:alerts -- --after-destroy`. Parameters survive the destroy on purpose.

Expected first-run risks (the "Known unknowns" above): an `AccessDenied` on the stream read would
mean the mapping needs `kms:Decrypt` on the table key (one grant, read from the denial); the
`alias/aws/ssm` decrypt grant is the other.

### 12b session notes (2026-10-13)

- **Git Bash rewrites `/rca/alerts/...`**: MSYS path conversion turns an argument that starts with
  `/` into `C:/Program Files/Git/rca/alerts/...` before `aws` sees it, so a `put-parameter` typed
  in Git Bash would create (or look up) the wrong name and the notifier would report "not
  configured". Use PowerShell, or prefix with `MSYS_NO_PATHCONV=1`. The npm scripts are not
  affected (Node does not go through MSYS). Confirmed with a read-only `get-parameters`.
- **My `cdk deploy` attempt**: `npm run deploy:dynamodb` passed preflight but CDK stopped at
  "security-sensitive changes ... no TTY to confirm" (the only change was the default CMK key
  policy for the account root). Re-running with `--require-approval never` was denied by the
  auto-mode classifier, as CLAUDE.md predicted, so deploys stay with the user. Nothing was created
  (`list-stacks`: only CDKToolkit; no tables).

### 12b first live run (2026-10-13): chain NOT working; fix prepared, redeploy pending

Deployed by the user (DynamodbStack, then AlertingStack with `-c alertEmail=...`). Result of two
`verify:alerts` runs: wiring checks PASS (stream both images, mapping Enabled, 2 Lambda
subscriptions, queue empty, no errors), but **the dispatcher was never invoked**: every
"published / handled" check FAILED.

What was established (all read-only):
- The stream holds the records, with exactly the expected shape (`dynamodbstreams get-records`):
  INSERT status OPEN; MODIFY OPEN -> OPEN; MODIFY OPEN -> RESOLVED; REMOVE.
- Dispatcher CloudWatch metrics: Invocations 0, Errors 0, Throttles 0 over the window; its log
  group is empty. So the mapping reads but never calls the function (the mapping's LastModified
  advances with record activity and LastProcessingResult stays "No records processed", which is
  consistent with the records being read and then dropped).
- Function is Active, handler `alerts.dispatch`, env correct; key policy is the default
  root-trust policy; account concurrency limit is 10 (not the cause: no throttles).

My first hypothesis (the script wrote before the mapping was live; LATEST misses earlier records)
was a real script flaw and is fixed (it now waits for Enabled, settles 20 s, refuses to write
otherwise), but the first run's check had shown the mapping Enabled, and the second run, with
the fix, delivered nothing either, so it was not the cause.

Two candidates remain and were **not isolated** (changed together to get one decisive redeploy):
1. The event-source filter (INSERT+OPEN / MODIFY OPEN->RESOLVED patterns) drops every record for a
   reason not visible from outside. **Removed**: it was only an optimization and the code
   classifier is authoritative; cost is ~60 trivial invocations/hour while an incident is open.
2. The stream reader needs the table CMK (CDK's own `grantStreamRead` grants `kms:Decrypt` +
   `kms:DescribeKey` for an encrypted table). **Granted** to the dispatcher on the table key only,
   read-only; `alerting-stack.test.ts` pins it (exactly Decrypt/DescribeKey on the table key and
   Decrypt/GenerateDataKey* on the topic key, nothing else).

`cdk diff AlertingStack` shows exactly those two changes. **Warning found by the diff:** a
redeploy without the same `-c alertEmail=...` removes the email subscription (the resource is
conditional on the context value), so the flag must be repeated. Old placeholder subscriptions
(`you@example.com` from the first deploy) stay PendingConfirmation until SNS expires them (3 days);
they cannot be unsubscribed by API, which is why the verify script can report "1/2 confirmed".

Lesson recorded for the next stage that uses an event source mapping: do not ship a filter whose
patterns were not proven live, and when a mapping silently delivers nothing, read the stream with
`dynamodbstreams get-records` and the function's `Invocations` metric before theorizing.

### 12b result after the fix (2026-10-13): VERIFIED

User redeployed with the filter removed and the table-key read granted (and the same
`-c alertEmail=...`). Confirmed before running: mapping Enabled with no FilterCriteria, key grant on
the table key, confirmed email subscription intact. `npm run verify:alerts -- --wait=90`:

```
18 PASS / 2 WARN / 0 FAIL
PASS  Opening alerts exactly once (stream -> dispatcher -> SNS): 1 incident.opened published within 90s
PASS  The alert carries the severity the blast radius implies: severity=critical
PASS  Slack / PagerDuty notifier handled the opening once: outcome skipped (not configured)
PASS  Resolution alerts exactly once, and the rewrite alerted nothing: published 1 opened, 1 resolved
PASS  Slack / PagerDuty notifier handled the resolution once
PASS  No invocation errors, timeouts or failed publishes; Dead-letter queue is empty
WARN  Slack webhook parameter / PagerDuty routing-key parameter not set (payloads logged, no HTTP call)
```

SNS metrics for the topic: 1 published, 3 delivered (2 Lambda + 1 email), 0 failed.

**Not proven, stated plainly:**
- Which of the two fixes cured the non-delivery (filter vs table-key read). Either alone might have
  been enough; they were changed together to get one decisive redeploy. If the filter is ever
  reintroduced, prove it live first.
- SSM SecureString decryption (`kms:Decrypt` via SSM): only `ssm:GetParameter` on a missing
  parameter ran. The real Slack and PagerDuty HTTP legs are covered by unit tests against a local
  server only. Retire both by setting the two parameters and re-running `verify:alerts`.
- The real producer (the Stage 11 scorer opening an incident) is the Stage 14 demo.

Teardown (user): `npm run destroy:alerts`, then `npm run destroy:dynamodb`; then
`npm run verify:alerts -- --after-destroy`. SSM parameters, if any were created, are kept.
