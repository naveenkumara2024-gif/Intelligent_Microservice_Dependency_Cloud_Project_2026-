# Stage 4 — CDK infra scaffolding + `cdk synth` validated

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol").

## Why this stage exists

Per the build order, Stage 4 is scaffolding only — wiring the 7 stack
classes created in Stage 0 into a real CDK app with correct inter-stack
dependencies, and proving the whole thing synthesizes cleanly. **Actual AWS
resources (VPC subnets, EKS cluster, etc.) are explicitly Stage 5+ work**
("Core networking" is build-order item 5) — this stage does not create or
define any billable resource. `cdk synth` is 100% local (no AWS API calls,
no credentials needed for env-agnostic stacks), so this stage is safe to run
without AWS CLI/credentials being configured (which they currently aren't in
this environment).

## Current state (verified by reading the actual files, not assumed)

- `infra-cdk/bin/app.ts` still instantiates the **default leftover stack**
  from `cdk init` (`InfraCdkStack` from `lib/infra-cdk-stack.ts`) — none of
  the 7 real stacks (`VpcStack`, `EksStack`, `MskStack`, `NeptuneStack`,
  `DynamodbStack`, `SagemakerStack`, `FrontendStack`) are referenced
  anywhere yet.
- All 7 real stack files exist in `infra-cdk/lib/` but are empty
  (`constructor` calls `super()` only, no resources, no exported members).
- `infra-cdk/test/infra-cdk.test.ts` is the default cdk-init test, already
  fully commented out (inert) — no change needed there.

## What changes

### `infra-cdk/bin/app.ts`

- Remove the `InfraCdkStack` import/instantiation.
- Import and instantiate all 7 real stacks.
- Declare explicit dependencies matching CLAUDE.md's "Working conventions"
  section (VPC first, then anything needing the VPC, then SageMaker last):
  ```
  vpcStack
  eksStack.addDependency(vpcStack)
  mskStack.addDependency(vpcStack)
  neptuneStack.addDependency(vpcStack)
  dynamodbStack              # no VPC dependency (managed service)
  frontendStack               # no VPC dependency (S3 + CloudFront)
  sagemakerStack.addDependency(dynamodbStack)  # needs a trained-model
                                                 # artifact reference later;
                                                 # for now just ordered last
  ```
- No `env: { account, region }` block — leave stacks environment-agnostic
  for now (matches the commented-out default from `cdk init`; setting a
  real account/region belongs with Stage 5's actual networking work, and
  avoids needing AWS credentials just to run `cdk synth` here).

### `infra-cdk/lib/*.ts` (all 7 stacks)

No resource definitions added yet (that's Stage 5+). The only change: give
each stack a one-line comment noting which later stage will populate it, so
an empty file doesn't look abandoned/forgotten, e.g.:
```ts
export class VpcStack extends cdk.Stack {
  // Resources added in Stage 5 (core networking).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
```

### Cleanup

- Delete `infra-cdk/lib/infra-cdk-stack.ts` (the unused `cdk init` default,
  already flagged as dead weight in CLAUDE.md's repo structure notes) since
  nothing will reference it after `bin/app.ts` is updated.

## Commands to run (after approval)

```bash
cd infra-cdk
npx cdk ls          # should list all 7 stack names
npx cdk synth        # should emit 7 empty-but-valid CloudFormation templates, zero errors
```

## Checkpoint — what "done" means

1. `npx cdk ls` output showing all 7 stack names (not the old
   `InfraCdkStack`).
2. `npx cdk synth` real output showing successful synthesis with no errors,
   for all 7 stacks.
3. Confirm dependency order is accepted (CDK would error on a cycle; a clean
   synth with the `addDependency` calls in place confirms the graph is
   valid).
4. `infra-cdk/lib/infra-cdk-stack.ts` no longer exists and nothing
   references it.

## Explicitly out of scope for this stage

- No real AWS resources in any stack (VPC subnets, EKS nodegroups, MSK
  brokers, etc.) — that starts at Stage 5.
- No `cdk deploy`, no AWS credentials required.
- No changes to Stage 0-3 code/artifacts.
