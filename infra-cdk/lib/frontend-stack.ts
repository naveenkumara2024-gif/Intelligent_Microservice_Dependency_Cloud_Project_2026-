import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  API_BUNDLE,
  API_BURST_LIMIT,
  API_RATE_LIMIT,
  HANDLER_INCIDENTS,
  HANDLER_TOPOLOGY,
  ORIGIN_HEADER,
  TOPOLOGY_CACHE_SECONDS,
} from '../../src/lambda-transformer/src/api/names';
import { BUNDLE_DIR } from './lambda-bundle';
import { neptuneDbArn } from './neptune-stack';
import { NeptuneTarget } from './transformer-stack';
import { SUBNET_PRIVATE_APP } from './vpc-stack';

/** Output of `npm run build` in src/web-dashboard (Vite). */
export const DASHBOARD_DIST = path.join(__dirname, '..', '..', 'src', 'web-dashboard', 'dist');

export interface FrontendStackProps extends cdk.StackProps {
  readonly incidentsTable: dynamodb.ITable;
  readonly stateTable: dynamodb.ITable;
  /** The customer-managed key both tables are encrypted with (DynamodbStack). */
  readonly tableKey: kms.IKey;
  /**
   * The graph backend. Absent (the default) means `/api/topology` answers 503 and the dashboard
   * shows incidents only, so the stack can be deployed and verified against DynamoDB alone.
   */
  readonly topology?: { readonly vpc: ec2.IVpc; readonly neptune: NeptuneTarget };
}

/**
 * Stage 13: the dashboard and its API.
 *
 *   Browser -> CloudFront -+- /*      -> private S3 bucket (Origin Access Control): the SPA
 *                          '- /api/*  -> API Gateway HTTP API -> Lambda (read-only)
 *
 * Same origin for browser and API (no CORS). The API Lambdas require a header that only CloudFront
 * adds (a generated secret), so the raw execute-api URL is not a second public door; this is a
 * demo-grade guard, not user authentication. Everything is removed with the stack.
 */
export class FrontendStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;
  public readonly api: apigwv2.HttpApi;
  public readonly incidentsFunction: lambda.Function;
  public readonly topologyFunction: lambda.Function;
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    // --- Lambda code and the origin secret -----------------------------------------------------
    const bundled = fs.existsSync(path.join(BUNDLE_DIR, API_BUNDLE));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `API bundle not found at ${path.join(BUNDLE_DIR, API_BUNDLE)}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }
    const code = bundled
      ? lambda.Code.fromAsset(BUNDLE_DIR)
      : lambda.Code.fromInline('exports.handler = async () => { throw new Error("api bundle not built"); };');

    // Generated at deploy time and resolved by CloudFormation into both the CloudFront origin header
    // and the Lambda environment; it is never in the repo or the SPA bundle.
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      description: 'Value of the origin header CloudFront adds to API requests (dashboard API guard)',
      generateSecretString: { excludePunctuation: true, passwordLength: 40 },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const originSecretValue = originSecret.secretValue.unsafeUnwrap();

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}LogGroup`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const baseEnv = {
      ORIGIN_SECRET: originSecretValue,
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

    // --- Static site: private bucket behind CloudFront -------------------------------------------
    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: cdk.Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        contentSecurityPolicy: {
          // Cytoscape draws on a canvas; React sets style attributes inline. Nothing is loaded from
          // another origin, and the API is same-origin.
          contentSecurityPolicy:
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
          override: true,
        },
      },
    });

    // Honour the Cache-Control the Lambdas send (topology: 10 s; everything else: no-store).
    const apiCachePolicy = new cloudfront.CachePolicy(this, 'ApiCachePolicy', {
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(30),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const apiOrigin = new origins.HttpOrigin(cdk.Fn.select(2, cdk.Fn.split('/', this.api.apiEndpoint)), {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { [ORIGIN_HEADER]: originSecretValue },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'RCA dashboard',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // No minimumProtocolVersion: with the default *.cloudfront.net certificate CloudFront ignores it
      // (a minimum of TLS 1.2 needs a custom domain and certificate, which is out of scope here).
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: apiCachePolicy,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
    });

    // --- The built SPA ---------------------------------------------------------------------------
    const built = fs.existsSync(path.join(DASHBOARD_DIST, 'index.html'));
    if (!built) {
      cdk.Annotations.of(this).addWarning(
        `Dashboard build not found at ${DASHBOARD_DIST}; run \`npm run build\` in src/web-dashboard before deploying.`,
      );
    }
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        built
          ? s3deploy.Source.asset(DASHBOARD_DIST)
          : s3deploy.Source.data('index.html', '<!doctype html><title>RCA</title><p>Dashboard not built.</p>'),
      ],
      destinationBucket: this.bucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
      // The bundle names are content hashed: keep only what the current build references.
      prune: true,
    });

    new cdk.CfnOutput(this, 'DashboardUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: this.bucket.bucketName });
    new cdk.CfnOutput(this, 'IncidentsFunctionName', { value: this.incidentsFunction.functionName });
    new cdk.CfnOutput(this, 'TopologyFunctionName', { value: this.topologyFunction.functionName });
    new cdk.CfnOutput(this, 'TopologyBackend', { value: props.topology ? 'neptune' : 'none' });
  }
}
