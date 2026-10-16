# Task brief: Nagulesh, public storefront through a Classic ELB, plus repo hygiene

These are real open items in the project. Do them yourself, on your own machine, under your own
git identity. You may use a coding agent, but read every change it makes: in the review you
should be able to explain what you changed and why without looking at notes.

No AWS deploy is needed for the required tasks. Everything here is local code, manifests and
tests.

## Background you need first (about 30 minutes of reading)

1. Read `CLAUDE.md`, sections "Stage 6" and "AWS account constraints".
2. Read `k8s/online-boutique-public/kustomization.yaml` and `infra-cdk/scripts/expose-storefront.ts`.
3. Read `infra-cdk/test/storefront.test.ts`.

Be able to answer these in your own words:
- What is the difference between a ClusterIP Service and a LoadBalancer Service in Kubernetes?
- What are an NLB, an ALB and a Classic ELB, and why does this AWS account refuse only the NLB?
- Why does `pre-destroy.ts` delete LoadBalancer Services before the VPC is destroyed?

## Task 1: switch the public storefront from NLB to Classic ELB

**Problem.** `k8s/online-boutique-public/kustomization.yaml` adds the annotation
`service.beta.kubernetes.io/aws-load-balancer-type: nlb`, so `npm run expose:storefront` asks AWS
for a Network Load Balancer. This account cannot create NLBs (`OperationNotPermitted`), but a
Classic ELB was created successfully in a 2026-10-13 test. A plain `type: LoadBalancer` Service
with no NLB annotation gets a Classic ELB from the in-tree AWS cloud provider.

**Steps.**
1. In the kustomization, remove the NLB annotation and keep `type: LoadBalancer`. Rewrite the
   header comment so it says "Classic ELB" and explains why (the account refuses NLBs).
2. In `infra-cdk/scripts/expose-storefront.ts`, update the comments and any printed messages that
   say NLB. Check how `--allow=<cidr>` is applied. For a Classic ELB,
   `spec.loadBalancerSourceRanges` still works, but confirm the script uses that field and not
   something NLB-specific.
3. Update `infra-cdk/test/storefront.test.ts`. The test at line 60 currently asserts the NLB
   annotation is present. Change it to assert the Service is `type: LoadBalancer` and that the
   NLB annotation is absent.
4. In `CLAUDE.md`, find the sentence saying `expose-storefront.ts` and
   `k8s/online-boutique-public/` "still request an NLB and need switching" and correct it.

**Done when:** `cd infra-cdk && npm test` passes and
`kubectl kustomize k8s/online-boutique-public` renders a `frontend-external` Service of type
LoadBalancer with no NLB annotation. Paste that rendered Service into your PR description.

**Live test (only with Naveen, and only during a session when the stack is already up):**
`npm run expose:storefront`, open the printed URL, then `npm run expose:storefront -- --off`.
If you weren't able to test it live, say so in the PR.

## Task 2: rename the two old prompt files

**Problem.** The `prompt/` folder uses the `stage-NN-name.md` convention, but two early files
don't: `prompt/stage0.md` and `prompt/stage1and2md` (the second is also missing the dot before `md`).

**Steps.**
1. Open both files to see what they cover, then rename them with `git mv` (which keeps their history):
   `git mv prompt/stage0.md prompt/stage-00-environment-setup.md`
   `git mv prompt/stage1and2md prompt/stage-01-02-dataset-and-neo4j.md`
2. Search for references: `grep -rn "stage0.md\|stage1and2" --exclude-dir=node_modules .`
   It currently matches `CLAUDE.md` and `prompt/report-final-project-report.md`. Update them.
   In `CLAUDE.md`, also remove the note saying those filenames "don't yet follow" the convention.

**Done when:** the grep finds nothing, and `git status` shows the files as renamed, not
deleted and re-added.

## Task 3: fill in the report's team-only items

`Docs/report-build/content.py` contains `[TO CONFIRM: ...]` markers that only the team can fill
in (names, register numbers, guide, dates, acknowledgements, contribution split). Go through them
with Naveen and Kabilesh, fill in the true values, and rebuild with
`cd Docs/report-build && python build_report.py`. Write the contribution section honestly: say
who built what.

## Master prompt for your coding agent

Paste this into your agent after you have done the background reading:

```
You are working in the Intelligent Microservice RCA repo. Read CLAUDE.md fully first.
I am Nagulesh. I own these changes; do not touch anything outside them.

1. k8s/online-boutique-public/kustomization.yaml requests an NLB via the annotation
   service.beta.kubernetes.io/aws-load-balancer-type: nlb. This AWS account refuses NLBs but
   can create Classic ELBs. Remove the annotation, keep type: LoadBalancer, and rewrite the
   header comment. Update comments and messages in infra-cdk/scripts/expose-storefront.ts and
   check that --allow uses spec.loadBalancerSourceRanges. Update
   infra-cdk/test/storefront.test.ts to assert type LoadBalancer and NO nlb annotation.
   Correct the CLAUDE.md sentence that says these "still request an NLB".
2. Rename prompt/stage0.md -> prompt/stage-00-environment-setup.md and
   prompt/stage1and2md -> prompt/stage-01-02-dataset-and-neo4j.md with git mv, and update every
   reference (CLAUDE.md, prompt/report-final-project-report.md).

Rules: no AWS deploys, no cdk deploy, no kubectl apply. Don't change Lambda, scorer, model or
CDK stack code. Run `cd infra-cdk && npm test` and `kubectl kustomize k8s/online-boutique-public`
and show the real output. Show me the diff and explain each change before I commit. Don't
commit or push; I will do that myself.
```

## Git steps (use your own account)

```bash
git config user.name  "Nagulesh <your surname>"
git config user.email "<your own email>"
git checkout main && git pull
git checkout -b nagulesh/storefront-classic-elb
# ... make the changes, run: cd infra-cdk && npm test
git add k8s/online-boutique-public/kustomization.yaml infra-cdk/scripts/expose-storefront.ts infra-cdk/test/storefront.test.ts CLAUDE.md prompt/
git commit -m "Public storefront via Classic ELB (account refuses NLB); prompt files follow stage-NN naming"
git push -u origin nagulesh/storefront-classic-elb
```

Then open a Pull Request on GitHub and ask Naveen to review and merge it. Don't merge your own PR
unreviewed.

## What to say in the review

Describe exactly what you did: you fixed the storefront exposure so it works within the account's
load-balancer limits, updated its tests, cleaned up the prompt file naming, and filled in the
report's team details. Don't claim parts of the project you didn't build.
