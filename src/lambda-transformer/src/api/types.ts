// Response shapes of the dashboard API (contract v1, prompt/stage-13-dashboard-api.md).
// Pinned by test/fixtures/api-topology.json and api-incidents.json, which the dashboard's own
// tests read, so a field rename fails in CI on one side or the other.

export const API_SCHEMA_VERSION = 1;

/** Precedence when several incidents touch one service: root_cause > affected > at_risk > healthy. */
export type NodeStatus = 'healthy' | 'root_cause' | 'affected' | 'at_risk';

export interface TopologyNode {
  id: string;
  calls_as_caller: number;
  calls_as_callee: number;
  /** The scorer's EWMA latency baseline for this service, or null before it has one. */
  baseline_ms: number | null;
  status: NodeStatus;
  /** The incident that decided `status` (null when healthy). */
  incident_id: string | null;
}

export interface TopologyEdge {
  source: string;
  target: string;
  call_count: number;
  /** Lifetime average (latency_sum / call_count): Neptune stores monotonic counters only. */
  avg_latency_ms: number;
  p95_latency_ms: number | null;
}

export interface TopologyResponse {
  schema_version: typeof API_SCHEMA_VERSION;
  generated_at_ms: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** True when the edge list was cut at the response limit (busiest edges are kept). */
  truncated: boolean;
  open_incidents: string[];
}

export interface IncidentView {
  incident_id: string;
  status: 'OPEN' | 'RESOLVED';
  root_cause: string;
  severity: 'error' | 'critical';
  score: number;
  peak_score: number;
  blast_radius: string[];
  at_risk: string[];
  top_candidates: { name: string; score: number }[];
  evidence: Record<string, { own_delta: number; window_avg_ms: number; baseline_ms: number; calls: number }>;
  opened_at_ms: number;
  last_seen_ms: number;
  resolved_at_ms: number | null;
  windows: number;
  model_version: string;
}

export interface IncidentListResponse {
  incidents: IncidentView[];
  count: number;
}

export interface ErrorResponse {
  error: string;
}

// --- API Gateway HTTP API payload format 2.0 (the fields this API reads) -----------------------

export interface HttpApiEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined> | null;
  pathParameters?: Record<string, string | undefined> | null;
  requestContext?: { http?: { method?: string } };
}

export interface HttpApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
