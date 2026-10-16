// Turns one DynamoDB stream record of rca-incidents into an alert, or says why it is not one.
//
// The rule (prompt/stage-12-sns-alerting.md, decision 2) is exactly two transitions:
//   INSERT with status OPEN                       -> incident.opened
//   MODIFY with old status OPEN, new RESOLVED     -> incident.resolved
// Everything else is ignored: the per-minute OPEN -> OPEN rewrite, TTL's REMOVE, and anything
// that does not look like an incident. There is no event-source filter in front of this function
// (it delivered nothing in the first live run and was removed), so every stream record reaches it
// and this function alone decides.
import { severityOf } from './config';
import {
  ALERT_SCHEMA_VERSION,
  AlertEvent,
  AlertEvidence,
  AlertIncident,
  DdbAttr,
  StreamRecord,
} from './types';

export type Classification = { kind: 'alert'; event: AlertEvent } | { kind: 'ignored'; reason: string };

/** DynamoDB-JSON -> plain value. Numbers become `number`; sets become arrays. */
export function unmarshall(attr: DdbAttr | undefined): unknown {
  if (!attr) return undefined;
  if (attr.S !== undefined) return attr.S;
  if (attr.N !== undefined) return Number(attr.N);
  if (attr.BOOL !== undefined) return attr.BOOL;
  if (attr.NULL) return null;
  if (attr.L) return attr.L.map(unmarshall);
  if (attr.M) return unmarshallMap(attr.M);
  if (attr.SS) return [...attr.SS];
  if (attr.NS) return attr.NS.map(Number);
  return undefined;
}

export function unmarshallMap(image: Record<string, DdbAttr>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(image).map(([k, v]) => [k, unmarshall(v)]));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asNumber = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function normalizeEvidence(v: unknown): Record<string, AlertEvidence> {
  if (!isObject(v)) return {};
  const out: Record<string, AlertEvidence> = {};
  for (const [name, e] of Object.entries(v)) {
    if (!isObject(e)) continue;
    out[name] = {
      own_delta: asNumber(e.own_delta),
      window_avg_ms: asNumber(e.window_avg_ms),
      baseline_ms: asNumber(e.baseline_ms),
      calls: asNumber(e.calls),
    };
  }
  return out;
}

function normalizeCandidates(v: unknown): { name: string; score: number }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c) => (isObject(c) && typeof c.name === 'string' ? [{ name: c.name, score: asNumber(c.score) }] : []));
}

/** Plain incident item -> the summary the channels render; undefined when it is not an incident. */
export function toIncident(item: Record<string, unknown>): AlertIncident | undefined {
  const status = item.status;
  const id = asString(item.incident_id);
  const rootCause = asString(item.root_cause);
  if ((status !== 'OPEN' && status !== 'RESOLVED') || !id || !rootCause) return undefined;
  const blast = asStrings(item.blast_radius);
  return {
    incident_id: id,
    status,
    root_cause: rootCause,
    severity: severityOf(blast),
    score: asNumber(item.score),
    peak_score: asNumber(item.peak_score, asNumber(item.score)),
    blast_radius: blast,
    at_risk: asStrings(item.at_risk),
    top_candidates: normalizeCandidates(item.ranking),
    evidence: normalizeEvidence(item.evidence),
    opened_at_ms: asNumber(item.opened_at_ms),
    resolved_at_ms: typeof item.resolved_at_ms === 'number' ? item.resolved_at_ms : null,
    windows: asNumber(item.windows),
    model_version: asString(item.model_version),
  };
}

export function classify(record: StreamRecord): Classification {
  const name = record.eventName;
  if (name !== 'INSERT' && name !== 'MODIFY') return { kind: 'ignored', reason: `event-${name ?? 'missing'}` };

  const newImage = record.dynamodb?.NewImage;
  if (!newImage) return { kind: 'ignored', reason: 'no-new-image' };
  const next = toIncident(unmarshallMap(newImage));
  if (!next) return { kind: 'ignored', reason: 'malformed-incident' };

  if (name === 'INSERT') {
    if (next.status !== 'OPEN') return { kind: 'ignored', reason: 'insert-not-open' };
    return { kind: 'alert', event: build('incident.opened', next, next.opened_at_ms) };
  }

  // MODIFY: only the OPEN -> RESOLVED transition. The old image must say OPEN, so a duplicate
  // delivery of a RESOLVED -> RESOLVED rewrite never alerts twice.
  const oldImage = record.dynamodb?.OldImage;
  const previous = oldImage ? unmarshallMap(oldImage).status : undefined;
  if (previous !== 'OPEN' || next.status !== 'RESOLVED') return { kind: 'ignored', reason: 'modify-not-resolution' };
  // The scorer always stamps resolved_at_ms; the fallback only keeps the event deterministic.
  return { kind: 'alert', event: build('incident.resolved', next, next.resolved_at_ms ?? next.opened_at_ms) };
}

function build(event: AlertEvent['event'], incident: AlertIncident, occurredAtMs: number): AlertEvent {
  return { schema_version: ALERT_SCHEMA_VERSION, event, occurred_at_ms: occurredAtMs, incident };
}
