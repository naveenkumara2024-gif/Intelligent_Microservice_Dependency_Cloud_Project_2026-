#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { VpcStack } from '../lib/vpc-stack';
import { EksStack } from '../lib/eks-stack';
import { MskStack } from '../lib/msk-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { DynamodbStack } from '../lib/dynamodb-stack';
import { SagemakerStack } from '../lib/sagemaker-stack';
import { FrontendStack } from '../lib/frontend-stack';

// No `env` specified: stacks stay environment-agnostic for now (no AWS
// account/region lookups needed). Real env config arrives with Stage 5's
// actual networking work.
const app = new cdk.App();

const vpcStack = new VpcStack(app, 'VpcStack');
const eksStack = new EksStack(app, 'EksStack');
const mskStack = new MskStack(app, 'MskStack');
const neptuneStack = new NeptuneStack(app, 'NeptuneStack');
const dynamodbStack = new DynamodbStack(app, 'DynamodbStack');
const sagemakerStack = new SagemakerStack(app, 'SagemakerStack');
const frontendStack = new FrontendStack(app, 'FrontendStack');

// Dependency order per CLAUDE.md "Working conventions": VPC first, then
// anything needing the VPC (EKS/MSK/Neptune), then SageMaker last (needs a
// trained model artifact to actually deploy).
eksStack.addStackDependency(vpcStack);
mskStack.addStackDependency(vpcStack);
neptuneStack.addStackDependency(vpcStack);
sagemakerStack.addStackDependency(dynamodbStack);
