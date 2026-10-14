// The dashboard API contract (v1). Mirrors src/lambda-transformer/src/api/types.ts; test/contract.test.ts
// reads the Lambda tests' golden files and checks they satisfy these shapes, so the two cannot drift.

export type NodeStatus = 'healthy' | 'root_cause' | 'affected' | 'at_risk';

export interface TopologyNode {
  id: string;
  calls_as_caller: number;
  calls_as_callee: number;
  baseline_ms: number | null;
  status: NodeStatus;
  incident_id: string | null;
}

export interface TopologyEdge {
  source: string;
  target: string;
  call_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number | null;
}

export interface TopologyResponse {
  schema_version: 1;
  generated_at_ms: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  truncated: boolean;
  open_incidents: string[];
}

export interface Evidence {
  own_delta: number;
  window_avg_ms: number;
  baseline_ms: number;
  calls: number;
}

export interface Incident {
  incident_id: string;
  status: 'OPEN' | 'RESOLVED';
  root_cause: string;
  severity: 'error' | 'critical';
  score: number;
  peak_score: number;
  blast_radius: string[];
  at_risk: string[];
  top_candidates: { name: string; score: number }[];
  evidence: Record<string, Evidence>;
  opened_at_ms: number;
  last_seen_ms: number;
  resolved_at_ms: number | null;
  windows: number;
  model_version: string;
}

export interface IncidentList {
  incidents: Incident[];
  count: number;
}
