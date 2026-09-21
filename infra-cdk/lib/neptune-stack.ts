import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class NeptuneStack extends cdk.Stack {
  // Resources added in Stage 9 (Neptune deployed, verified against Stage 2's Neo4j prototype).
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
  }
}
