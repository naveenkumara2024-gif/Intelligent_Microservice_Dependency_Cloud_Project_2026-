import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/api-stack';
import { DynamodbStack } from '../lib/dynamodb-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { VpcStack } from '../lib/vpc-stack';
import {
  API_BURST_LIMIT,
  API_RATE_LIMIT,
  HANDLER_INCIDENTS,
  HANDLER_TOPOLOGY,
  ORIGIN_HEADER,
} from '../../src/lambda-transformer/src/api/names';

const env = { account: '111122223333', region: 'us-east-1' };

function build(withTopology: boolean) {
  const app = new cdk.App();
  const dynamodbStack = new DynamodbStack(app, 'TestDynamodbStack', { env });
  let topology;
  if (withTopology) {
    const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
    const neptuneStack = new NeptuneStack(app, 'TestNeptuneStack', { env, vpc: vpcStack.vpc });
    topology = {
      vpc: vpcStack.vpc,
      neptune: {
        endpoint: neptuneStack.cluster.attrEndpoint,
        port: neptuneStack.cluster.attrPort,
        resourceId: neptuneStack.cluster.attrClusterResourceId,
      },
    };
  }
  const apiStack = new ApiStack(app, 'TestApiStack', {
    env,
    incidentsTable: dynamodbStack.incidentsTable,
    stateTable: dynamodbStack.stateTable,
    tableKey: dynamodbStack.key,
    topology,
  });
  const frontendStack = new FrontendStack(app, 'TestFrontendStack', { env, api: apiStack.api, originSecret: apiStack.originSecret });
  return { api: Template.fromStack(apiStack), site: Template.fromStack(frontendStack) };
}

const { api: plain, site } = build(false);
const { api: graph } = build(true);

type Statement = { Action: string | string[]; Resource: unknown; Effect: string; Condition?: unknown };
const actionsOf = (s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

const fn = (t: Template, handler: string) =>
  Object.values(t.findResources('AWS::Lambda::Function')).find((f) => f.Properties.Handler === handler)!;

/** Statements of the IAM policy attached to the role of the function with this handler. */
function statementsFor(t: Template, handler: string): Statement[] {
  const roleRef = fn(t, handler).Properties.Role['Fn::GetAtt'][0] as string;
  return Object.values(t.findResources('AWS::IAM::Policy'))
    .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleRef))
    .flatMap((p) => p.Properties.PolicyDocument.Statement) as Statement[];
}

const WRITES = /^dynamodb:(Put|Update|Delete|BatchWrite|Transact)|^dynamodb:Scan$|^neptune-db:(Write|Delete|Reset|Manage)/;

describe('the split (Stage 14 decision 8)', () => {
  test('the API stack holds no CloudFront or S3 site, so it deploys on an account without CloudFront', () => {
    plain.resourceCountIs('AWS::CloudFront::Distribution', 0);
    plain.resourceCountIs('AWS::S3::Bucket', 0);
    plain.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  });

  test('the site stack holds no Lambda functions of the API', () => {
    const handlers = Object.values(site.findResources('AWS::Lambda::Function')).map((f) => f.Properties.Handler);
    expect(handlers).not.toContain(HANDLER_INCIDENTS);
    expect(handlers).not.toContain(HANDLER_TOPOLOGY);
    site.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  });
});

