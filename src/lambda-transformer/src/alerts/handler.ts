// Stage 12 alert Lambdas, one bundle (dist/alerts.js) with three handlers:
//
//   alerts.dispatch   DynamoDB stream of rca-incidents -> SNS topic rca-alerts
//   alerts.slack      SNS -> Slack incoming webhook (Block Kit)
//   alerts.pagerduty  SNS -> PagerDuty Events API v2 (trigger / resolve, dedup_key = incident_id)
//
// All I/O sits behind AlertDeps so the logic runs in unit tests with fakes. Log lines are
// `<message> <json>` like the scorer's, so CloudWatch Logs Insights and verify-alerts can parse them.
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { SSMClient } from '@aws-sdk/client-ssm';
import { classify } from './classify';
import { FetchLike, postJson } from './http';
import {
  PAGERDUTY_EVENTS_URL,
  PAGERDUTY_ROUTING_KEY_PARAM,
  SLACK_WEBHOOK_PARAM,
} from './names';
import { renderPagerDuty } from './pagerduty';
import { SecretSource, SsmSecretSource } from './secrets';
import { renderSlack } from './slack';
import { LIMITS } from './config';
import { truncate } from './format';
import { ALERT_SCHEMA_VERSION, AlertEvent, SnsEvent, StreamBatchResponse, StreamEvent } from './types';

export interface PublishInput {
  topicArn: string;
  message: string;
  subject: string;
  attributes: Record<string, string>;
}

export interface AlertPublisher {
  /** Returns the SNS message id. */
  publish(input: PublishInput): Promise<string | undefined>;
}

export interface AlertDeps {
  publisher: AlertPublisher;
  secrets: SecretSource;
  topicArn?: string;
  dashboardUrl?: string;
  slackParam: string;
  pagerDutyParam: string;
  pagerDutyUrl: string;
  fetchFn?: FetchLike;
}

const log = (message: string, fields: Record<string, unknown>) => console.log(`${message} ${JSON.stringify(fields)}`);

// --- dispatch -----------------------------------------------------------------------------------

/** SNS Subject: printable ASCII only, at most 100 characters (it is also the email subject). */
export function subjectOf(event: AlertEvent): string {
  const verb = event.event === 'incident.opened' ? 'opened' : 'resolved';
  const safe = event.incident.root_cause.replace(/[^\x20-\x7e]/g, '?');
  return truncate(`[RCA] Incident ${verb}: ${safe}`, LIMITS.snsSubject);
}

export async function dispatchRecords(event: StreamEvent, deps: AlertDeps): Promise<StreamBatchResponse> {
  if (!deps.topicArn) throw new Error('TOPIC_ARN is not set');
  const ignored: Record<string, number> = {};
  const failures: StreamBatchResponse['batchItemFailures'] = [];
  let published = 0;

  // Sequential, and stop at the first failure: a shard is ordered, and reporting only that record
  // makes Lambda retry from it, so a later "resolved" can never overtake an earlier "opened".
  for (const record of event.Records ?? []) {
    const result = classify(record);
    if (result.kind === 'ignored') {
      ignored[result.reason] = (ignored[result.reason] ?? 0) + 1;
      continue;
    }
    const alert = result.event;
    try {
      const messageId = await deps.publisher.publish({
        topicArn: deps.topicArn,
        message: JSON.stringify(alert),
        subject: subjectOf(alert),
        attributes: {
          event_type: alert.event,
          severity: alert.incident.severity,
          root_cause: truncate(alert.incident.root_cause, 256),
        },
      });
      published++;
      log('alert.published', { event: alert.event, incident_id: alert.incident.incident_id, severity: alert.incident.severity, message_id: messageId });
    } catch (err) {
      const sequence = record.dynamodb?.SequenceNumber;
      log('alert.publish_failed', {
        event: alert.event,
        incident_id: alert.incident.incident_id,
        error: String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300),
      });
      // Without a sequence number the failure cannot be reported per item: fail the whole batch.
      if (!sequence) throw err;
      failures.push({ itemIdentifier: sequence });
      break;
    }
  }

  log('alert.batch', { records: event.Records?.length ?? 0, published, ignored, failed: failures.length });
  return { batchItemFailures: failures };
}

// --- notifiers ----------------------------------------------------------------------------------

