import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AlertingStack, parseAlertEmails } from '../lib/alerting-stack';
import { DynamodbStack } from '../lib/dynamodb-stack';
import {
  ALERT_DLQ_NAME,
  ALERT_TOPIC_NAME,
  HANDLER_DISPATCH,
  HANDLER_PAGERDUTY,
  HANDLER_SLACK,
  PAGERDUTY_ROUTING_KEY_PARAM,
  SLACK_WEBHOOK_PARAM,
} from '../../src/lambda-transformer/src/alerts/names';

const env = { account: '111122223333', region: 'us-east-1' };

function build(props: { alertEmails?: string[]; dashboardUrl?: string } = {}) {
  const app = new cdk.App();
  const dynamodbStack = new DynamodbStack(app, 'TestDynamodbStack', { env });
  const stack = new AlertingStack(app, 'TestAlertingStack', { env, incidentsTable: dynamodbStack.incidentsTable, ...props });
  return { dynamodbStack, stack, template: Template.fromStack(stack) };
}

const { template } = build();

const functions = () => Object.values(template.findResources('AWS::Lambda::Function'));
const byHandler = (handler: string) => functions().find((f) => f.Properties.Handler === handler)!;

/** Statements of the IAM policy attached to the role of the function with this handler. */
function statementsFor(handler: string) {
  const fn = byHandler(handler);
  const roleRef = fn.Properties.Role['Fn::GetAtt'][0] as string;
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p) => (p.Properties.Roles as { Ref: string }[]).some((r) => r.Ref === roleRef))
    .flatMap((p) => p.Properties.PolicyDocument.Statement) as { Action: string | string[]; Resource: unknown; Condition?: unknown }[];
}
const actionsOf = (s: { Action: string | string[] }) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe('AlertingStack: functions', () => {
  test('three Node 22 functions, one per handler, none in a VPC', () => {
    expect(functions()).toHaveLength(3);
    expect(functions().map((f) => f.Properties.Handler).sort()).toEqual([HANDLER_DISPATCH, HANDLER_PAGERDUTY, HANDLER_SLACK].sort());
    for (const f of functions()) {
      expect(f.Properties.Runtime).toBe('nodejs22.x');
      expect(f.Properties.VpcConfig).toBeUndefined();
    }
  });

  test('the handler names are the ones the bundle exports', () => {
    expect([HANDLER_DISPATCH, HANDLER_SLACK, HANDLER_PAGERDUTY]).toEqual(['alerts.dispatch', 'alerts.slack', 'alerts.pagerduty']);
  });

  test('the dispatcher knows its topic; the notifiers know their parameter names, never a value', () => {
    expect(JSON.stringify(byHandler(HANDLER_DISPATCH).Properties.Environment.Variables.TOPIC_ARN)).toContain('Topic');
    expect(byHandler(HANDLER_SLACK).Properties.Environment.Variables).toEqual({ SLACK_WEBHOOK_PARAM });
    expect(byHandler(HANDLER_PAGERDUTY).Properties.Environment.Variables).toEqual({ PAGERDUTY_ROUTING_KEY_PARAM });
  });

  test('notifiers retry asynchronous failures twice, then the dead-letter queue; the dispatcher has no async config', () => {
    const configs = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'));
    expect(configs).toHaveLength(2);
    for (const c of configs) {
      expect(c.Properties.MaximumRetryAttempts).toBe(2);
      expect(c.Properties.DestinationConfig.OnFailure.Destination).toBeDefined();
    }
  });

  test('log groups are owned by the stack and removed with it', () => {
    const groups = Object.values(template.findResources('AWS::Logs::LogGroup'));
    expect(groups).toHaveLength(3);
    for (const g of groups) {
      expect(g.DeletionPolicy).toBe('Delete');
      expect(g.Properties.RetentionInDays).toBe(7);
    }
  });
});

