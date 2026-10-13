// Pure logic for the Stage 12 live check (verify-alerts.ts): no AWS here, unit-tested in
// test/alerts-live.test.ts. The script feeds it CloudWatch Logs output.
import { TTL_ATTR } from '../../src/lambda-transformer/src/scorer/schema';

export type Lifecycle = 'open' | 'update' | 'resolve';

export interface AlertLogLine {
  /** e.g. `published`, `sent`, `skipped`, `publish_failed`, `batch` (the part after `alert.`). */
  name: string;
  fields: Record<string, any>;
}

/** The Lambdas log `alert.<name> {json}`; Lambda prefixes the line with a timestamp and request id. */
export function parseAlertLog(message: string): AlertLogLine | undefined {
  const match = /alert\.([a-z_]+) (\{.*\})/s.exec(message);
  if (!match) return undefined;
  try {
    return { name: match[1], fields: JSON.parse(match[2]) };
  } catch {
    return undefined;
  }
}

/** The `event` values (incident.opened / incident.resolved) logged under `names` for one incident. */
export function eventsFor(lines: AlertLogLine[], names: string[], incidentId: string): string[] {
  return lines
    .filter((l) => names.includes(l.name) && l.fields.incident_id === incidentId)
    .map((l) => String(l.fields.event));
}

export function tally(events: string[]): { opened: number; resolved: number } {
  return {
    opened: events.filter((e) => e === 'incident.opened').length,
    resolved: events.filter((e) => e === 'incident.resolved').length,
  };
}

/**
 * A production-shaped incident record (scorer/types.ts IncidentRecord) for one lifecycle step.
 * `open` is the first insert; `update` is the per-window OPEN -> OPEN rewrite; `resolve` is the
 * RESOLVED rewrite. The blast radius is non-empty so the severity is `critical`, which the check
 * asserts end to end.
 */
export function incidentItem(runId: string, step: Lifecycle, nowMs: number, openedAtMs: number): Record<string, unknown> {
  const service = `${runId}-svc`;
  const base = {
    schema_version: 1,
    incident_id: `${openedAtMs}-${service}`,
    status: step === 'resolve' ? 'RESOLVED' : 'OPEN',
    root_cause: service,
    opened_at_ms: openedAtMs,
    last_seen_ms: nowMs,
    score: 0.97,
    peak_score: step === 'open' ? 0.97 : 0.99,
    ranking: [
      { name: service, score: 0.97 },
      { name: `${runId}-other`, score: 0.02 },
    ],
    blast_radius: [`${runId}-downstream`],
    at_risk: [`${runId}-downstream`, `${runId}-frontend`],
    evidence: {
      [service]: { own_delta: 4.2, window_avg_ms: 12.5, baseline_ms: 2.4, calls: 90 },
      [`${runId}-downstream`]: { own_delta: 1.3, window_avg_ms: 6.9, baseline_ms: 3, calls: 70 },
    },
    windows: step === 'open' ? 2 : step === 'update' ? 3 : 6,
    model_version: 'verify-alerts',
    [TTL_ATTR]: Math.floor(nowMs / 1000) + 3600,
  };
  return step === 'resolve' ? { ...base, resolved_at_ms: nowMs } : base;
}

export const incidentIdOf = (item: Record<string, unknown>): string => String(item.incident_id);
