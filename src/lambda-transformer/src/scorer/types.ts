// Shapes shared by the scorer's modules.

/** Cumulative counters of one CALLS edge, as the streaming transformer stores them. */
export interface EdgeCounters {
  um: string;
  dm: string;
  calls: number;
  sumMs: number;
  /** Latency histogram h0..h9 (aggregate.ts BUCKET_BOUNDS_MS). */
  hist: number[];
}

/** Cumulative counters of one service vertex. */
export interface NodeCounters {
  name: string;
  asUm: number;
  asDm: number;
}

export interface GraphSnapshot {
  nodes: NodeCounters[];
  edges: EdgeCounters[];
}

/** What one edge did between two scorer runs (differences of the cumulative counters). */
export type WindowEdge = EdgeCounters;

/** A service's own latency in a window: call-weighted over the edges into it. */
export interface ServiceObservation {
  calls: number;
  avgMs: number;
}

export interface Baseline {
  ms: number;
  /** Windows that have contributed. */
  n: number;
}

export interface ScoreRequest {
  nodes: { name: string; total_calls_as_um: number; total_calls_as_dm: number; own_delta: number }[];
  edges: {
    um: string;
    dm: string;
    avg_latency_ms: number;
    p95_latency_ms: number;
    call_count: number;
    rpctype: string;
  }[];
  top_k: number;
}

export interface ScoreResponse {
  model_version: string;
  ranking: { name: string; score: number; rank: number }[];
  scores?: Record<string, number>;
}

export interface Evidence {
  own_delta: number;
  window_avg_ms: number;
  baseline_ms: number;
  calls: number;
}

/** The persisted incident (one DynamoDB item in rca-incidents). */
export interface IncidentRecord {
  schema_version: number;
  incident_id: string;
  status: 'OPEN' | 'RESOLVED';
  root_cause: string;
  opened_at_ms: number;
  last_seen_ms: number;
  resolved_at_ms?: number;
  score: number;
  peak_score: number;
  ranking: { name: string; score: number }[];
  blast_radius: string[];
  at_risk: string[];
  evidence: Record<string, Evidence>;
  windows: number;
  model_version: string;
  /** Epoch SECONDS (DynamoDB TTL). */
  expires_at: number;
}

/** What one window says about the model's top candidate. */
export interface Implication {
  service: string;
  score: number;
  ranking: { name: string; score: number }[];
  blastRadius: string[];
  atRisk: string[];
  evidence: Record<string, Evidence>;
  modelVersion: string;
}

export interface Tracker {
  /** Consecutive implicated windows. */
  hits: number;
  /** Consecutive windows not implicated. */
  misses: number;
  firstHitMs: number;
  incident?: IncidentRecord;
}

/** Everything the scorer remembers between runs (one item in rca-scorer-state). */
export interface ScorerState {
  /** Version of the stored item this state was loaded from (0 = nothing stored yet). */
  version: number;
  windows: number;
  /** Cumulative counters at the end of the previous run. */
  counters: EdgeCounters[];
  /**
   * What each edge did in the last scored window, and how long that window was. Only the dashboard
   * reads these (api/topology.ts), to keep its "right now" figures meaningful just after a run.
   * Absent in state written before they existed, and after a first or reset window.
   */
  lastWindow?: { um: string; dm: string; calls: number; sumMs: number }[];
  lastWindowMs?: number;
  baselines: Record<string, Baseline>;
  trackers: Record<string, Tracker>;
  updatedMs: number;
}

export type Action =
  | { kind: 'open'; service: string; incident: IncidentRecord }
  | { kind: 'update'; service: string; incident: IncidentRecord }
  | { kind: 'resolve'; service: string; incident: IncidentRecord };
