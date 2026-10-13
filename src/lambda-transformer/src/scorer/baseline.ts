// Per-service latency baseline and own_delta (decision 3).
//
// A service's own latency in a window is the call-weighted mean latency of the edges INTO it (the
// time its callers saw). own_delta = observed / baseline - 1, clipped at 0, which is exactly what the
// model's fault generator produced during training (relative slow-down, 0 = normal).
import { Baseline, ScoreRequest, ServiceObservation, WindowEdge } from './types';
import { ScorerConfig } from './config';

export type Baselines = Record<string, Baseline>;

/** Window latency per callee, from the edges that saw calls. */
export function observe(window: WindowEdge[]): Record<string, ServiceObservation> {
  const sums: Record<string, { calls: number; sumMs: number }> = {};
  for (const e of window) {
    const s = (sums[e.dm] ??= { calls: 0, sumMs: 0 });
    s.calls += e.calls;
    s.sumMs += e.sumMs;
  }
  const out: Record<string, ServiceObservation> = {};
  for (const [name, s] of Object.entries(sums)) out[name] = { calls: s.calls, avgMs: s.sumMs / s.calls };
  return out;
}

/** own_delta for every observed service that has a trustworthy baseline; others are simply absent (= 0). */
export function ownDeltas(
  observed: Record<string, ServiceObservation>,
  baselines: Baselines,
  cfg: ScorerConfig,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, o] of Object.entries(observed)) {
    const b = baselines[name];
    if (o.calls < cfg.minCalls || !b || b.n < cfg.warmupWindows) continue;
    out[name] = Math.max(0, o.avgMs / Math.max(b.ms, cfg.latencyFloorMs) - 1);
  }
  return out;
}

/**
 * New baselines after this window. A service learns only from a window with enough calls in which
 * it is NOT itself deviating, so a sustained fault never becomes the new normal. Returns a new object.
 */
export function updateBaselines(
  baselines: Baselines,
  observed: Record<string, ServiceObservation>,
  deltas: Record<string, number>,
  cfg: ScorerConfig,
): Baselines {
  const next: Baselines = { ...baselines };
  for (const [name, o] of Object.entries(observed)) {
    if (o.calls < cfg.minCalls) continue;
    const b = baselines[name];
    if (!b) {
      next[name] = { ms: o.avgMs, n: 1 };
    } else if ((deltas[name] ?? 0) < cfg.baselineUpdateBelow) {
      next[name] = { ms: (1 - cfg.baselineAlpha) * b.ms + cfg.baselineAlpha * o.avgMs, n: b.n + 1 };
    }
  }
  return next;
}

/** Services the gate considers anomalous this window. */
export function anomalousServices(deltas: Record<string, number>, cfg: ScorerConfig): string[] {
  return Object.entries(deltas)
    .filter(([, d]) => d >= cfg.anomalyDelta)
    .map(([name]) => name)
    .sort();
}

/** Re-exported so the request builder and tests share one shape. */
export type { ScoreRequest };
