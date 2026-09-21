import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class VpcStack extends cdk.Stack {
  // Resources added in Stage 5 (core networking).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
