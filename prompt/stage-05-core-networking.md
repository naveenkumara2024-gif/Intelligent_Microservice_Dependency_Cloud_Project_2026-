# Stage 5 — Core networking (VPC, subnet tiers, VPC endpoints, security groups)

Status: DRAFT — awaiting explicit approval before any execution (per CLAUDE.md
"Stage implementation protocol"). Approval is requested **per phase** (5a and
5b below); approving 5a does not approve 5b.

## Why this stage exists

Build-order item 5. Everything that follows (EKS, MSK, Neptune, Lambda,
SageMaker endpoint) lives inside the VPC defined here, so this stage defines
the network they share. `VpcStack` is the root of the CDK dependency graph
(`bin/app.ts` already makes EKS/MSK/Neptune depend on it).

## Current state (verified by reading files / running commands)

- `infra-cdk/lib/vpc-stack.ts` is an empty stack (constructor calls `super()`
  only, with a "Resources added in Stage 5" comment).
- `infra-cdk/bin/app.ts` instantiates all 7 stacks with **no `env`**
  (environment-agnostic) and the dependency edges VPC -> EKS/MSK/Neptune.
- Versions: `aws-cdk` 2.1142.0, `aws-cdk-lib` ^2.269.0, `constructs` ^10.5.0.
- AWS CLI v2.36.49 is installed, but **no credentials are configured**
  (`aws sts get-caller-identity` -> `NoCredentials`). `cdk synth` works without
  them; `cdk bootstrap` / `cdk deploy` do not.
- `infra-cdk/test/infra-cdk.test.ts` is the fully commented-out cdk-init
  default.

## Design decisions (flag any you disagree with before approving)

1. **Region/AZs**: `us-east-1`, two AZs passed explicitly
   (`['us-east-1a', 'us-east-1b']`). Explicit AZs avoid a context lookup that
   would need credentials during `cdk synth`.
2. **CIDR**: `10.0.0.0/16` (per CLAUDE.md), `/24` per subnet.
3. **Three subnet tiers x 2 AZs** (6 subnets):
   - `public` (`PUBLIC`) — IGW route; will host the ALB in Stage 6.
   - `private-app` (`PRIVATE_WITH_EGRESS`) — NAT route; EKS nodes, Lambda.
   - `private-data` (`PRIVATE_ISOLATED`) — **no internet route**; Neptune, MSK.
4. **NAT: 1 gateway (single AZ), not 2.** NAT bills ~$0.045/hr each plus data;
   one is enough for a dev/course project. Exposed as a constant
   (`natGateways`) so it can be raised to 2 for a multi-AZ demo. Trade-off: an
   AZ-1 outage cuts egress for private-app in AZ-2.
5. **VPC endpoints** (matches CLAUDE.md: SageMaker/DynamoDB/SNS):
   - Gateway endpoints (free): **DynamoDB**, plus **S3** (free, and EKS/ECR
     image-layer pulls and CDK assets use it).
   - Interface endpoints (hourly + per-GB): **SageMaker Runtime** and **SNS**,
     placed in the private-app subnets, `privateDnsEnabled`, protected by an
     endpoint security group allowing 443 from the VPC CIDR only.
6. **Security groups created here**: `appSg` (for EKS nodes / Lambda) and
   `endpointSg` (interface endpoints). Neptune/MSK security groups are created
   in their own stacks (Stages 7/9), taking `appSg` as an ingress source — this
   keeps ports out of the network stage until those services exist.
7. **VPC Flow Logs** to CloudWatch Logs, `REJECT` traffic only, 1-week
   retention (cheap; gives visibility into blocked traffic in the isolated tier).
8. **IAM roles and KMS keys are deliberately NOT created here** (deviation from
   the build-order wording "VPC, IAM roles, VPC endpoints"). Reason: a role in
   `VpcStack` that later gets grants on a Neptune/SageMaker/DynamoDB resource
   makes CDK write a policy into `VpcStack` that references those later stacks
   — a **cyclic cross-stack dependency**. Each role is created in the stack that
   owns the consuming resource (EKS role with EKS in Stage 6, Lambda transformer
   role in Stage 8, SageMaker execution role in Stage 10). Same logic for KMS
   keys (created with the data stacks). The only IAM here is the flow-log
   delivery role CDK creates automatically.
9. **ALB is not created here**; it is provisioned by the AWS Load Balancer
   Controller / ingress in Stage 6. The public subnets only need the right
   subnet tags (CDK adds them).

Exposed from `VpcStack` for later stacks: `vpc`, `appSecurityGroup`.
`bin/app.ts` passes them via props (e.g. `new EksStack(app, 'EksStack',
{ vpc: vpcStack.vpc })`) only when those stacks need them — in this stage only
the `VpcStack` public members and `env` change; the other stacks stay empty.

## Phase 5a — Code + local validation (no AWS credentials, no cost)

### Files to modify/create