describe('AlertingStack: stream trigger', () => {
  test('mapping reports item failures, bisects, retries 3 times for at most an hour, then dead-letters', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BisectBatchOnFunctionError: true,
      MaximumRetryAttempts: 3,
      MaximumRecordAgeInSeconds: 3600,
      BatchSize: 10,
      StartingPosition: 'LATEST',
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
    });
  });

  test('no event filter: the code classifier decides (a filter delivered nothing in the first live run)', () => {
    const mapping = Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))[0];
    expect(mapping.Properties.FilterCriteria).toBeUndefined();
  });

  test('the dispatcher reads the incidents stream and can do little else', () => {
    const statements = statementsFor(HANDLER_DISPATCH);
    const all = statements.flatMap(actionsOf).sort();
    expect(all).toEqual(
      [
        'dynamodb:DescribeStream',
        'dynamodb:GetRecords',
        'dynamodb:GetShardIterator',
        'dynamodb:ListStreams',
        'kms:Decrypt',
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:GenerateDataKey*',
        'sns:Publish',
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:SendMessage',
      ].sort(),
    );
    // No table data access of any kind (the dispatcher works from the stream record alone).
    expect(all.filter((a) => /^dynamodb:(Get|Put|Query|Scan|Update|Delete|Batch)Item|^dynamodb:(Query|Scan)$/.test(a))).toEqual([]);
    // Only ListStreams is unscoped (it has no resource-level permission).
    for (const s of statements) {
      if (s.Resource === '*') expect(actionsOf(s)).toEqual(['dynamodb:ListStreams']);
    }
  });

  test('key use is read-only: Decrypt/DescribeKey on the table key, publish-side actions on the topic key only', () => {
    const keyStatements = statementsFor(HANDLER_DISPATCH).filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
    const onTableKey = keyStatements.filter((s) => JSON.stringify(s.Resource).includes('TableKey'));
    const onTopicKey = keyStatements.filter((s) => JSON.stringify(s.Resource).includes('TopicKey'));
    expect(onTableKey).toHaveLength(1);
    expect(actionsOf(onTableKey[0]).sort()).toEqual(['kms:Decrypt', 'kms:DescribeKey']);
    expect(onTopicKey).toHaveLength(1);
    expect(actionsOf(onTopicKey[0]).sort()).toEqual(['kms:Decrypt', 'kms:GenerateDataKey*']);
    // nothing on any other key, and no write-side key action on the table key
    expect(keyStatements).toHaveLength(2);
  });
});

describe('AlertingStack: topic and subscribers', () => {
  test('topic is named, encrypted with a rotating customer-managed key owned by this stack', () => {
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: ALERT_TOPIC_NAME, KmsMasterKeyId: Match.anyValue() });
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    for (const k of Object.values(template.findResources('AWS::KMS::Key'))) expect(k.DeletionPolicy).toBe('Delete');
  });

  test('Slack and PagerDuty are subscribed, each with a dead-letter queue; no email by default', () => {
    const subs = Object.values(template.findResources('AWS::SNS::Subscription'));
    expect(subs.map((s) => s.Properties.Protocol)).toEqual(['lambda', 'lambda']);
    for (const s of subs) expect(s.Properties.RedrivePolicy).toBeDefined();
  });

  test('an email subscription exists only when an address is configured', () => {
    const withEmail = build({ alertEmails: ['oncall@example.com'] }).template;
    withEmail.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'oncall@example.com' });
    expect(Object.values(withEmail.findResources('AWS::SNS::Subscription'))).toHaveLength(3);
  });

  test('one email subscription per address; the logical id follows the address, not its position', () => {
    const emailIds = (alertEmails: string[]) => {
      const subs = build({ alertEmails }).template.findResources('AWS::SNS::Subscription', { Properties: { Protocol: 'email' } });
      return Object.fromEntries(Object.entries(subs).map(([id, s]) => [s.Properties.Endpoint, id]));
    };
    const two = emailIds(['a@example.com', 'b@example.com']);
    expect(Object.keys(two).sort()).toEqual(['a@example.com', 'b@example.com']);
    // Reordering keeps each subscription's id, so a redeploy would replace nothing.
    expect(emailIds(['b@example.com', 'a@example.com'])).toEqual(two);
    // The first address keeps the id it had when only one address was supported.
    expect(emailIds(['a@example.com'])['a@example.com']).toBe(two['a@example.com']);
  });

  test('the dashboard link reaches the functions only when configured', () => {
    const linked = build({ dashboardUrl: 'https://dash.example' }).template;
    for (const f of Object.values(linked.findResources('AWS::Lambda::Function'))) {
      expect(f.Properties.Environment.Variables.DASHBOARD_URL).toBe('https://dash.example');
    }
    for (const f of functions()) expect(f.Properties.Environment.Variables.DASHBOARD_URL).toBeUndefined();
  });
});

