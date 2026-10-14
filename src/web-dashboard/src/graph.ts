// Pure mapping from the topology response to Cytoscape elements, and the status vocabulary.
import type { ElementDefinition } from 'cytoscape';
import { formatCount, formatMs } from './format';
import type { Incident, NodeStatus, TopologyEdge, TopologyNode, TopologyResponse } from './types';

/**
 * Status is shown by shape and border as well as colour (colour alone fails for colour-blind
 * viewers): root cause = octagon, affected = rounded box, at risk = dashed ellipse, healthy = ellipse.
 */
export const STATUS: Record<NodeStatus, { label: string; shape: string; description: string }> = {
  root_cause: { label: 'Root cause', shape: 'octagon', description: 'The model names this service as the origin of an open incident.' },
  affected: { label: 'Affected', shape: 'round-rectangle', description: 'Also degraded, inside an open incident’s blast radius.' },
  at_risk: { label: 'At risk', shape: 'ellipse', description: 'Calls a degraded service, so may soon be affected.' },
  healthy: { label: 'Healthy', shape: 'ellipse', description: 'No open incident involves this service.' },
};

export const STATUS_ORDER: NodeStatus[] = ['root_cause', 'affected', 'at_risk', 'healthy'];

/** Edge width 1.5..5 px on a square-root scale, so one busy edge does not flatten the rest. */
export function edgeWidth(callCount: number, maxCount: number): number {
  if (maxCount <= 0 || callCount <= 0) return 1.5;
  return 1.5 + 3.5 * Math.sqrt(Math.min(1, callCount / maxCount));
}

export function edgeId(e: Pick<TopologyEdge, 'source' | 'target'>): string {
  return `${e.source}>${e.target}`;
}

const labelOf = (n: TopologyNode) => n.id;

/**
 * The edge label: latency over the recent window, which is what moves when a fault starts or
 * stops. The lifetime average is only the fallback before the scorer has a snapshot to measure from.
 */
export function edgeLabel(e: TopologyEdge, hasWindow: boolean): string {
  if (!hasWindow) return formatMs(e.avg_latency_ms);
  return e.recent_avg_latency_ms === null ? 'idle' : formatMs(e.recent_avg_latency_ms);
}

/** Cytoscape classes of a node: its incident status, plus `degraded` when it is slow right now. */
export function nodeClasses(n: TopologyNode): string {
  return n.degraded ? `${n.status} degraded` : n.status;
}

export function toElements(t: TopologyResponse): ElementDefinition[] {
  const maxCount = t.edges.reduce((m, e) => Math.max(m, e.call_count), 0);
  const nodeIds = new Set(t.nodes.map((n) => n.id));

  const nodes: ElementDefinition[] = t.nodes.map((n) => ({
    group: 'nodes',
    data: {
      id: n.id,
      label: labelOf(n),
      status: n.status,
      incident_id: n.incident_id,
      baseline_ms: n.baseline_ms,
      calls_as_caller: n.calls_as_caller,
      calls_as_callee: n.calls_as_callee,
      recent_avg_ms: n.recent_avg_ms,
      degraded: n.degraded,
    },
    classes: nodeClasses(n),
  }));

  const hasWindow = t.recent_window_ms !== null;
  const byId = new Map(t.nodes.map((n) => [n.id, n] as const));
  const edges: ElementDefinition[] = t.edges
    // An edge to a vertex that is not in the node list cannot be drawn; the API adds endpoints, so
    // this only guards a truncated or hand-edited response.
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => {
      const target = byId.get(e.target);
      const status = target?.status ?? 'healthy';
      return {
        group: 'edges' as const,
        data: {
          id: edgeId(e),
          source: e.source,
          target: e.target,
          width: edgeWidth(e.call_count, maxCount),
          label: edgeLabel(e, hasWindow),
          call_count: e.call_count,
          avg_latency_ms: e.avg_latency_ms,
          p95_latency_ms: e.p95_latency_ms,
          recent_avg_latency_ms: e.recent_avg_latency_ms,
        },
        // Calls INTO a degraded service are the hot path (of an incident, or of a slowdown so new
        // that no incident has opened yet).
        classes: status === 'root_cause' || status === 'affected' || target?.degraded ? 'hot' : '',
      };
    });

  return [...nodes, ...edges];
}

/** A structural key: layout only reruns when this changes, not on every 10 s data refresh. */
export function layoutKey(t: TopologyResponse): string {
  const nodes = t.nodes.map((n) => n.id).sort().join(',');
  const edges = t.edges.map(edgeId).sort().join(',');
  return `${nodes}|${edges}`;
}

/** Services an incident should light up: its root cause, blast radius and the callers at risk. */
export function incidentNodeIds(incident: Incident | undefined): Set<string> {
  if (!incident) return new Set();
  return new Set([incident.root_cause, ...incident.blast_radius, ...incident.at_risk]);
}

export function statusCounts(t: TopologyResponse): Record<NodeStatus, number> {
  const counts: Record<NodeStatus, number> = { root_cause: 0, affected: 0, at_risk: 0, healthy: 0 };
  for (const n of t.nodes) counts[n.status] += 1;
  return counts;
}

/** The incidents (open first, newest first) that mention a service in any role. */
export function incidentsFor(service: string, incidents: Incident[]): Incident[] {
  return incidents
    .filter((i) => i.root_cause === service || i.blast_radius.includes(service) || i.at_risk.includes(service))
    .sort((a, b) => (a.status === b.status ? b.opened_at_ms - a.opened_at_ms : a.status === 'OPEN' ? -1 : 1));
}

export function roleIn(service: string, incident: Incident): 'root cause' | 'affected' | 'at risk' | undefined {
  if (incident.root_cause === service) return 'root cause';
  if (incident.blast_radius.includes(service)) return 'affected';
  if (incident.at_risk.includes(service)) return 'at risk';
  return undefined;
}

export function describeNode(n: TopologyNode): string {
  const parts = [`${formatCount(n.calls_as_callee)} calls received`, `${formatCount(n.calls_as_caller)} calls made`];
  if (n.baseline_ms !== null) parts.push(`baseline ${formatMs(n.baseline_ms)}`);
  if (n.recent_avg_ms !== null) parts.push(`now ${formatMs(n.recent_avg_ms)}`);
  if (n.degraded) parts.push('slow now');
  return parts.join(' · ');
}
