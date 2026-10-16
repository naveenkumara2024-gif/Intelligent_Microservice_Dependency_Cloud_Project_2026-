import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as destinations from 'aws-cdk-lib/aws-lambda-destinations';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { BUNDLE_DIR } from './lambda-bundle';
// Names are constants shared with the Lambda code (no imports), so what the stack grants and what
// the functions read cannot disagree.
import {
  ALERT_DLQ_NAME,
  ALERT_TOPIC_NAME,
  ALERTS_BUNDLE,
  HANDLER_DISPATCH,
  HANDLER_PAGERDUTY,
  HANDLER_SLACK,
  PAGERDUTY_ROUTING_KEY_PARAM,
  SLACK_WEBHOOK_PARAM,
} from '../../src/lambda-transformer/src/alerts/names';

export interface AlertingStackProps extends cdk.StackProps {
  /** Must have a stream with NEW_AND_OLD_IMAGES (DynamodbStack). */
  readonly incidentsTable: dynamodb.ITable;
  /**
   * Optional SNS email subscriptions, one per address (`-c alertEmail=a@x.com,b@y.com`, parsed by
   * `parseAlertEmails`); each recipient has to confirm their own subscription once per deploy.
   */
  readonly alertEmails?: readonly string[];
  /** Optional link rendered in messages until Stage 13 provides the dashboard (`-c dashboardUrl=...`). */
  readonly dashboardUrl?: string;
}

const EMAIL_PATTERN = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Parses the alert email setting (`-c alertEmail=`, `RCA_ALERT_EMAIL`): one address or a
 * comma-separated list. Blank entries are skipped, duplicates (ignoring case) dropped, and anything
 * that does not look like an address throws, so a typo fails before anything deploys.
 */
export function parseAlertEmails(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const address = part.trim();
    if (!address) continue;
    if (!EMAIL_PATTERN.test(address)) {
      throw new Error(`Not an email address: "${address}" (expected one address or a comma-separated list)`);
    }
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    addresses.push(address);
  }
  return addresses;
}

/**
 * Stage 12: incident alerting.
 *
 *   rca-incidents stream -> dispatcher Lambda -> SNS rca-alerts -> Slack Lambda
 *                                                               -> PagerDuty Lambda
 *                                                               -> email (optional, one or more)
 *
 * None of the Lambdas is in the VPC: they touch no private resource, and Slack / PagerDuty are on
 * the public internet, so a VPC placement would only add a NAT dependency. Channel credentials are
 * SSM SecureString parameters the operator creates by hand (CloudFormation cannot create one) and
 * the stack never holds a value. Everything is removed with the stack; the parameters are not
 * stack resources and survive it deliberately.
 */
export class AlertingStack extends cdk.Stack {
  public readonly topic: sns.Topic;
  public readonly deadLetterQueue: sqs.Queue;
  public readonly dispatcher: lambda.Function;
  public readonly slack: lambda.Function;
  public readonly pagerduty: lambda.Function;