describe('AlertingStack: secrets', () => {
  test('creates no SSM parameter (values are entered by the operator, never in the template)', () => {
    template.resourceCountIs('AWS::SSM::Parameter', 0);
    expect(JSON.stringify(template.toJSON())).not.toMatch(/hooks\.slack\.com/);
  });

  test.each([
    [HANDLER_SLACK, SLACK_WEBHOOK_PARAM],
    [HANDLER_PAGERDUTY, PAGERDUTY_ROUTING_KEY_PARAM],
  ])('%s can read exactly its own parameter, decrypting only through SSM', (handler, parameter) => {
    const statements = statementsFor(handler);
    const ssm = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('ssm:')));
    expect(ssm).toHaveLength(1);
    expect(actionsOf(ssm[0])).toEqual(['ssm:GetParameter']);
    expect(JSON.stringify(ssm[0].Resource)).toContain(`parameter${parameter}`);

    const kmsStatements = statements.filter((s) => actionsOf(s).some((a) => a.startsWith('kms:')));
    expect(kmsStatements).toHaveLength(1);
    expect(actionsOf(kmsStatements[0])).toEqual(['kms:Decrypt']);
    expect(kmsStatements[0].Condition).toEqual({ StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' } });
  });

  test('the notifiers cannot publish, read the stream or touch the tables', () => {
    for (const handler of [HANDLER_SLACK, HANDLER_PAGERDUTY]) {
      const all = statementsFor(handler).flatMap(actionsOf);
      expect(all.filter((a) => a.startsWith('sns:') || a.startsWith('dynamodb:'))).toEqual([]);
    }
  });
});

describe('AlertingStack: dead-letter queue and teardown', () => {
  test('encrypted queue, named, with an alarm that fires on the first message', () => {
    template.hasResourceProperties('AWS::SQS::Queue', { QueueName: ALERT_DLQ_NAME, SqsManagedSseEnabled: true });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/SQS',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('queue and key are deleted with the stack', () => {
    for (const q of Object.values(template.findResources('AWS::SQS::Queue'))) expect(q.DeletionPolicy).toBe('Delete');
  });

  test('outputs the names the verify script reads', () => {
    for (const o of ['TopicArn', 'DeadLetterQueueUrl', 'DispatcherFunctionName', 'SlackFunctionName', 'PagerDutyFunctionName']) {
      template.hasOutput(o, {});
    }
  });

  test('refuses an incidents table without a stream, loudly, at synth time', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Other', { env });
    const noStream = new dynamodb.Table(stack, 'T', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
    });
    expect(() => new AlertingStack(app, 'Bad', { env, incidentsTable: noStream })).toThrow(/needs an incidents table with a stream/);
  });
});

describe('parseAlertEmails', () => {
  test('one address, a list, blanks and spaces', () => {
    expect(parseAlertEmails('oncall@example.com')).toEqual(['oncall@example.com']);
    expect(parseAlertEmails(' a@example.com , b@example.org,, ')).toEqual(['a@example.com', 'b@example.org']);
    expect(parseAlertEmails(undefined)).toEqual([]);
    expect(parseAlertEmails('')).toEqual([]);
  });

  test('duplicates are dropped ignoring case, keeping the first spelling', () => {
    expect(parseAlertEmails('A@example.com,a@example.com,b@example.com')).toEqual(['A@example.com', 'b@example.com']);
  });

  test('anything that is not an address fails loudly', () => {
    expect(() => parseAlertEmails('a@example.com;b@example.com')).toThrow(/Not an email address/);
    expect(() => parseAlertEmails('oncall')).toThrow(/"oncall"/);
    expect(() => parseAlertEmails('a@example.com b@example.com')).toThrow(/Not an email address/);
  });
});
