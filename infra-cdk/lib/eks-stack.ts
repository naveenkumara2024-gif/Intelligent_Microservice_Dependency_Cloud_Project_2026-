import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class EksStack extends cdk.Stack {
  // Resources added in Stage 6 (microservices + OTel Collector on EKS).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
