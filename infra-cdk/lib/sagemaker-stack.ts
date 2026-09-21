import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class SagemakerStack extends cdk.Stack {
  // Resources added in Stage 10 (SageMaker endpoint hosting the trained model).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
