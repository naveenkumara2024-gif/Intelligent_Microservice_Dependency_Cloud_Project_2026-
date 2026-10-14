// Topology for the dashboard: Neptune's cumulative counters plus the scorer's judgement.
//
// Neptune only stores monotonic counters, so `call_count` / `avg_latency_ms` / `p95_latency_ms` are
// lifetime values. A lifetime average hides a fault (a few minutes of 300 ms vanish into hours of
// 0.4 ms) and keeps showing it long after it is gone, so every edge and node also carries RECENT
// figures: Neptune now minus the counters the scorer stored at its last run (at most a minute ago).
// `status` still comes from open incidents (the model's judgement); `degraded` is the fast signal.
import { estimateP95 } from '../aggregate';
import { ownDeltas, anomalousServices, observe } from '../scorer/baseline';
import { DEFAULT_CONFIG } from '../scorer/config';
import { computeWindow } from '../scorer/window';
import { Baseline, GraphSnapshot, IncidentRecord, ScorerState, WindowEdge } from '../scorer/types';
import { API_SCHEMA_VERSION, NodeStatus, TopologyEdge, TopologyNode, TopologyResponse } from './types';

/** Bounds the response (and the browser's layout work); the busiest edges are kept. */
export const MAX_EDGES = 1000;

/** A recent window shorter than this is topped up with the scorer's last full window (less noise). */
export const MIN_RECENT_WINDOW_MS = 20_000;
/** Calls a service needs in the recent window to be judged degraded (the scorer needs 20 per minute). */
export const RECENT_MIN_CALLS = 5;

export interface RecentWindow {
  ms: number;
  edges: Map<string, { calls: number; sumMs: number }>;
}

const edgeKey = (um: string, dm: string) => `${um}\u0000${dm}`;

/**
 * Calls and latency per edge since the scorer's last snapshot, or undefined when there is no usable
 * window (the scorer has not run, or the counters went down: the graph was cleared or reloaded).
 */
export function recentWindow(snapshot: GraphSnapshot, state: ScorerState | undefined, nowMs: number): RecentWindow | undefined {
  if (!state || state.updatedMs <= 0 || state.counters.length === 0) return undefined;
  const partial = computeWindow(state.counters, snapshot.edges);
  if (partial.kind !== 'ok') return undefined;

  const edges = new Map<string, { calls: number; sumMs: number }>();
  const add = (e: Pick<WindowEdge, 'um' | 'dm' | 'calls' | 'sumMs'>) => {
    const k = edgeKey(e.um, e.dm);
    const held = edges.get(k) ?? { calls: 0, sumMs: 0 };
    edges.set(k, { calls: held.calls + e.calls, sumMs: held.sumMs + e.sumMs });
  };
  partial.edges.forEach(add);

  let ms = Math.max(0, nowMs - state.updatedMs);
  if (ms < MIN_RECENT_WINDOW_MS && state.lastWindow && state.lastWindowMs) {
    state.lastWindow.forEach(add);
    ms += state.lastWindowMs;
  }
  return { ms, edges };
}

const RANK: Record<NodeStatus, number> = { healthy: 0, at_risk: 1, affected: 2, root_cause: 3 };
const r3 = (x: number) => Math.round(x * 1000) / 1000;

interface Claim {
  status: NodeStatus;
  incidentId: string;
  openedAtMs: number;
}

/** What each open incident says about each service; the strongest (then newest) claim wins. */
function claims(incidents: IncidentRecord[]): Map<string, Claim> {
  const best = new Map<string, Claim>();
  const offer = (service: string, status: NodeStatus, incident: IncidentRecord) => {
    const claim: Claim = { status, incidentId: incident.incident_id, openedAtMs: incident.opened_at_ms };
    const held = best.get(service);
    if (!held || RANK[status] > RANK[held.status] || (RANK[status] === RANK[held.status] && claim.openedAtMs > held.openedAtMs)) {
      best.set(service, claim);
    }
  };
  for (const incident of incidents) {
    if (incident.status !== 'OPEN') continue;
    offer(incident.root_cause, 'root_cause', incident);
    for (const s of incident.blast_radius ?? []) offer(s, 'affected', incident);
    for (const s of incident.at_risk ?? []) offer(s, 'at_risk', incident);
  }
  return best;
}

export function buildTopology(
  snapshot: GraphSnapshot,
  incidents: IncidentRecord[],
  baselines: Record<string, Baseline>,
  nowMs: number,
  recent?: RecentWindow,
): TopologyResponse {
  const sorted = [...snapshot.edges].sort((a, b) => b.calls - a.calls || a.um.localeCompare(b.um) || a.dm.localeCompare(b.dm));
  const kept = sorted.slice(0, MAX_EDGES);

  const edges: TopologyEdge[] = kept.map((e) => {
    const w = recent?.edges.get(edgeKey(e.um, e.dm));
    return {
      source: e.um,
      target: e.dm,
      call_count: e.calls,
      avg_latency_ms: e.calls > 0 ? r3(e.sumMs / e.calls) : 0,
      p95_latency_ms: estimateP95(e.hist) ?? null,
      recent_calls: w?.calls ?? 0,
      recent_avg_latency_ms: w && w.calls > 0 ? r3(w.sumMs / w.calls) : null,
    };
  });

  // The scorer's rule (own latency = calls INTO a service; >= 2x its warm baseline, 1 ms floor),
  // applied to the recent window with a call minimum scaled down from its per-minute one.
  const observed = recent
    ? observe([...recent.edges.entries()].map(([k, w]) => {
        const [um, dm] = k.split('\u0000');
        return { um, dm, calls: w.calls, sumMs: w.sumMs, hist: [] };
      }))
    : {};
  const degraded = new Set(anomalousServices(ownDeltas(observed, baselines, { ...DEFAULT_CONFIG, minCalls: RECENT_MIN_CALLS }), DEFAULT_CONFIG));

  // Every vertex Neptune reports, plus any edge endpoint it does not (an edge can arrive first).
  const byName = new Map<string, { asUm: number; asDm: number }>();
  for (const n of snapshot.nodes) byName.set(n.name, { asUm: n.asUm, asDm: n.asDm });
  for (const e of kept) {
    for (const name of [e.um, e.dm]) if (!byName.has(name)) byName.set(name, { asUm: 0, asDm: 0 });
  }

  const claimed = claims(incidents);
  const nodes: TopologyNode[] = [...byName.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, c]) => {
      const claim = claimed.get(name);
      const baseline = baselines[name];
      return {
        id: name,
        calls_as_caller: c.asUm,
        calls_as_callee: c.asDm,
        baseline_ms: baseline ? r3(baseline.ms) : null,
        status: claim?.status ?? 'healthy',
        incident_id: claim?.incidentId ?? null,
        recent_avg_ms: observed[name] ? r3(observed[name].avgMs) : null,
        degraded: degraded.has(name),
      };
    });

  return {
    schema_version: API_SCHEMA_VERSION,
    generated_at_ms: nowMs,
    nodes,
    edges,
    truncated: sorted.length > kept.length,
    open_incidents: incidents.filter((i) => i.status === 'OPEN').map((i) => i.incident_id),
    recent_window_ms: recent ? recent.ms : null,
  };
}
