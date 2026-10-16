// Windowed deltas of Neptune's cumulative counters (decision 2).
//
// The transformer only ever adds to call_count / latency_sum_ms / h0..h9, so "what happened in the
// last minute" is the difference between two reads. A counter that went DOWN means the graph was
// cleared or reloaded (a parity load, a restore): the window is meaningless and is skipped, never
// turned into a negative latency.
import { BUCKET_COUNT } from '../aggregate';
import { EdgeCounters, WindowEdge } from './types';

export type WindowKind = 'first' | 'reset' | 'ok';

export interface WindowResult {
  kind: WindowKind;
  /** Edges that saw at least one call in the window (empty unless kind is 'ok'). */
  edges: WindowEdge[];
}

const key = (e: { um: string; dm: string }) => `${e.um}\u0000${e.dm}`;
const bucket = (hist: number[], i: number) => hist[i] ?? 0;

export function computeWindow(previous: EdgeCounters[] | undefined, current: EdgeCounters[]): WindowResult {
  if (previous === undefined) return { kind: 'first', edges: [] };

  const before = new Map(previous.map((e) => [key(e), e]));
  const edges: WindowEdge[] = [];
  const present = new Set<string>();

  for (const now of current) {
    const k = key(now);
    present.add(k);
    const was = before.get(k);
    const calls = now.calls - (was?.calls ?? 0);
    const sumMs = now.sumMs - (was?.sumMs ?? 0);
    const hist = Array.from({ length: BUCKET_COUNT }, (_, i) => bucket(now.hist, i) - bucket(was?.hist ?? [], i));
    if (calls < 0 || sumMs < -1e-6 || hist.some((h) => h < 0)) return { kind: 'reset', edges: [] };
    if (calls > 0) edges.push({ um: now.um, dm: now.dm, calls, sumMs: Math.max(0, sumMs), hist });
  }
  // An edge that existed before and is gone now: the graph was rewritten under us.
  for (const k of before.keys()) {
    if (!present.has(k)) return { kind: 'reset', edges: [] };
  }
  return { kind: 'ok', edges };
}