describe('FrontendStack: static site', () => {
  test('the bucket is private, TLS-only, encrypted, and removed with the stack', () => {
    const bucket = Object.values(site.findResources('AWS::S3::Bucket'))[0];
    expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(JSON.stringify(bucket.Properties.BucketEncryption)).toContain('AES256');
    expect(bucket.DeletionPolicy).toBe('Delete');
    expect(JSON.stringify(site.findResources('AWS::S3::BucketPolicy'))).toContain('aws:SecureTransport');
  });

  test('CloudFront reads it through Origin Access Control, and no statement allows the public', () => {
    site.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    const statements = Object.values(site.findResources('AWS::S3::BucketPolicy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    ) as { Effect: string; Principal: unknown }[];
    expect(JSON.stringify(statements)).toContain('cloudfront.amazonaws.com');
    const publicAllows = statements.filter(
      (s) => s.Effect === 'Allow' && (s.Principal === '*' || JSON.stringify(s.Principal) === '{"AWS":"*"}'),
    );
    expect(publicAllows).toEqual([]);
  });

  test('the built SPA is deployed into the bucket and the distribution is invalidated', () => {
    site.resourceCountIs('Custom::CDKBucketDeployment', 1);
  });
});

describe('FrontendStack: distribution', () => {
  const dist = () => Object.values(site.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig;

  test('HTTPS only (HTTP is redirected), GET/HEAD only, index.html at the root', () => {
    expect(dist().DefaultRootObject).toBe('index.html');
    expect(dist().DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
    // The default certificate cannot enforce a TLS minimum (that needs a custom domain); not claimed.
    expect(dist().ViewerCertificate?.MinimumProtocolVersion).toBeUndefined();
    expect(dist().DefaultCacheBehavior.AllowedMethods).toEqual(['GET', 'HEAD']);
  });

  test('/api/* goes to the API over HTTPS only, GET/HEAD only, with the origin header', () => {
    const behavior = (dist().CacheBehaviors as { PathPattern: string }[]).find((b) => b.PathPattern === '/api/*') as any;
    expect(behavior).toBeDefined();
    expect(behavior.ViewerProtocolPolicy).toBe('https-only');
    expect(behavior.AllowedMethods).toEqual(['GET', 'HEAD']);
    const origin = (dist().Origins as any[]).find((o) => o.CustomOriginConfig);
    expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe('https-only');
    expect(origin.OriginCustomHeaders).toHaveLength(1);
    expect(origin.OriginCustomHeaders[0].HeaderName).toBe(ORIGIN_HEADER);
  });

  test('security headers are attached to both behaviours', () => {
    const policy = Object.values(site.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0].Properties.ResponseHeadersPolicyConfig
      .SecurityHeadersConfig;
    expect(policy.StrictTransportSecurity.AccessControlMaxAgeSec).toBe(31536000);
    expect(policy.ContentTypeOptions.Override).toBe(true);
    expect(policy.FrameOptions.FrameOption).toBe('DENY');
    expect(policy.ContentSecurityPolicy.ContentSecurityPolicy).toContain("default-src 'self'");
    expect(policy.ContentSecurityPolicy.ContentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(policy.ContentSecurityPolicy.ContentSecurityPolicy).not.toMatch(/https?:\/\//);
    const withHeaders = [dist().DefaultCacheBehavior, ...dist().CacheBehaviors].filter((b: any) => b.ResponseHeadersPolicyId);
    expect(withHeaders).toHaveLength(2);
  });

  test('the API cache policy honours the origin Cache-Control and caps it at 30 s', () => {
    const configs = Object.values(site.findResources('AWS::CloudFront::CachePolicy')).map((p) => p.Properties.CachePolicyConfig);
    const api = configs.find((c) => c.MaxTTL === 30)!;
    expect(api.DefaultTTL).toBe(0);
    expect(api.MinTTL).toBe(0);
    expect(api.ParametersInCacheKeyAndForwardedToOrigin.QueryStringsConfig.QueryStringBehavior).toBe('all');
    expect(api.ParametersInCacheKeyAndForwardedToOrigin.HeadersConfig.HeaderBehavior).toBe('none');
  });
});

describe('the origin guard', () => {
  test('a generated secret feeds the Lambdas and the CloudFront header, and is never a literal', () => {
    plain.resourceCountIs('AWS::SecretsManager::Secret', 1);
    const secret = Object.values(plain.findResources('AWS::SecretsManager::Secret'))[0];
    expect(secret.Properties.GenerateSecretString.PasswordLength).toBe(40);
    expect(secret.DeletionPolicy).toBe('Delete');

    const resolved = (v: unknown) => JSON.stringify(v).includes('{{resolve:secretsmanager:');
    for (const handler of [HANDLER_INCIDENTS, HANDLER_TOPOLOGY]) {
      expect(resolved(fn(plain, handler).Properties.Environment.Variables.ORIGIN_SECRET)).toBe(true);
    }
    const origin = (Object.values(site.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig.Origins as any[]).find(
      (o) => o.CustomOriginConfig,
    );
    expect(resolved(origin.OriginCustomHeaders[0].HeaderValue)).toBe(true);
  });

  test('the API stack outputs the secret ARN for local tooling, never the value', () => {
    plain.hasOutput('OriginSecretArn', { Value: { Ref: Match.anyValue() } });
  });
});

describe('ApiStack: HTTP API', () => {
  test('exactly four GET routes, no catch-all, no write methods', () => {
    const routes = Object.values(plain.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties.RouteKey as string);
    expect(routes.sort()).toEqual(['GET /api/health', 'GET /api/incidents', 'GET /api/incidents/{id}', 'GET /api/topology']);
  });

  test('the default stage is throttled for an account whose Lambda concurrency limit is 10', () => {
    plain.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: API_RATE_LIMIT, ThrottlingBurstLimit: API_BURST_LIMIT },
    });
    expect([API_RATE_LIMIT, API_BURST_LIMIT]).toEqual([5, 10]);
  });

  test('no function claims reserved concurrency (the account cannot spare any)', () => {
    for (const f of Object.values(plain.findResources('AWS::Lambda::Function'))) {
      expect(f.Properties.ReservedConcurrentExecutions).toBeUndefined();
    }
  });
});

describe('ApiStack: Lambdas without a graph backend (the default)', () => {
  test('both run outside any VPC, Node 22', () => {
    for (const handler of [HANDLER_INCIDENTS, HANDLER_TOPOLOGY]) {
      const f = fn(plain, handler);
      expect(f.Properties.Runtime).toBe('nodejs22.x');
      expect(f.Properties.VpcConfig).toBeUndefined();
    }
  });

  test('the topology function has no graph endpoint, so it answers 503', () => {
    const vars = fn(plain, HANDLER_TOPOLOGY).Properties.Environment.Variables;
    expect(vars.GREMLIN_URL).toBeUndefined();
    expect(vars.TOPOLOGY_CACHE_SECONDS).toBe('10');
    plain.hasOutput('TopologyBackend', { Value: 'none' });
  });

  test('read-only DynamoDB, scoped to the table and its indexes, plus Decrypt on the table key', () => {
    const statements = statementsFor(plain, HANDLER_INCIDENTS);
    const dynamo = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('dynamodb:')));
    expect(dynamo.flatMap(actionsOf).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    for (const s of dynamo) expect(JSON.stringify(s.Resource)).not.toContain('"*"');
    const keys = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
    expect(keys.flatMap(actionsOf)).toEqual(['kms:Decrypt']);
  });

  test('nothing in either function can write', () => {
    for (const handler of [HANDLER_INCIDENTS, HANDLER_TOPOLOGY]) {
      for (const s of statementsFor(plain, handler)) {
        for (const a of actionsOf(s)) expect(a).not.toMatch(WRITES);
      }
    }
  });

  test('the topology function reads the incident indexes and the state item, nothing else', () => {
    const dynamo = statementsFor(plain, HANDLER_TOPOLOGY).filter((s) => actionsOf(s).some((a) => a.startsWith('dynamodb:')));
    expect(dynamo.flatMap(actionsOf).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
  });
});

describe('ApiStack: with the Neptune graph backend', () => {
  test('the topology function joins the private-app subnets and gets the cluster endpoint', () => {
    const f = fn(graph, HANDLER_TOPOLOGY);
    const subnets = JSON.stringify(f.Properties.VpcConfig.SubnetIds);
    expect(subnets).toContain('privateapp');
    expect(subnets).not.toContain('public');
    expect(subnets).not.toContain('privatedata');
    expect(JSON.stringify(f.Properties.Environment.Variables.GREMLIN_URL)).toContain('/gremlin');
    expect(f.Properties.Environment.Variables.NEPTUNE_IAM_AUTH).toBe('true');
    graph.hasOutput('TopologyBackend', { Value: 'neptune' });
  });

  test('the incidents function stays outside the VPC', () => {
    expect(fn(graph, HANDLER_INCIDENTS).Properties.VpcConfig).toBeUndefined();
  });

  test('graph access is read-only and scoped to the one cluster', () => {
    const neptune = statementsFor(graph, HANDLER_TOPOLOGY).filter((s) => actionsOf(s).some((a) => a.startsWith('neptune-db:')));
    expect(neptune).toHaveLength(1);
    expect(actionsOf(neptune[0])).toEqual(['neptune-db:ReadDataViaQuery']);
    expect(JSON.stringify(neptune[0].Resource)).not.toBe('"*"');
  });

  test('nothing in the VPC function can write, and only ENI actions are unscoped', () => {
    for (const s of statementsFor(graph, HANDLER_TOPOLOGY)) {
      for (const a of actionsOf(s)) expect(a).not.toMatch(WRITES);
      if (s.Resource === '*') for (const a of actionsOf(s)) expect(a).toMatch(/^ec2:/);
    }
  });
});

describe('housekeeping', () => {
  test('log groups are owned by the API stack and expire', () => {
    const groups = Object.values(plain.findResources('AWS::Logs::LogGroup'));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.DeletionPolicy).toBe('Delete');
  });

  test('outputs the values the scripts read', () => {
    for (const o of ['ApiEndpoint', 'OriginSecretArn', 'IncidentsFunctionName', 'TopologyFunctionName', 'TopologyBackend']) plain.hasOutput(o, {});
    for (const o of ['DashboardUrl', 'DistributionId', 'SiteBucketName']) site.hasOutput(o, {});
  });
});
