# Task brief: Kabilesh, verification and fault-injection fixes

These are real open items in the project. Do them yourself, on your own machine, under your own
git identity. You may use a coding agent, but read every change it makes: in the review you
should be able to explain what you changed and why without looking at notes.

No AWS deploy is needed. Everything here is local code and tests.

## Background you need first (about 30 minutes of reading)

1. Read `CLAUDE.md`, sections "Stage 13", "Stage 14" and "Stage 15b".
2. Read `infra-cdk/scripts/verify-dashboard.ts`. It is the checklist that proves the live
   dashboard works (PASS / WARN / FAIL lines).
3. Read `infra-cdk/scripts/demo-live.ts`. It judges the fault-injection demo against fixed rules.
4. Read `src/lambda-transformer/src/api/http.ts`, which sets the `cache-control` header.

Be able to answer these in your own words:
- Why does the topology API set a cache time at all, and why was it lowered from 10 s to 5 s?
  (Hint: the "recent-window fix" in CLAUDE.md Stage 14.)
- What does the CPU fault do to `currencyservice`, and why did the live run detect nothing?

## Task 1: the dashboard verifier still expects a 10 s cache

**Problem.** `infra-cdk/scripts/verify-dashboard.ts` (around line 289) checks for
`cache-control: public, max-age=10`. The API now returns `max-age=5`, so the live run gave a WARN
even though nothing is wrong (see CLAUDE.md, Stage 15b: "20 PASS / 2 WARN").

**Steps.**
1. Find where the topology cache time is defined (search `cacheSeconds` under
   `src/lambda-transformer/src/api/`) and confirm the real value.
2. Change the verifier so it expects that value. Better still, import or share one constant so
   the two can't drift apart again. If importing across packages is awkward, add a comment that
   points at the source of truth.
3. Update the check's name text ("cacheable for 10 s") to match.
4. Search the repo for other places that still say 10 s for the topology cache (`grep -rn
   "max-age=10\|10 s cache" infra-cdk src Docs/report-build`) and fix any that are wrong.

**Done when:** `cd infra-cdk && npm test` passes, and the check's text and expected header both
match the API's real cache time.

## Task 2: a clear message when the CPU fault never reaches traffic

**Problem.** In the live demo, `--limit=15m` starved `currencyservice` so badly that the new pod
never became Ready. The old pod kept serving, so there was no fault to detect. The verifier only
printed `no window data (before=..., during=...)`, which doesn't explain what happened. CLAUDE.md
lists a clearer message as a TODO.

**Steps.**
1. In `infra-cdk/scripts/demo-live.ts` (around line 100), find where the "no window data" text
   is built.
2. Work out what information the verifier has at that point (look at the type of `o` and `f`).
   If the fault was a CPU fault and `during` is missing, the message should say something like:
   "the faulted pod may never have become Ready (CPU limit too low for its probes); the old pod
   kept serving, so no slowdown reached traffic. Try a higher --limit."
3. Keep the result a FAIL, because the demo really did not prove anything. Only the explanation
   changes.
4. Add a Jest test in `infra-cdk/test/` (look for an existing demo or fault test to copy the
   style from) that feeds in a CPU fault with no `during` window and checks the new message.

**Done when:** `npm test` passes, including your new test.

## Task 3 (optional): check what a 50m CPU limit does, locally

CLAUDE.md says "50m is untested". Using the same `kubectl --local` method the project already
uses (see `prompt/stage-14-fault-injection-demo.md`), render the patch for
`npm run fault -- cpu --service=currencyservice --limit=50m` and confirm that both the request
and the limit are set correctly and that `clear` restores the original. Write 5-10 lines of
findings in `prompt/stage-14-fault-injection-demo.md` under a new heading "50m CPU limit (local
check)". Don't claim anything about live behaviour you didn't actually observe.

## Master prompt for your coding agent

Paste this into your agent after you have done the background reading:

```
You are working in the Intelligent Microservice RCA repo. Read CLAUDE.md fully first.
I am Kabilesh. I own two small fixes; do not touch anything outside them.

1. infra-cdk/scripts/verify-dashboard.ts expects 'public, max-age=10' for /api/topology,
   but the API (src/lambda-transformer/src/api/) now sends a shorter cache time. Find the real
   value, make the verifier expect it (prefer one shared constant, or a comment pointing at the
   source of truth), update the check's name text, and fix any other stale "10 s" topology-cache
   references.
2. infra-cdk/scripts/demo-live.ts prints "no window data" when a CPU fault never reaches traffic.
   When the fault is a CPU fault and the during-fault window is missing, explain the likely cause
   (pod never Ready because the CPU limit starves its probes; the old pod kept serving) and
   suggest a higher --limit. Keep the check a FAIL. Add a Jest test for this case.

Rules: no AWS deploys, no cdk deploy, no changes to Lambda/scorer/model logic. Show me the diff
and explain each change before I commit. Run `cd infra-cdk && npm test` and show the real output.
Don't commit or push; I will do that myself.
```

## Git steps (use your own account)

```bash
git config user.name  "Kabilesh <your surname>"
git config user.email "<your own email>"
git checkout main && git pull
git checkout -b kabilesh/verifier-fixes
# ... make the changes, run: cd infra-cdk && npm test
git add infra-cdk/scripts/verify-dashboard.ts infra-cdk/scripts/demo-live.ts infra-cdk/test/<your test file>
git commit -m "verify:dashboard expects the 5 s topology cache; clearer CPU-fault message in verify:demo"
git push -u origin kabilesh/verifier-fixes
```

Then open a Pull Request on GitHub and ask Naveen to review and merge it. Don't merge your own PR
unreviewed.

## What to say in the review

Describe exactly what you did: you found and fixed a verifier that disagreed with the API after
the cache change, made the fault demo explain a confusing result, and added a test. Don't claim
parts of the project you didn't build.