| File | Change |
|---|---|
| `infra-cdk/lib/vpc-stack.ts` | Implement VPC, 3 subnet tiers, 1 NAT, gateway + interface endpoints, `appSg`/`endpointSg`, flow logs. Export `vpc`, `appSecurityGroup`. |
| `infra-cdk/bin/app.ts` | Add `env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' }` (account stays undefined when no credentials, which is fine for synth). Update the "real env config arrives in Stage 5" comment. |
| `infra-cdk/test/vpc-stack.test.ts` (new) | Assertions-module tests (below). |
| `CLAUDE.md` | Fix the stale status line (currently says "Stages 0–2 complete… ready for Stage 3"; Stages 3 and 4 are done) and mark Stage 5a status. |

### Commands

```bash
cd infra-cdk
npx cdk ls
npx cdk synth VpcStack
npx jest test/vpc-stack.test.ts
```

(If Jest/ts-jest turns out not to be configured for TypeScript 7, I will report
that and fall back to inspecting the synthesized template instead of silently
skipping tests.)

### Tests (CDK `assertions`)

- Exactly 1 `AWS::EC2::VPC` with `CidrBlock: 10.0.0.0/16`.
- 6 subnets; 2 public (MapPublicIpOnLaunch), 4 private.
- Exactly 1 `AWS::EC2::NatGateway` and 1 `AWS::EC2::InternetGateway`.
- The private-data route tables contain **no** route to `0.0.0.0/0`
  (this is the key architectural property).
- Gateway endpoints for DynamoDB and S3; interface endpoints for SageMaker
  Runtime and SNS with private DNS enabled.
- `endpointSg` ingress is only 443 from the VPC CIDR.
- Flow log with traffic type `REJECT`.

### Checkpoint 5a — "done" means all shown with real output

1. `cdk ls` lists the 7 stacks.
2. `cdk synth VpcStack` succeeds; summary of resource counts from the template.
3. Jest run: all tests pass.
4. Full `npx cdk synth` (all stacks) still succeeds, confirming no cycles.

## Phase 5b — Deploy and verify (needs separate approval; costs money)

### Preconditions (I will check these and stop if any fail)

- AWS credentials configured (`aws login` / `aws configure`), and
  `aws sts get-caller-identity` shows the intended account. **Currently not
  true.**
- **AWS budget alert exists** (CLAUDE.md guardrail). I will verify with
  `aws budgets describe-budgets --account-id <id>`; if none exists I will stop
  and ask before deploying.
- `cdk bootstrap` has been run in `us-east-1`. Bootstrapping itself creates an
  S3 bucket, ECR repo, and IAM roles in your account, so it is a separate
  confirmation within this phase.

### Commands (each shown with real output)

The 5b code was written during 5a (approved: "design the code for 5b, wire it
up once credentials exist"). It lives in `infra-cdk/scripts/` and is exposed
as npm scripts. Nothing below has been run yet.

```bash
cd infra-cdk
npm run preflight       # read-only: credentials, account match, budget alert, CDKToolkit bootstrap stack
npm run bootstrap       # needs separate confirmation: creates S3/ECR/IAM in the account
npx cdk diff VpcStack
npm run deploy:vpc      # preflight -> cdk deploy VpcStack -> verify:vpc
npm run verify:vpc      # read-only: VPC, 6 subnets/3 tiers, no default route in private-data, 4 endpoints available
npm run destroy:vpc     # teardown after verification (asks before running)
```

If the budget API is not queryable by the IAM user, `preflight` fails closed;
set `BUDGET_CONFIRMED=1` only after confirming the alert in the console.

### Checkpoint 5b

1. `aws ec2 describe-vpcs` / `describe-subnets` show the VPC and 6 subnets in
   2 AZs across 3 tiers.
2. `aws ec2 describe-route-tables` confirms private-data has no `0.0.0.0/0`
   route.
3. `aws ec2 describe-vpc-endpoints` shows all 4 endpoints `available`.
4. Teardown decision: because nothing else uses the VPC yet, I recommend
   `npx cdk destroy VpcStack` right after verification (NAT + 2 interface
   endpoints ~ $0.09/hr, roughly $2/day if left running). I will ask rather than
   assume.

## Estimated cost while deployed (us-east-1, approximate)

| Item | ~Cost |
|---|---|
| 1 NAT gateway | $0.045/hr + $0.045/GB processed |
| 2 interface endpoints x 2 AZs | ~$0.04/hr + $0.01/GB |
| Gateway endpoints, VPC, subnets, SGs, IGW | free |
| Flow logs (REJECT only) | negligible |

## Explicitly out of scope

- EKS, MSK, Neptune, SageMaker, DynamoDB, frontend resources (Stages 6+).
- IAM roles, KMS keys (created with their owning stacks — see decision 8).
- NACLs (security groups only for now).
- Commit/push: separate approvals after the checkpoint, per CLAUDE.md step 5.
