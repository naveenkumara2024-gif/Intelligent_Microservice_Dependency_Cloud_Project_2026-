// Topology for the dashboard: Neptune's cumulative counters plus the scorer's judgement.
//
// Neptune only stores monotonic counters, so the figures per edge are lifetime values (average =
// latency_sum / call_count, p95 from the histogram). "Which services are unhealthy right now" comes
// from the open incidents and the scorer's baselines, not from a rate computed here.
import { estimateP95 } from '../aggregate';
import { Baseline, GraphSnapshot, IncidentRecord } from '../scorer/types';
import { API_SCHEMA_VERSION, NodeStatus, TopologyEdge, TopologyNode, TopologyResponse } from './types';

/** Bounds the response (and the browser's layout work); the busiest edges are kept. */
export const MAX_EDGES = 1000;

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
): TopologyResponse {
  const sorted = [...snapshot.edges].sort((a, b) => b.calls - a.calls || a.um.localeCompare(b.um) || a.dm.localeCompare(b.dm));
  const kept = sorted.slice(0, MAX_EDGES);

  const edges: TopologyEdge[] = kept.map((e) => ({
    source: e.um,
    target: e.dm,
    call_count: e.calls,
    avg_latency_ms: e.calls > 0 ? r3(e.sumMs / e.calls) : 0,
    p95_latency_ms: estimateP95(e.hist) ?? null,
  }));

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
      };
    });

  return {
    schema_version: API_SCHEMA_VERSION,
    generated_at_ms: nowMs,
    nodes,
    edges,
    truncated: sorted.length > kept.length,
    open_incidents: incidents.filter((i) => i.status === 'OPEN').map((i) => i.incident_id),
  };
}
