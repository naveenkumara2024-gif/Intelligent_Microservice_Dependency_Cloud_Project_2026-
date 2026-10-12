import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import {
  DLC_ACCOUNT,
  DLC_REPOSITORY,
  DLC_TAG,
  ENDPOINT_NAME,
  SERVERLESS_MAX_CONCURRENCY,
  SERVERLESS_MEMORY_MB,
  SagemakerStack,
} from '../lib/sagemaker-stack';

const env = { region: 'us-east-1' };

function build(artifactPath: string) {
  const app = new cdk.App();
  const stack = new SagemakerStack(app, 'TestSagemakerStack', { env, artifactPath });
  return { stack, template: Template.fromStack(stack) };
}

// A stand-in artifact: the stack only needs a file to stage as an asset.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-artifact-'));
const artifact = path.join(dir, 'model.tar.gz');
fs.writeFileSync(artifact, 'placeholder artifact bytes');

const { stack, template } = build(artifact);
const only = (type: string) => Object.values(template.findResources(type)) as any[];

describe('SagemakerStack endpoint', () => {
  test('is serverless: memory and concurrency set, and no instance type anywhere', () => {
    template.resourceCountIs('AWS::SageMaker::EndpointConfig', 1);
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      ProductionVariants: [
        Match.objectLike({
          VariantName: 'AllTraffic',
          ServerlessConfig: { MemorySizeInMB: SERVERLESS_MEMORY_MB, MaxConcurrency: SERVERLESS_MAX_CONCURRENCY },
        }),
      ],
    });
    const [config] = only('AWS::SageMaker::EndpointConfig');
    const variant = config.Properties.ProductionVariants[0];
    expect(variant.InstanceType).toBeUndefined();
    expect(variant.InitialInstanceCount).toBeUndefined();
    expect(JSON.stringify(template.toJSON())).not.toMatch(/"ml\.[a-z0-9]+\.[a-z0-9]+"/);
  });

  test('concurrency stays inside the account quota of 10 for all serverless endpoints', () => {
    expect(SERVERLESS_MAX_CONCURRENCY).toBeLessThanOrEqual(10);
    expect(SERVERLESS_MEMORY_MB).toBeGreaterThanOrEqual(1024);
    expect(SERVERLESS_MEMORY_MB).toBeLessThanOrEqual(6144);
  });

  test('has a fixed, named endpoint so the log group and verify script can find it', () => {
    template.hasResourceProperties('AWS::SageMaker::Endpoint', { EndpointName: ENDPOINT_NAME });
    template.hasOutput('EndpointName', { Value: ENDPOINT_NAME });
    template.hasOutput('EndpointArn', {});
    expect(stack.endpointName).toBe(ENDPOINT_NAME);
  });
});

describe('SagemakerStack model container', () => {
  test('uses the pinned PyTorch inference DLC and runs inference.py from the artifact', () => {
    const [model] = only('AWS::SageMaker::Model');
    const container = model.Properties.PrimaryContainer;
    expect(JSON.stringify(container.Image)).toContain(`${DLC_ACCOUNT}.dkr.ecr.us-east-1.`);
    expect(JSON.stringify(container.Image)).toContain(`${DLC_REPOSITORY}:${DLC_TAG}`);
    expect(container.Environment.SAGEMAKER_PROGRAM).toBe('inference.py');
    expect(container.ModelDataUrl).toBeDefined();
  });

  test('the image tag is not floating (no :latest)', () => {
    expect(DLC_TAG).not.toMatch(/latest/);
    expect(DLC_TAG).toMatch(/^\d+\.\d+\.\d+-cpu-py\d+-ubuntu[\d.]+-sagemaker$/);
  });
});

describe('SagemakerStack IAM', () => {
  const statements = () =>
    only('AWS::IAM::Policy').flatMap((p) => p.Properties.PolicyDocument.Statement) as any[];
  const actions = (s: any): string[] => ([] as string[]).concat(s.Action);

  test('the execution role is assumed by SageMaker only and has no managed policies', () => {
    const roles = only('AWS::IAM::Role');
    expect(roles).toHaveLength(1);
    expect(roles[0].Properties.AssumeRolePolicyDocument.Statement[0].Principal).toEqual({
      Service: 'sagemaker.amazonaws.com',
    });
    expect(roles[0].Properties.ManagedPolicyArns).toBeUndefined();
  });

  test('wildcard resources are limited to ecr:GetAuthorizationToken, which has no resource-level form', () => {
    for (const s of statements()) {
      if (JSON.stringify(s.Resource) === '"*"') {
        expect(actions(s)).toEqual(['ecr:GetAuthorizationToken']);
      }
    }
  });

  test('image pull is scoped to the single DLC repository', () => {
    const pull = statements().find((s) => actions(s).includes('ecr:BatchGetImage'));
    expect(pull).toBeDefined();
    expect(JSON.stringify(pull.Resource)).toContain(`repository/${DLC_REPOSITORY}`);
    expect(JSON.stringify(pull.Resource)).toContain(DLC_ACCOUNT);
  });

  test('grants no SageMaker, S3 write, or IAM actions', () => {
    const all = statements().flatMap(actions);
    expect(all.filter((a) => a.startsWith('sagemaker:'))).toEqual([]);
    expect(all.filter((a) => /^s3:(Put|Delete)/.test(a))).toEqual([]);
    expect(all.filter((a) => a.startsWith('iam:'))).toEqual([]);
  });

  test('log writes are limited to the endpoint log group', () => {
    const write = statements().find((s) => actions(s).includes('logs:PutLogEvents'));
    expect(write).toBeDefined();
    expect(actions(write)).not.toContain('logs:CreateLogGroup');
    expect(JSON.stringify(write.Resource)).toContain('EndpointLogGroup');
  });
});

describe('SagemakerStack teardown', () => {
  test('the endpoint log group has bounded retention and is removed with the stack', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: `/aws/sagemaker/Endpoints/${ENDPOINT_NAME}`,
      RetentionInDays: 7,
    });
    const [group] = only('AWS::Logs::LogGroup');
    expect(group.DeletionPolicy).toBe('Delete');
  });
});

describe('SagemakerStack without a built artifact', () => {
  const missing = build(path.join(dir, 'does-not-exist.tar.gz'));

  test('synthesizes to an empty stack with a warning instead of failing', () => {
    Annotations.fromStack(missing.stack).hasWarning('*', Match.stringLikeRegexp('Model artifact not found'));
    missing.template.resourceCountIs('AWS::SageMaker::Endpoint', 0);
    missing.template.resourceCountIs('AWS::SageMaker::Model', 0);
    missing.template.resourceCountIs('AWS::IAM::Role', 0);
    missing.template.hasOutput('Status', { Value: 'artifact-not-built' });
  });
});
