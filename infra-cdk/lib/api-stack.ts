import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  API_BUNDLE,
  API_BURST_LIMIT,
  API_RATE_LIMIT,
  HANDLER_INCIDENTS,
  HANDLER_TOPOLOGY,
  TOPOLOGY_CACHE_SECONDS,
} from '../../src/lambda-transformer/src/api/names';
import { BUNDLE_DIR } from './lambda-bundle';
import { neptuneDbArn } from './neptune-stack';
import { NeptuneTarget } from './transformer-stack';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

export interface ApiStackProps extends cdk.StackProps {
  readonly incidentsTable: dynamodb.ITable;
  readonly stateTable: dynamodb.ITable;
  /** The customer-managed key both tables are encrypted with (DynamodbStack). */
  readonly tableKey: kms.IKey;
  /**
   * The graph backend. Absent (the default) means `/api/topology` answers 503 and the dashboard
   * shows incidents only, so the API can be deployed and verified against DynamoDB alone.
   */
  readonly topology?: { readonly vpc: ec2.IVpc; readonly neptune: NeptuneTarget };
}

/**
 * Stage 13: the dashboard's read-only API (API Gateway HTTP API + two Lambdas).
 *
 * Split from FrontendStack (Stage 14 decision 8) so it deploys without CloudFront: the account
 * needed AWS Support verification before it could create a distribution. Every request must carry
 * the origin header whose value is the generated secret below; CloudFront adds it (FrontendStack),
 * and `npm run dashboard:local` adds it through the Vite dev proxy. It is a demo-grade guard, not
 * user authentication.
 */
export class ApiStack extends cdk.Stack {
  public readonly api: apigwv2.HttpApi;
  public readonly originSecret: secretsmanager.Secret;
  public readonly incidentsFunction: lambda.Function;
  public readonly topologyFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const bundled = fs.existsSync(path.join(BUNDLE_DIR, API_BUNDLE));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `API bundle not found at ${path.join(BUNDLE_DIR, API_BUNDLE)}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }
    const code = bundled
      ? lambda.Code.fromAsset(BUNDLE_DIR)
      : lambda.Code.fromInline('exports.handler = async () => { throw new Error("api bundle not built"); };');

    // Generated at deploy time and resolved by CloudFormation into the Lambda environment (and, in
    // FrontendStack, the CloudFront origin header); it is never in the repo or the SPA bundle.
    this.originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      description: 'Value of the origin header the dashboard API requires (CloudFront or the local dev proxy adds it)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}LogGroup`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const baseEnv = {
      ORIGIN_SECRET: this.originSecret.secretValue.unsafeUnwrap(),
      INCIDENTS_TABLE: props.incidentsTable.tableName,
      STATE_TABLE: props.stateTable.tableName,
    };

    // --- Incidents Lambda: no VPC, DynamoDB reads ----------------------------------------------
    this.incidentsFunction = new lambda.Function(this, 'IncidentsFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: HANDLER_INCIDENTS,
      code,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      logGroup: logGroup('Incidents'),
      environment: baseEnv,
    });
    // Reads only: index queries and single-item gets on the incidents table.
    this.incidentsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:GetItem'],
        resources: [props.incidentsTable.tableArn, `${props.incidentsTable.tableArn}/index/*`],
      }),
    );
    props.tableKey.grant(this.incidentsFunction, 'kms:Decrypt');

    // --- Topology Lambda: in the VPC only when a graph backend is configured --------------------
    const topologyEnv: Record<string, string> = { ...baseEnv, TOPOLOGY_CACHE_SECONDS: String(TOPOLOGY_CACHE_SECONDS) };
    if (props.topology) {
      topologyEnv.GREMLIN_URL = `wss://${props.topology.neptune.endpoint}:${props.topology.neptune.port}/gremlin`;
      topologyEnv.NEPTUNE_IAM_AUTH = 'true';
    }
    this.topologyFunction = new lambda.Function(this, 'TopologyFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: HANDLER_TOPOLOGY,
      code,
      memorySize: 512,
      // API Gateway's HTTP API limit is 30 s; leave room for a cold Neptune handshake.
      timeout: cdk.Duration.seconds(25),
      logGroup: logGroup('Topology'),
      environment: topologyEnv,
      ...(props.topology
        ? {
            vpc: props.topology.vpc,
            vpcSubnets: { subnetGroupName: SUBNET_PRIVATE_APP },
            securityGroups: [
              new ec2.SecurityGroup(this, 'TopologySecurityGroup', {
                vpc: props.topology.vpc,
                description: 'Dashboard topology Lambda',
                allowAllOutbound: true,
              }),
            ],
          }
        : {}),
    });
    this.topologyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [`${props.incidentsTable.tableArn}/index/*`],
      }),
    );
    this.topologyFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [props.stateTable.tableArn] }),
    );
    props.tableKey.grant(this.topologyFunction, 'kms:Decrypt');
    if (props.topology) {
      // Read-only on the graph, scoped to the one cluster.
      this.topologyFunction.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['neptune-db:ReadDataViaQuery'],
          resources: [neptuneDbArn(this, props.topology.neptune.resourceId)],
        }),
      );
    }

    // --- HTTP API --------------------------------------------------------------------------------
    this.api = new apigwv2.HttpApi(this, 'Api', {
      description: 'RCA dashboard API (read-only)',
      createDefaultStage: false,
    });
    new apigwv2.HttpStage(this, 'ApiStage', {
      httpApi: this.api,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: API_RATE_LIMIT, burstLimit: API_BURST_LIMIT },
    });
    const incidentsIntegration = new integrations.HttpLambdaIntegration('IncidentsIntegration', this.incidentsFunction);
    const topologyIntegration = new integrations.HttpLambdaIntegration('TopologyIntegration', this.topologyFunction);
    for (const route of ['/api/health', '/api/incidents', '/api/incidents/{id}']) {
      this.api.addRoutes({ path: route, methods: [apigwv2.HttpMethod.GET], integration: incidentsIntegration });
    }
    this.api.addRoutes({ path: '/api/topology', methods: [apigwv2.HttpMethod.GET], integration: topologyIntegration });

    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
    // The ARN, never the value: scripts fetch the value with secretsmanager:GetSecretValue.
    new cdk.CfnOutput(this, 'OriginSecretArn', { value: this.originSecret.secretArn });
    new cdk.CfnOutput(this, 'IncidentsFunctionName', { value: this.incidentsFunction.functionName });
    new cdk.CfnOutput(this, 'TopologyFunctionName', { value: this.topologyFunction.functionName });
    new cdk.CfnOutput(this, 'TopologyBackend', { value: props.topology ? 'neptune' : 'none' });
  }
}
