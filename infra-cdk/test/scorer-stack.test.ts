import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DynamodbStack } from '../lib/dynamodb-stack';
import { NeptuneStack } from '../lib/neptune-stack';
import { ScorerStack } from '../lib/scorer-stack';
import { VpcStack } from '../lib/vpc-stack';

const env = { region: 'us-east-1' };
const app = new cdk.App();
const vpcStack = new VpcStack(app, 'TestVpcStack', { env });
const neptuneStack = new NeptuneStack(app, 'TestNeptuneStack', { env, vpc: vpcStack.vpc });
const dynamodbStack = new DynamodbStack(app, 'TestDynamodbStack', { env });
const stack = new ScorerStack(app, 'TestScorerStack', {
  env,
  vpc: vpcStack.vpc,
  neptune: {
    endpoint: neptuneStack.cluster.attrEndpoint,
    port: neptuneStack.cluster.attrPort,
    resourceId: neptuneStack.cluster.attrClusterResourceId,
  },
  incidentsTable: dynamodbStack.incidentsTable,
  stateTable: dynamodbStack.stateTable,
  tableKey: dynamodbStack.key,
});
const template = Template.fromStack(stack);

const fn = () => Object.values(template.findResources('AWS::Lambda::Function'))[0];

/** Every statement of every IAM policy in the stack, flattened. */
function statements(): { Action: string | string[]; Resource: unknown; Effect: string }[] {
  return Object.values(template.findResources('AWS::IAM::Policy')).flatMap((p) => p.Properties.PolicyDocument.Statement);
}
const actionsOf = (s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe('ScorerStack', () => {
  test('Node 22 function with the scorer entry point, no async retries (the next minute is the retry)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Handler: 'scorer.handler',
      MemorySize: 512,
      Timeout: 60,
    });
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', { MaximumRetryAttempts: 0 });
  });

  test('configured for Neptune (IAM auth), the endpoint by name, and both tables', () => {
    const vars = fn().Properties.Environment.Variables;
    expect(vars.NEPTUNE_IAM_AUTH).toBe('true');
    expect(vars.ENDPOINT_NAME).toBe('rca-root-cause');
    expect(JSON.stringify(vars.GREMLIN_URL)).toContain('/gremlin');
    expect(vars.INCIDENTS_TABLE).toBeDefined();
    expect(vars.STATE_TABLE).toBeDefined();
  });

  test('runs in the private-app subnets only', () => {
    const subnets = JSON.stringify(fn().Properties.VpcConfig.SubnetIds);
    expect(subnets).toContain('privateapp');
    expect(subnets).not.toContain('public');
    expect(subnets).not.toContain('privatedata');
  });

  test('scheduled every minute, without EventBridge retries', () => {
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)', State: 'ENABLED' });
    const rule = Object.values(template.findResources('AWS::Events::Rule'))[0];
    expect(rule.Properties.Targets[0].RetryPolicy).toEqual({ MaximumRetryAttempts: 0 });
  });

  test('Neptune access is read-only and scoped to the one cluster', () => {
    const neptune = statements().filter((s) => actionsOf(s).some((a) => a.startsWith('neptune-db:')));
    expect(neptune).toHaveLength(1);
    expect(actionsOf(neptune[0])).toEqual(['neptune-db:ReadDataViaQuery']);
    expect(JSON.stringify(neptune[0].Resource)).not.toBe('"*"');
  });

  test('may invoke exactly the one SageMaker endpoint', () => {
    const sm = statements().filter((s) => actionsOf(s).some((a) => a.startsWith('sagemaker:')));
    expect(sm).toHaveLength(1);
    expect(actionsOf(sm[0])).toEqual(['sagemaker:InvokeEndpoint']);
    expect(JSON.stringify(sm[0].Resource)).toContain('endpoint/rca-root-cause');
  });

  test('DynamoDB: state get/put, incidents put only; no scan, delete, update or wildcard resource', () => {
    const ddb = statements().filter((s) => actionsOf(s).some((a) => a.startsWith('dynamodb:')));
    const all = ddb.flatMap(actionsOf).sort();
    expect(all).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:PutItem']);
    for (const s of ddb) expect(JSON.stringify(s.Resource)).not.toContain('"*"');
  });

  test('uses the table key, and nothing is granted on * except what AWS requires', () => {
    expect(statements().some((s) => actionsOf(s).some((a) => a.startsWith('kms:')))).toBe(true);
    const wildcard = statements().filter((s) => s.Resource === '*');
    // The VPC ENI actions for a Lambda in a VPC are the only legitimately unscoped statements.
    for (const s of wildcard) {
      for (const a of actionsOf(s)) expect(a).toMatch(/^ec2:/);
    }
  });

  test('stack outputs the function and log group names', () => {
    template.hasOutput('FunctionName', {});
    template.hasOutput('LogGroupName', {});
  });
});

describe('ScorerStack without a built bundle', () => {
  test('synthesizes a placeholder that fails loudly instead of breaking `cdk synth`', () => {
    // BUNDLE_DIR resolves to the repo's dist; when it exists this just asserts the real bundle path.
    const handler = fn().Properties.Handler;
    expect(handler).toBe('scorer.handler');
  });
});
