// Layered layout for a service call graph: callers above the services they call.
//
// Cytoscape's breadthfirst puts connected nodes in the same row, so an edge then passes straight
// through a node between them and reads as a call that never happened (found reviewing the first
// screenshot). The layout is computed here instead: longest-path layering on the call DAG (cycles
// are broken by ignoring back edges), then barycenter ordering inside each layer to cut crossings.
import type { TopologyEdge, TopologyNode } from './types';

export interface Position {
  x: number;
  y: number;
}

export function layeredPositions(
  t: { nodes: Pick<TopologyNode, 'id'>[]; edges: Pick<TopologyEdge, 'source' | 'target'>[] },
  options: { columnGap?: number; rowGap?: number } = {},
): Record<string, Position> {
  const columnGap = options.columnGap ?? 170;
  const rowGap = options.rowGap ?? 140;
  const ids = t.nodes.map((n) => n.id).sort();
  const known = new Set(ids);

  // Distinct, known, non-self edges in a deterministic order.
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  const seen = new Set<string>();
  const sortedEdges = [...t.edges].sort((a, b) => `${a.source}>${a.target}`.localeCompare(`${b.source}>${b.target}`));
  for (const e of sortedEdges) {
    if (e.source === e.target || !known.has(e.source) || !known.has(e.target)) continue;
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.get(e.source)!.push(e.target);
  }

  // Break cycles: an edge to a node still on the DFS stack is a back edge and does not layer.
  const state = new Map<string, 'active' | 'done'>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visit = (u: string) => {
    state.set(u, 'active');
    for (const v of out.get(u)!) {
      if (state.get(v) === 'active') continue;
      dag.get(u)!.push(v);
      incoming.get(v)!.push(u);
      if (!state.has(v)) visit(v);
    }
    state.set(u, 'done');
  };
  for (const id of ids) if (!state.has(id)) visit(id);

  // Longest-path layering over the DAG (Kahn order).
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const indegree = new Map<string, number>(ids.map((id) => [id, incoming.get(id)!.length]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i];
    for (const v of dag.get(u)!) {
      layer.set(v, Math.max(layer.get(v)!, layer.get(u)! + 1));
      indegree.set(v, indegree.get(v)! - 1);
      if (indegree.get(v) === 0) queue.push(v);
    }
  }

  const depth = ids.length === 0 ? 0 : Math.max(...layer.values());
  const rows: string[][] = Array.from({ length: ids.length === 0 ? 0 : depth + 1 }, () => []);
  for (const id of ids) rows[layer.get(id)!].push(id);

  // Barycenter sweeps: down by predecessors, then up by successors, with a stable tie-break.
  const indexIn = (row: string[]) => new Map(row.map((id, i) => [id, i] as const));
  const reorder = (row: string[], neighbours: (id: string) => string[], reference: Map<string, number>) => {
    const score = (id: string) => {
      const ns = neighbours(id).filter((n) => reference.has(n));
      return ns.length === 0 ? Number.POSITIVE_INFINITY : ns.reduce((a, n) => a + reference.get(n)!, 0) / ns.length;
    };
    const base = indexIn(row);
    row.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa === sb) return base.get(a)! - base.get(b)!;
      return sa - sb;
    });
  };
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let r = 1; r < rows.length; r++) reorder(rows[r], (id) => incoming.get(id)!, indexIn(rows[r - 1]));
    for (let r = rows.length - 2; r >= 0; r--) reorder(rows[r], (id) => dag.get(id)!, indexIn(rows[r + 1]));
  }

  const widest = Math.max(1, ...rows.map((r) => r.length));
  const positions: Record<string, Position> = {};
  rows.forEach((row, r) => {
    const offset = ((widest - row.length) * columnGap) / 2;
    row.forEach((id, i) => {
      positions[id] = { x: offset + i * columnGap, y: r * rowGap };
    });
  });
  return positions;
}
