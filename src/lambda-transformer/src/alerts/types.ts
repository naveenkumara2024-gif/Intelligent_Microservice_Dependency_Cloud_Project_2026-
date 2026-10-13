// Shapes shared by the alert modules (prompt/stage-12-sns-alerting.md).

export const ALERT_SCHEMA_VERSION = 1;

export type AlertEventType = 'incident.opened' | 'incident.resolved';
export type AlertSeverity = 'error' | 'critical';

export interface AlertEvidence {
  own_delta: number;
  window_avg_ms: number;
  baseline_ms: number;
  calls: number;
}

/** The flattened incident summary every channel renders from. */
export interface AlertIncident {
  incident_id: string;
  status: 'OPEN' | 'RESOLVED';
  root_cause: string;
  severity: AlertSeverity;
  score: number;
  peak_score: number;
  blast_radius: string[];
  at_risk: string[];
  top_candidates: { name: string; score: number }[];
  evidence: Record<string, AlertEvidence>;
  opened_at_ms: number;
  resolved_at_ms: number | null;
  windows: number;
  model_version: string;
}

/** The message published to SNS (contract v1, pinned by test/fixtures/alert-event.json). */
export interface AlertEvent {
  schema_version: typeof ALERT_SCHEMA_VERSION;
  event: AlertEventType;
  occurred_at_ms: number;
  incident: AlertIncident;
}

// --- Lambda event shapes, minimal on purpose (no @types/aws-lambda dependency) ---------------

/** DynamoDB-JSON attribute value, as it appears in a stream record image. */
export interface DdbAttr {
  S?: string;
  N?: string;
  BOOL?: boolean;
  NULL?: boolean;
  L?: DdbAttr[];
  M?: Record<string, DdbAttr>;
  SS?: string[];
  NS?: string[];
}

export interface StreamRecord {
  eventID?: string;
  eventName?: string;
  dynamodb?: {
    SequenceNumber?: string;
    NewImage?: Record<string, DdbAttr>;
    OldImage?: Record<string, DdbAttr>;
  };
}

export interface StreamEvent {
  Records: StreamRecord[];
}

/** Response for an event source mapping with ReportBatchItemFailures. */
export interface StreamBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

export interface SnsEvent {
  Records: { Sns: { Message: string; MessageId?: string } }[];
}
