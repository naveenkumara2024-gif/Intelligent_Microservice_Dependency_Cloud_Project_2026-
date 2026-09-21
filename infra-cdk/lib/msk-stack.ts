import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MskStack extends cdk.Stack {
  // Resources added in Stage 7 (MSK streaming pipeline).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
