import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class FrontendStack extends cdk.Stack {
  // Resources added in Stage 13 (web dashboard + API Gateway).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
