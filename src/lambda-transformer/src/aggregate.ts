// Batch aggregation: one record per (caller, callee) and per service, so the writer issues one
// upsert per edge/node instead of one per span (fewer writes, less contention).
import { Call } from './edges';

/** Upper bounds (ms) of the first 9 latency buckets; the 10th bucket is everything above. */
export const BUCKET_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
export const BUCKET_COUNT = BUCKET_BOUNDS_MS.length + 1;

export function bucketOf(latencyMs: number): number {
  const i = BUCKET_BOUNDS_MS.findIndex((bound) => latencyMs <= bound);
  return i === -1 ? BUCKET_COUNT - 1 : i;
}

export interface EdgeAgg {
  caller: string;
  callee: string;
  count: number;
  sumMs: number;
  /** mean latency of this batch only: the "recent" signal, overwritten on each write */
  recentAvgMs: number;
  lastSeenMs: number;
  hist: number[];
}

export interface NodeAgg {
  name: string;
  asCaller: number;
  asCallee: number;
}

export interface Aggregate {
  edges: EdgeAgg[];
  nodes: NodeAgg[];
}

export function aggregate(calls: Call[]): Aggregate {
  const edges = new Map<string, EdgeAgg>();
  const nodes = new Map<string, NodeAgg>();
  const node = (name: string): NodeAgg => {
    let n = nodes.get(name);
    if (!n) nodes.set(name, (n = { name, asCaller: 0, asCallee: 0 }));
    return n;
  };

  for (const c of calls) {
    const key = `${c.caller}\u0000${c.callee}`;
    let e = edges.get(key);
    if (!e) {
      e = {
        caller: c.caller,
        callee: c.callee,
        count: 0,
        sumMs: 0,
        recentAvgMs: 0,
        lastSeenMs: 0,
        hist: new Array(BUCKET_COUNT).fill(0),
      };
      edges.set(key, e);
    }
    e.count++;
    e.sumMs += c.latencyMs;
    e.lastSeenMs = Math.max(e.lastSeenMs, c.endMs);
    e.hist[bucketOf(c.latencyMs)]++;
    node(c.caller).asCaller++;
    node(c.callee).asCallee++;
  }
  for (const e of edges.values()) e.recentAvgMs = e.sumMs / e.count;
  return { edges: [...edges.values()], nodes: [...nodes.values()] };
}

/**
 * Estimated p95 (ms) from a stored histogram, for readers (Stage 9/10): the upper bound of the
 * bucket containing the 95th percentile. The open-ended last bucket reports its lower bound.
 */
export function estimateP95(hist: number[]): number | undefined {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  const target = Math.ceil(total * 0.95);
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= target) {
      return BUCKET_BOUNDS_MS[Math.min(i, BUCKET_BOUNDS_MS.length - 1)];
    }
  }
  return undefined;
}
