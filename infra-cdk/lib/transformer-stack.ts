import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

// Output of `npm run build` in src/lambda-transformer (esbuild bundle; gitignored).
export const BUNDLE_DIR = path.join(__dirname, '..', '..', 'src', 'lambda-transformer', 'dist');
export const SOURCE_TOPIC = 'otel.traces';

export interface TransformerStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  /** ARN of the MSK cluster the collector writes spans to (MskStack). */
  readonly mskClusterArn: string;
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
      environment: {
        // No graph database exists until Stage 9: log the upserts instead. Stage 9 switches this
        // to `gremlin` and sets GREMLIN_URL to the Neptune endpoint.
        GRAPH_BACKEND: 'log',
      },
    });

    // MSK trigger. The cluster allows unauthenticated TLS clients, so no secret is configured. Parallelism is
    // bounded by the topic's 3 partitions (reserved concurrency is avoided: new accounts keep a low quota).
    this.function.addEventSource(
      new sources.ManagedKafkaEventSource({
        clusterArn: props.mskClusterArn,
        topic: SOURCE_TOPIC,
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: cdk.Duration.seconds(5),
        // Bound retries so one poison batch cannot be retried forever.
        retryAttempts: 3,
        maxRecordAge: cdk.Duration.hours(1),
      }),
    );

    new cdk.CfnOutput(this, 'FunctionName', { value: this.function.functionName });
    new cdk.CfnOutput(this, 'LogGroupName', { value: this.function.logGroup.logGroupName });
  }
}
