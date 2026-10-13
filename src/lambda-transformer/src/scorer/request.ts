// Snapshot + window -> the endpoint's request body (decision 4; contract in src/ml-engine/features.py).
//
// Static quantities (node totals, edge call_count) are the CUMULATIVE counters, because the model
// min-max normalises them inside the graph and was trained on totals. Latencies are the WINDOW's,
// because that is what a fault changes; an edge idle in the window falls back to its lifetime
// average so the request never carries a made-up zero.
import { estimateP95 } from '../aggregate';
import { ScorerConfig } from './config';
import { GraphSnapshot, ScoreRequest, WindowEdge } from './types';

const key = (e: { um: string; dm: string }) => `${e.um}\u0000${e.dm}`;
const finite = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);

export function buildRequest(
  snapshot: GraphSnapshot,
  window: WindowEdge[],
  deltas: Record<string, number>,
  cfg: ScorerConfig,
): ScoreRequest {
  const inWindow = new Map(window.map((e) => [key(e), e]));

  const nodes = new Map<string, { asUm: number; asDm: number }>();
  for (const n of snapshot.nodes) nodes.set(n.name, { asUm: n.asUm, asDm: n.asDm });
  // The endpoint rejects an edge whose endpoint is not a node; a vertex can lag its edges by a write.
  for (const e of snapshot.edges) {
    for (const name of [e.um, e.dm]) if (!nodes.has(name)) nodes.set(name, { asUm: 0, asDm: 0 });
  }

  return {
    nodes: [...nodes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, n]) => ({
        name,
        total_calls_as_um: finite(n.asUm),
        total_calls_as_dm: finite(n.asDm),
        own_delta: finite(deltas[name] ?? 0),
      })),
    edges: snapshot.edges.map((e) => {
      const w = inWindow.get(key(e));
      const lifetimeAvg = e.calls > 0 ? e.sumMs / e.calls : 0;
      const avg = w ? w.sumMs / w.calls : lifetimeAvg;
      const p95 = (w ? estimateP95(w.hist) : undefined) ?? estimateP95(e.hist) ?? avg;
      return {
        um: e.um,
        dm: e.dm,
        avg_latency_ms: finite(avg),
        p95_latency_ms: finite(p95),
        call_count: finite(e.calls),
        rpctype: cfg.rpctype,
      };
    }),
    top_k: cfg.topK,
  };
}
