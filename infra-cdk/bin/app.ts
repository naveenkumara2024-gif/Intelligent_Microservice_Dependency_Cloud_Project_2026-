#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack } from '../lib/vpc-stack';
import { EksStack } from '../lib/eks-stack';
import { MskStack } from '../lib/msk-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { DynamodbStack } from '../lib/dynamodb-stack';
import { SagemakerStack } from '../lib/sagemaker-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { TransformerStack } from '../lib/transformer-stack';

// Region is pinned (CLAUDE.md: us-east-1). The account comes from the CDK CLI
// (CDK_DEFAULT_ACCOUNT, resolved from credentials); it is undefined when
// running `cdk synth` without credentials, which leaves the account
// unresolved but still synthesizes fine.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' };
const app = new cdk.App();

const vpcStack = new VpcStack(app, 'VpcStack', { env });
const eksStack = new EksStack(app, 'EksStack', { env, vpc: vpcStack.vpc });
const mskStack = new MskStack(app, 'MskStack', { env, vpc: vpcStack.vpc });
// `-c neptuneReplica=true` adds the AZ-2 read replica (off by default: it doubles instance cost).
const neptuneStack = new NeptuneStack(app, 'NeptuneStack', {
  env,
  vpc: vpcStack.vpc,
  readReplica: String(app.node.tryGetContext('neptuneReplica')) === 'true',
});
const dynamodbStack = new DynamodbStack(app, 'DynamodbStack', { env });
const sagemakerStack = new SagemakerStack(app, 'SagemakerStack', { env });
const frontendStack = new FrontendStack(app, 'FrontendStack', { env });
// `-c graphBackend=neptune` points the transformer at Neptune (IAM auth); the default logs the
// upserts, so Stage 8b can be deployed and verified without Neptune (and its cost).
const graphBackend = String(app.node.tryGetContext('graphBackend') ?? 'log');
if (graphBackend !== 'log' && graphBackend !== 'neptune') {
  throw new Error(`Unknown graphBackend "${graphBackend}" (expected "log" or "neptune")`);
}
const transformerStack = new TransformerStack(app, 'TransformerStack', {
  env,
  vpc: vpcStack.vpc,
  mskClusterArn: mskStack.cluster.attrArn,
  neptune:
    graphBackend === 'neptune'
      ? {
          endpoint: neptuneStack.cluster.attrEndpoint,
          port: neptuneStack.cluster.attrPort,
          resourceId: neptuneStack.cluster.attrClusterResourceId,
        }
      : undefined,
});

// Dependency order per CLAUDE.md "Working conventions": VPC first, then
// anything needing the VPC (EKS/MSK/Neptune), then SageMaker last (needs a
// trained model artifact to actually deploy).
eksStack.addStackDependency(vpcStack);
mskStack.addStackDependency(vpcStack);
neptuneStack.addStackDependency(vpcStack);
sagemakerStack.addStackDependency(dynamodbStack);
transformerStack.addStackDependency(mskStack);
if (graphBackend === 'neptune') {
  transformerStack.addStackDependency(neptuneStack);
}
