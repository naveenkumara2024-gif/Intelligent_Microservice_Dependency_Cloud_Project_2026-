import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class DynamodbStack extends cdk.Stack {
  // Resources added in Stage 11 (incident persistence).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