/** The SNS message body, validated: a notifier must not render something it does not understand. */
export function parseAlert(message: string): AlertEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    throw new Error('alert message is not JSON');
  }
  const e = parsed as Partial<AlertEvent> | null;
  if (!e || e.schema_version !== ALERT_SCHEMA_VERSION) {
    throw new Error(`unsupported alert schema_version ${String((e as { schema_version?: unknown } | null)?.schema_version)}`);
  }
  if ((e.event !== 'incident.opened' && e.event !== 'incident.resolved') || !e.incident?.incident_id || !e.incident.root_cause) {
    throw new Error('alert message is missing event or incident fields');
  }
  return e as AlertEvent;
}

export async function notifySlack(event: SnsEvent, deps: AlertDeps): Promise<void> {
  for (const record of event.Records) {
    const alert = parseAlert(record.Sns.Message);
    const message = renderSlack(alert, { dashboardUrl: deps.dashboardUrl });
    const meta = { channel: 'slack', event: alert.event, incident_id: alert.incident.incident_id };

    const url = await deps.secrets.get(deps.slackParam);
    if (!url) {
      log('alert.skipped', { ...meta, reason: 'not-configured', parameter: deps.slackParam, rendered: message });
      continue;
    }
    const status = await postJson(url, message, { channel: 'slack', okStatuses: [200], fetchFn: deps.fetchFn });
    log('alert.sent', { ...meta, status });
  }
}

export async function notifyPagerDuty(event: SnsEvent, deps: AlertDeps): Promise<void> {
  for (const record of event.Records) {
    const alert = parseAlert(record.Sns.Message);
    const meta = { channel: 'pagerduty', event: alert.event, incident_id: alert.incident.incident_id };

    const key = await deps.secrets.get(deps.pagerDutyParam);
    if (!key) {
      // The rendered body is logged with a placeholder, never with a routing key.
      const rendered = renderPagerDuty(alert, '<routing-key-not-set>', { dashboardUrl: deps.dashboardUrl });
      log('alert.skipped', { ...meta, reason: 'not-configured', parameter: deps.pagerDutyParam, rendered });
      continue;
    }
    const body = renderPagerDuty(alert, key, { dashboardUrl: deps.dashboardUrl });
    const status = await postJson(deps.pagerDutyUrl, body, { channel: 'pagerduty', okStatuses: [202], fetchFn: deps.fetchFn });
    log('alert.sent', { ...meta, status });
  }
}

// --- Lambda wiring ------------------------------------------------------------------------------

class SnsPublisher implements AlertPublisher {
  constructor(private readonly client: SNSClient) {}

  async publish(input: PublishInput): Promise<string | undefined> {
    const res = await this.client.send(
      new PublishCommand({
        TopicArn: input.topicArn,
        Message: input.message,
        Subject: input.subject,
        MessageAttributes: Object.fromEntries(
          Object.entries(input.attributes).map(([k, v]) => [k, { DataType: 'String', StringValue: v }]),
        ),
      }),
    );
    return res.MessageId;
  }
}

let cached: AlertDeps | undefined;

export function buildDeps(env: NodeJS.ProcessEnv = process.env): AlertDeps {
  if (cached) return cached;
  cached = {
    publisher: new SnsPublisher(new SNSClient({})),
    secrets: new SsmSecretSource(new SSMClient({})),
    topicArn: env.TOPIC_ARN,
    dashboardUrl: env.DASHBOARD_URL || undefined,
    slackParam: env.SLACK_WEBHOOK_PARAM || SLACK_WEBHOOK_PARAM,
    pagerDutyParam: env.PAGERDUTY_ROUTING_KEY_PARAM || PAGERDUTY_ROUTING_KEY_PARAM,
    pagerDutyUrl: env.PAGERDUTY_EVENTS_URL || PAGERDUTY_EVENTS_URL,
  };
  return cached;
}

/** Replaces the cached dependencies (tests). */
export function setDeps(deps: AlertDeps | undefined): void {
  cached = deps;
}

export const dispatch = (event: StreamEvent) => dispatchRecords(event, buildDeps());
export const slack = (event: SnsEvent) => notifySlack(event, buildDeps());
export const pagerduty = (event: SnsEvent) => notifyPagerDuty(event, buildDeps());
