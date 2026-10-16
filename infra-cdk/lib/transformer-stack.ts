import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { BUNDLE_DIR } from './lambda-bundle';
import { neptuneDbArn } from './neptune-stack';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

export const SOURCE_TOPIC = 'otel.traces';

/** Where the transformer writes the graph. Chosen at deploy time with `-c graphBackend=neptune`. */
export interface NeptuneTarget {
  /** Cluster endpoint (CfnDBCluster.attrEndpoint) and port. */
  readonly endpoint: string;
  readonly port: string;
  /** Cluster resource id (cluster-XXXX), which Neptune IAM authorization uses in ARNs. */
  readonly resourceId: string;
}

export interface TransformerStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  /** ARN of the MSK cluster the collector writes spans to (MskStack). */
  readonly mskClusterArn: string;
  /** When set, upserts go to Neptune (IAM-authenticated); otherwise they are logged (GRAPH_BACKEND=log). */
  readonly neptune?: NeptuneTarget;
}

export class TransformerStack extends cdk.Stack {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: TransformerStackProps) {
    super(scope, id, props);

    // `cdk synth` must keep working on a fresh checkout where the bundle was never built, so a
    // missing bundle becomes a placeholder that fails loudly if it is ever invoked. The deploy
    // script builds the bundle first and refuses to deploy without it.
    const bundled = fs.existsSync(path.join(BUNDLE_DIR, 'index.js'));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `Lambda bundle not found at ${BUNDLE_DIR}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }

    // The function runs in private-app, which MskStack's broker security group allows on 9094,
    // and reaches the internet (STS, CloudWatch, the event source poller) through the NAT.
    const securityGroup = new ec2.SecurityGroup(this, 'FunctionSecurityGroup', {
      vpc: props.vpc,
      description: 'Graph transformer Lambda',
      allowAllOutbound: true,
    });

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: bundled
        ? lambda.Code.fromAsset(BUNDLE_DIR)
        : lambda.Code.fromInline('exports.handler = async () => { throw new Error("transformer bundle not built"); };'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: SUBNET_PRIVATE_APP },
      securityGroups: [securityGroup],
      logGroup: new logs.LogGroup(this, 'LogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: props.neptune
        ? {
            GRAPH_BACKEND: 'gremlin',
            GREMLIN_URL: `wss://${props.neptune.endpoint}:${props.neptune.port}/gremlin`,
            NEPTUNE_IAM_AUTH: 'true',
          }
        : {
            // Default: log the upserts. Deploy with `-c graphBackend=neptune` once NeptuneStack exists.
            GRAPH_BACKEND: 'log',
          },
    });

    if (props.neptune) {
      // Upserts read before they write (coalesce), and OVERWRITING a property value (the counters,
      // last_seen_ms, latency_recent_avg_ms) is authorized by Neptune as a delete of the old value
      // plus a write of the new one, so DeleteDataViaQuery is required too. Found in Stage 9c: the
      // first live write failed with "not authorized to perform: neptune-db:DeleteDataViaQuery".
      // The action is coarse (it cannot be limited to property overwrites); scope is this cluster only.
      this.function.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['neptune-db:ReadDataViaQuery', 'neptune-db:WriteDataViaQuery', 'neptune-db:DeleteDataViaQuery'],
          resources: [neptuneDbArn(this, props.neptune.resourceId)],
        }),
      );
    }

    // MSK trigger. The cluster allows unauthenticated TLS clients, so no secret is configured. Parallelism is
    // bounded by the topic's 3 partitions (reserved concurrency is avoided: new accounts keep a low quota).
    //
    // No retryAttempts / maxRecordAge: for MSK, Lambda only offers those in "provisioned mode" (dedicated,
    // separately billed pollers) and rejects the mapping otherwise ("MaximumRetryAttempts is only available
    // for provisioned mode", found when this stack first deployed). On-demand mode retries a failing batch
    // until it succeeds or the record leaves the topic (24 h retention). That is the right behaviour for the
    // failure we expect (Neptune briefly unavailable), and a poison record cannot wedge a partition because
    // the handler skips malformed records and spans instead of throwing.
    this.function.addEventSource(
      new sources.ManagedKafkaEventSource({
        clusterArn: props.mskClusterArn,
        topic: SOURCE_TOPIC,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
      }),
    );

    new cdk.CfnOutput(this, 'FunctionName', { value: this.function.functionName });
    new cdk.CfnOutput(this, 'LogGroupName', { value: this.function.logGroup.logGroupName });
  }
}