  constructor(scope: Construct, id: string, props: AlertingStackProps) {
    super(scope, id, props);

    const streamArn = props.incidentsTable.tableStreamArn;
    if (!streamArn) throw new Error('AlertingStack needs an incidents table with a stream (DynamodbStack)');

    const bundled = fs.existsSync(path.join(BUNDLE_DIR, ALERTS_BUNDLE));
    if (!bundled) {
      cdk.Annotations.of(this).addWarning(
        `Alerts bundle not found at ${path.join(BUNDLE_DIR, ALERTS_BUNDLE)}; run \`npm run build\` in src/lambda-transformer before deploying.`,
      );
    }
    const code = bundled
      ? lambda.Code.fromAsset(BUNDLE_DIR)
      : lambda.Code.fromInline('exports.handler = async () => { throw new Error("alerts bundle not built"); };');

    // --- Topic, key, dead-letter queue ---------------------------------------------------------
    const key = new kms.Key(this, 'TopicKey', {
      description: 'RCA alert topic',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.topic = new sns.Topic(this, 'Topic', { topicName: ALERT_TOPIC_NAME, masterKey: key });

    // One queue for everything that could not be delivered: stream batches the dispatcher gave up
    // on, SNS deliveries that failed, and notifier invocations that exhausted their retries.
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: ALERT_DLQ_NAME,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new cloudwatch.Alarm(this, 'DeadLetterAlarm', {
      alarmName: `${ALERT_DLQ_NAME}-not-empty`,
      alarmDescription: 'An incident alert could not be delivered (see the dead-letter queue).',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}LogGroup`, {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    const common = { runtime: lambda.Runtime.NODEJS_22_X, code, memorySize: 256 } as const;
    // SNS invokes the notifiers asynchronously: two retries, then the dead-letter queue.
    const asyncFailure = {
      retryAttempts: 2,
      onFailure: new destinations.SqsDestination(this.deadLetterQueue),
    } as const;

    // --- Dispatcher: stream -> SNS -------------------------------------------------------------
    this.dispatcher = new lambda.Function(this, 'Dispatcher', {
      ...common,
      handler: HANDLER_DISPATCH,
      timeout: cdk.Duration.seconds(30),
      logGroup: logGroup('Dispatcher'),
      // Retries and the failure destination for stream invocations live on the mapping below.
      environment: { TOPIC_ARN: this.topic.topicArn, ...(props.dashboardUrl ? { DASHBOARD_URL: props.dashboardUrl } : {}) },
    });
    this.topic.grantPublish(this.dispatcher);
    // Publishing to a CMK-encrypted topic needs these two on the key.
    key.grant(this.dispatcher, 'kms:GenerateDataKey*', 'kms:Decrypt');

    // Stream read, written out (not table.grantStreamRead) so the statements are exactly these.
    // First live run (2026-10-13): the mapping was Enabled, the stream held the records (verified
    // with dynamodbstreams get-records), yet the dispatcher saw zero invocations. The key grant
    // below is the plan's pre-registered fallback for that ("Known unknowns"): CDK's own
    // grantStreamRead adds the same two key actions for a CMK-encrypted table.
    this.dispatcher.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator'],
        resources: [streamArn],
      }),
    );
    // Listing streams has no resource-level scope (AWS-managed Lambda DynamoDB policy does the same).
    this.dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:ListStreams'], resources: ['*'] }));
    // Read-only use of the incidents table's own key (DynamodbStack), for the stream records.
    props.incidentsTable.encryptionKey?.grant(this.dispatcher, 'kms:Decrypt', 'kms:DescribeKey');

    new lambda.EventSourceMapping(this, 'IncidentStream', {
      target: this.dispatcher,
      eventSourceArn: streamArn,
      startingPosition: lambda.StartingPosition.LATEST,
      batchSize: 10,
      // Report the failing record only: Lambda retries from it, earlier records are not re-sent.
      reportBatchItemFailures: true,
      bisectBatchOnError: true,
      retryAttempts: 3,
      maxRecordAge: cdk.Duration.hours(1),
      onFailure: new eventSources.SqsDlq(this.deadLetterQueue),
      // No event filter: the classifier in code is the source of truth, and the filter was only an
      // optimization (it would skip the scorer's per-minute OPEN -> OPEN rewrite, ~60 trivial
      // invocations an hour while an incident is open). The first live run delivered nothing with
      // the filter in place and the cause was not isolated, so the filter is gone rather than
      // trusted; reintroduce it only with a live test that proves the patterns match.
    });

    // --- Notifiers: SNS -> Slack / PagerDuty ---------------------------------------------------
    const notifierEnv: Record<string, string> = props.dashboardUrl ? { DASHBOARD_URL: props.dashboardUrl } : {};
    this.slack = new lambda.Function(this, 'Slack', {
      ...common,
      ...asyncFailure,
      handler: HANDLER_SLACK,
      timeout: cdk.Duration.seconds(20),
      logGroup: logGroup('Slack'),
      environment: { SLACK_WEBHOOK_PARAM, ...notifierEnv },
    });
    this.pagerduty = new lambda.Function(this, 'PagerDuty', {
      ...common,
      ...asyncFailure,
      handler: HANDLER_PAGERDUTY,
      timeout: cdk.Duration.seconds(20),
      logGroup: logGroup('PagerDuty'),
      environment: { PAGERDUTY_ROUTING_KEY_PARAM, ...notifierEnv },
    });

    for (const [fn, parameter] of [
      [this.slack, SLACK_WEBHOOK_PARAM],
      [this.pagerduty, PAGERDUTY_ROUTING_KEY_PARAM],
    ] as const) {
      // Exactly one parameter each. Decryption goes through the AWS-managed SSM key, and only via SSM.
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ssm:GetParameter'],
          resources: [
            this.formatArn({
              service: 'ssm',
              resource: 'parameter',
              resourceName: parameter.replace(/^\//, ''),
              arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
            }),
          ],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['kms:Decrypt'],
          resources: [this.formatArn({ service: 'kms', resource: 'key', resourceName: '*', arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME })],
          conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
        }),
      );
      this.topic.addSubscription(new subscriptions.LambdaSubscription(fn, { deadLetterQueue: this.deadLetterQueue }));
    }

    // The subscription's construct id is the address itself, so a single address synthesizes exactly
    // as before multiple addresses were supported, and reordering the list replaces nothing.
    for (const address of props.alertEmails ?? []) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(address));
    }

    new cdk.CfnOutput(this, 'TopicArn', { value: this.topic.topicArn });
    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', { value: this.deadLetterQueue.queueUrl });
    new cdk.CfnOutput(this, 'DispatcherFunctionName', { value: this.dispatcher.functionName });
    new cdk.CfnOutput(this, 'SlackFunctionName', { value: this.slack.functionName });
    new cdk.CfnOutput(this, 'PagerDutyFunctionName', { value: this.pagerduty.functionName });
  }
}
