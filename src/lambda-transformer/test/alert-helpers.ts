// Builders for the alert tests. Stream images are produced by the same marshaller the scorer's
// DocumentClient uses (util-dynamodb), from the real IncidentRecord shape, so a drift in what the
// scorer writes shows up here rather than in a live session.
import { marshall } from '@aws-sdk/util-dynamodb';
import { AlertDeps, AlertPublisher, PublishInput } from '../src/alerts/handler';
import { SecretSource } from '../src/alerts/secrets';
import { AlertEvent, DdbAttr, SnsEvent, StreamRecord } from '../src/alerts/types';
import { IncidentRecord } from '../src/scorer/types';

export const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
/** The scorer's id format (scorer/lifecycle.ts): `${firstHitMs}-${service}`. */
export const INCIDENT_ID = `${T0}-productcatalogservice`;

export function incident(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    schema_version: 1,
    incident_id: INCIDENT_ID,
    status: 'OPEN',
    root_cause: 'productcatalogservice',
    opened_at_ms: T0,
    last_seen_ms: T0 + 60_000,
    score: 0.994,
    peak_score: 0.994,
    ranking: [
      { name: 'productcatalogservice', score: 0.994 },
      { name: 'frontend', score: 0.004 },
      { name: 'checkoutservice', score: 0.002 },
    ],
    blast_radius: [],
    at_risk: ['frontend', 'recommendationservice', 'checkoutservice'],
    evidence: {
      productcatalogservice: { own_delta: 7.2, window_avg_ms: 8.4, baseline_ms: 1.025, calls: 120 },
    },
    windows: 2,
    model_version: 'rca-gat-small-2026-10-12',
    expires_at: Math.floor(T0 / 1000) + 30 * 86_400,
    ...overrides,
  };
}

export function resolved(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  return incident({ status: 'RESOLVED', resolved_at_ms: T0 + 8 * 60_000, peak_score: 0.997, windows: 9, ...overrides });
}

const image = (rec: IncidentRecord) => marshall(rec, { removeUndefinedValues: true }) as unknown as Record<string, DdbAttr>;

let sequence = 100;

export function streamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  parts: { old?: IncidentRecord; next?: IncidentRecord },
): StreamRecord {
  return {
    eventID: `evt-${sequence}`,
    eventName,
    dynamodb: {
      SequenceNumber: String(sequence++),
      ...(parts.old ? { OldImage: image(parts.old) } : {}),
      ...(parts.next ? { NewImage: image(parts.next) } : {}),
    },
  };
}

export const opened = (rec: IncidentRecord = incident()) => streamRecord('INSERT', { next: rec });
export const updated = (rec: IncidentRecord = incident()) => streamRecord('MODIFY', { old: rec, next: { ...rec, last_seen_ms: rec.last_seen_ms + 60_000 } });
export const resolvedRecord = (rec: IncidentRecord = incident()) =>
  streamRecord('MODIFY', { old: rec, next: { ...rec, status: 'RESOLVED', resolved_at_ms: T0 + 8 * 60_000, peak_score: 0.997, windows: 9 } });

export function snsEvent(...alerts: AlertEvent[]): SnsEvent {
  return { Records: alerts.map((a, i) => ({ Sns: { Message: JSON.stringify(a), MessageId: `m-${i}` } })) };
}

export class FakePublisher implements AlertPublisher {
  published: PublishInput[] = [];
  /** Fail the nth publish (1-based) with this error. */
  failOn?: { call: number; error: Error };
  private calls = 0;

  async publish(input: PublishInput): Promise<string | undefined> {
    this.calls++;
    if (this.failOn && this.failOn.call === this.calls) throw this.failOn.error;
    this.published.push(input);
    return `msg-${this.calls}`;
  }
}

export class FakeSecrets implements SecretSource {
  reads: string[] = [];
  constructor(private readonly values: Record<string, string | undefined> = {}) {}

  async get(name: string): Promise<string | undefined> {
    this.reads.push(name);
    return this.values[name];
  }
}

export function deps(overrides: Partial<AlertDeps> = {}): AlertDeps {
  return {
    publisher: new FakePublisher(),
    secrets: new FakeSecrets(),
    topicArn: 'arn:aws:sns:us-east-1:111122223333:rca-alerts',
    slackParam: '/rca/alerts/slack-webhook-url',
    pagerDutyParam: '/rca/alerts/pagerduty-routing-key',
    pagerDutyUrl: 'https://events.pagerduty.com/v2/enqueue',
    ...overrides,
  };
}
