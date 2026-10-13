import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { BUNDLE_DIR } from './lambda-bundle';
import { neptuneDbArn } from './neptune-stack';
import { ENDPOINT_NAME } from './sagemaker-stack';
import { NeptuneTarget } from './transformer-stack';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

export const SCORER_BUNDLE = 'scorer.js';
/** How often the scorer judges a window. The window IS the interval between two runs. */
export const SCORER_INTERVAL_MINUTES = 1;

export interface ScorerStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly neptune: NeptuneTarget;
  readonly incidentsTable: dynamodb.ITable;
  readonly stateTable: dynamodb.ITable;
  /** The customer-managed key both tables are encrypted with (DynamodbStack). */
  readonly tableKey: kms.IKey;
}

/**
 * Stage 11 scorer: every minute, reads the live graph from Neptune, asks the SageMaker endpoint
 * for a root cause when a service is measurably slower than its baseline, and persists incidents.
 *
 * Separate from DynamodbStack so the tables can be deployed and verified alone, and from
 * TransformerStack because that one needs MSK. The endpoint is referenced by its constant name
 * (SagemakerStack stays independent, as decided in Stage 10), so it must be InService at run time.
 */
export class ScorerStack extends cdk.Stack {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: ScorerStackProps) {
    super(scope, id, props);

    const bundled = fs.existsSync(path.join(BUNDLE_DIR, SCORER_BUNDLE));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `Scorer bundle not found at ${path.join(BUNDLE_DIR, SCORER_BUNDLE)}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }

    const securityGroup = new ec2.SecurityGroup(this, 'FunctionSecurityGroup', {
      vpc: props.vpc,
      description: 'Incident scorer Lambda',
      allowAllOutbound: true,
    });

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'scorer.handler',
      code: bundled
        ? lambda.Code.fromAsset(BUNDLE_DIR)
        : lambda.Code.fromInline('exports.handler = async () => { throw new Error("scorer bundle not built"); };'),
      memorySize: 512,
      // A cold serverless endpoint took 13.7 s; Neptune reads and the writes are well under a second.
      timeout: cdk.Duration.seconds(60),
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: SUBNET_PRIVATE_APP },
      securityGroups: [securityGroup],
      // A failed run is simply retried by the next scheduled one; an async retry would overlap it.
      retryAttempts: 0,
      logGroup: new logs.LogGroup(this, 'LogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        GREMLIN_URL: `wss://${props.neptune.endpoint}:${props.neptune.port}/gremlin`,
        NEPTUNE_IAM_AUTH: 'true',
        ENDPOINT_NAME,
        INCIDENTS_TABLE: props.incidentsTable.tableName,
        STATE_TABLE: props.stateTable.tableName,
      },
    });

    // --- Least privilege: each statement is the minimum the code path uses ---------------------
    // Reads only. If the first live read is denied, read the denial; do not widen to neptune-db:*
    // (Stage 9c's surprise was that overwriting a property is authorized as DeleteDataViaQuery).
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['neptune-db:ReadDataViaQuery'],
        resources: [neptuneDbArn(this, props.neptune.resourceId)],
      }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [
          this.formatArn({
            service: 'sagemaker',
            resource: 'endpoint',
            resourceName: ENDPOINT_NAME,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // State: read the item, write it back (inside the transaction). Incidents: write only.
    this.function.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [props.stateTable.tableArn] }),
    );
    this.function.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [props.incidentsTable.tableArn] }),
    );
    props.tableKey.grantEncryptDecrypt(this.function);

    new events.Rule(this, 'Schedule', {
      description: 'Incident scorer window',
      schedule: events.Schedule.rate(cdk.Duration.minutes(SCORER_INTERVAL_MINUTES)),
      targets: [new targets.LambdaFunction(this.function, { retryAttempts: 0 })],
    });

    new cdk.CfnOutput(this, 'FunctionName', { value: this.function.functionName });
    new cdk.CfnOutput(this, 'LogGroupName', { value: this.function.logGroup.logGroupName });
  }
}
