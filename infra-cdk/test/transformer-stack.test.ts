import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { MskStack } from '../lib/msk-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { TransformerStack } from '../lib/transformer-stack';
import { VpcStack } from '../lib/vpc-stack';

const env = { region: 'us-east-1' };
const app = new cdk.App();
const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
const mskStack = new MskStack(app, 'TestMskStack', { env, vpc: vpcStack.vpc });
const stack = new TransformerStack(app, 'TestTransformerStack', {
  env,
  vpc: vpcStack.vpc,
  mskClusterArn: mskStack.cluster.attrArn,
});
const template = Template.fromStack(stack);

const functionResource = () => Object.values(template.findResources('AWS::Lambda::Function'))[0];

describe('TransformerStack', () => {
  test('Node 22 function with the bundle entry point, sized for small batches', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      MemorySize: 256,
      Timeout: 60,
    });
  });

  test('logs to the console until Neptune exists (GRAPH_BACKEND=log), with no database URL', () => {
    const vars = functionResource().Properties.Environment.Variables;
    expect(vars).toEqual({ GRAPH_BACKEND: 'log' });
  });

  test('runs in the two private-app subnets, never in public or private-data', () => {
    const vpcConfig = functionResource().Properties.VpcConfig;
    expect(vpcConfig.SubnetIds).toHaveLength(2);
    const subnets = JSON.stringify(vpcConfig.SubnetIds);
    expect(subnets).toContain('privateapp');
    expect(subnets).not.toContain('public');
    expect(subnets).not.toContain('privatedata');
  });

  test('MSK trigger on otel.traces: LATEST, batches of 100 within 5 s, no secret', () => {
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      Topics: ['otel.traces'],
      StartingPosition: 'LATEST',
      BatchSize: 100,
      MaximumBatchingWindowInSeconds: 5,
    });
    const mapping = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))[0];
    // Enabled is a CloudFormation default and is omitted from the template; it must not be false.
    expect(mapping.Properties.Enabled).not.toBe(false);
    // Regression: Lambda rejects MaximumRetryAttempts / MaximumRecordAgeInSeconds on an MSK mapping
    // unless provisioned mode is enabled ("only available for provisioned mode").
    expect(mapping.Properties.MaximumRetryAttempts).toBeUndefined();
    expect(mapping.Properties.MaximumRecordAgeInSeconds).toBeUndefined();
    expect(mapping.Properties.ProvisionedPollerConfig).toBeUndefined();
    // The cluster allows unauthenticated TLS clients, so no Secrets Manager access is configured.
    expect(mapping.Properties.SourceAccessConfigurations).toBeUndefined();
  });

  test('MSK permissions are scoped to the cluster, not "*"', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement);
    const kafka = statements.filter((s: any) => [].concat(s.Action).some((a: string) => a.startsWith('kafka:')));
    expect(kafka.length).toBeGreaterThan(0);
    for (const s of kafka) {
      expect(JSON.stringify(s.Resource)).not.toBe('"*"');
    }
  });

  test('VPC networking access comes from the AWS-managed execution policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('AWSLambdaVPCAccessExecutionRole')])]) }),
      ]),
    });
  });

  test('log group keeps one week of logs', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  test('no reserved concurrency (a new account keeps a low concurrency quota)', () => {
    expect(functionResource().Properties.ReservedConcurrentExecutions).toBeUndefined();
  });

  test('exports the function and log group names for the verify script', () => {
    template.hasOutput('FunctionName', {});
    template.hasOutput('LogGroupName', {});
  });

  test('without a Neptune target it has no neptune-db permission at all', () => {
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );
    expect(JSON.stringify(statements)).not.toContain('neptune-db');
  });
});

describe('TransformerStack with graphBackend=neptune', () => {
  const app2 = new cdk.App();
  const vpc2 = new VpcStack(app2, 'TestVpcStack2', { env });
  const msk2 = new MskStack(app2, 'TestMskStack2', { env, vpc: vpc2.vpc });
  const neptune2 = new NeptuneStack(app2, 'TestNeptuneStack2', { env, vpc: vpc2.vpc });
  const stack2 = new TransformerStack(app2, 'TestTransformerStack2', {
    env,
    vpc: vpc2.vpc,
    mskClusterArn: msk2.cluster.attrArn,
    neptune: {
      endpoint: neptune2.cluster.attrEndpoint,
      port: neptune2.cluster.attrPort,
      resourceId: neptune2.cluster.attrClusterResourceId,
    },
  });
  const t2 = Template.fromStack(stack2);
  const fn2 = () => Object.values(t2.findResources('AWS::Lambda::Function'))[0] as any;

  test('writes through the Gremlin backend with IAM authentication to the cluster endpoint', () => {
    const vars = fn2().Properties.Environment.Variables;
    expect(vars.GRAPH_BACKEND).toBe('gremlin');
    expect(vars.NEPTUNE_IAM_AUTH).toBe('true');
    expect(JSON.stringify(vars.GREMLIN_URL)).toContain('wss://');
    expect(JSON.stringify(vars.GREMLIN_URL)).toContain('/gremlin');
  });

  test('may read, write and overwrite (DeleteDataViaQuery) on this cluster only, and nothing administrative', () => {
    const statements = Object.values(t2.findResources('AWS::IAM::Policy')).flatMap(
      (p: any) => p.Properties.PolicyDocument.Statement,
    );
    const neptune = statements.filter((s: any) => [].concat(s.Action).some((a: string) => a.startsWith('neptune-db:')));
    expect(neptune).toHaveLength(1);
    // Overwriting a property is a delete+write to Neptune's authorizer (Stage 9c, found live).
    expect(neptune[0].Action).toEqual([
      'neptune-db:ReadDataViaQuery',
      'neptune-db:WriteDataViaQuery',
      'neptune-db:DeleteDataViaQuery',
    ]);
    // ...but never engine administration (status is the probe's, resets and loaders are nobody's)
    expect(JSON.stringify(neptune[0].Action)).not.toMatch(/GetEngineStatus|ExecuteFastReset|StartLoaderJob|ManageStatistics/);
    expect(JSON.stringify(neptune[0].Resource)).not.toBe('"*"');
  });

  test('the MSK trigger is unchanged by the backend switch', () => {
    t2.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    t2.hasResourceProperties('AWS::Lambda::EventSourceMapping', { Topics: ['otel.traces'] });
  });
});
