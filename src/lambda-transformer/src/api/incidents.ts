// Incident reads for the dashboard: validated queries over the Stage 11 readers.
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { severityOf } from '../alerts/config';
import { getIncident, listIncidents, TableNames } from '../scorer/store';
import { IncidentRecord } from '../scorer/types';
import { IncidentListResponse, IncidentView } from './types';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Incident ids are `<firstHitMs>-<service>`; service names are k8s-style or anonymized hashes. */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const SERVICE_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export class BadRequest extends Error {}

export interface ListQuery {
  status?: 'OPEN' | 'RESOLVED';
  service?: string;
  limit: number;
}

export function parseListQuery(params: Record<string, string | undefined> | null | undefined): ListQuery {
  const q = params ?? {};
  let status: ListQuery['status'];
  if (q.status !== undefined && q.status !== '') {
    const s = q.status.toUpperCase();
    if (s !== 'OPEN' && s !== 'RESOLVED') throw new BadRequest('status must be OPEN or RESOLVED');
    status = s;
  }
  let service: string | undefined;
  if (q.service !== undefined && q.service !== '') {
    if (!SERVICE_PATTERN.test(q.service)) throw new BadRequest('service has invalid characters');
    service = q.service;
  }
  let limit = DEFAULT_LIMIT;
  if (q.limit !== undefined && q.limit !== '') {
    if (!/^\d{1,4}$/.test(q.limit)) throw new BadRequest('limit must be a positive integer');
    limit = Number(q.limit);
    if (limit < 1 || limit > MAX_LIMIT) throw new BadRequest(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  // Nothing given means "what is going on now".
  if (!status && !service) status = 'OPEN';
  return { status, service, limit };
}

/** The persisted record, reduced to what a client needs (no TTL or schema bookkeeping). */
export function toView(record: IncidentRecord): IncidentView {
  return {
    incident_id: record.incident_id,
    status: record.status,
    root_cause: record.root_cause,
    severity: severityOf(record.blast_radius ?? []),
    score: record.score,
    peak_score: record.peak_score,
    blast_radius: record.blast_radius ?? [],
    at_risk: record.at_risk ?? [],
    top_candidates: (record.ranking ?? []).map((r) => ({ name: r.name, score: r.score })),
    evidence: record.evidence ?? {},
    opened_at_ms: record.opened_at_ms,
    last_seen_ms: record.last_seen_ms,
    resolved_at_ms: record.resolved_at_ms ?? null,
    windows: record.windows,
    model_version: record.model_version,
  };
}

export async function listIncidentViews(
  doc: DynamoDBDocumentClient,
  query: ListQuery,
  tables?: TableNames,
  nowMs?: number,
): Promise<IncidentListResponse> {
  // One index per query: by service when a service is named (status then narrows it), else by status.
  const records = query.service
    ? await listIncidents(doc, { rootCause: query.service, limit: query.limit, nowMs }, tables)
    : await listIncidents(doc, { status: query.status, limit: query.limit, nowMs }, tables);
  const filtered = query.service && query.status ? records.filter((r) => r.status === query.status) : records;
  const incidents = filtered.map(toView);
  return { incidents, count: incidents.length };
}

export async function getIncidentView(
  doc: DynamoDBDocumentClient,
  id: string,
  tables?: TableNames,
  nowMs: number = Date.now(),
): Promise<IncidentView | undefined> {
  if (!ID_PATTERN.test(id)) throw new BadRequest('invalid incident id');
  const record = await getIncident(doc, id, tables);
  // TTL deletion is lazy (up to 48 h): an expired item is not an incident anymore.
  if (!record || record.expires_at <= Math.floor(nowMs / 1000)) return undefined;
  return toView(record);
}
