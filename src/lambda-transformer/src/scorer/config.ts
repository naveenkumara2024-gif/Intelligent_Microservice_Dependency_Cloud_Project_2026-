// Every threshold the scorer uses, in one place (prompt/stage-11-incident-persistence.md,
// decisions 1-5). They are constants on purpose: retuning after a live soak is a one-line change
// with the tests alongside, not a redesign.

export interface ScorerConfig {
  /** A service counts as anomalous at own_delta >= this (1.0 = 2x its baseline). Trained faults were 2-9. */
  anomalyDelta: number;
  /** Baselines only learn from windows below this deviation, so a fault is not absorbed as "normal". */
  baselineUpdateBelow: number;
  /** EWMA weight of a new window in the baseline. */
  baselineAlpha: number;
  /** A service needs this many calls in a window to be observed (and to teach its baseline). */
  minCalls: number;
  /** Baseline windows required before a service can be anomalous at all. */
  warmupWindows: number;
  /** Ratios are taken against max(baseline, this): sub-millisecond jitter is not an incident. */
  latencyFloorMs: number;
  /** Consecutive implicated windows before an incident opens. */
  openAfter: number;
  /** Consecutive windows without being implicated before an incident resolves. */
  resolveAfter: number;
  topK: number;
  ttlDays: number;
  /**
   * The streaming graph does not store an rpctype, and the model only knows the six Alibaba kinds.
   * Online Boutique is gRPC/HTTP, so every edge is sent as "rpc".
   */
  rpctype: string;
}

export const DEFAULT_CONFIG: ScorerConfig = {
  anomalyDelta: 1.0,
  baselineUpdateBelow: 0.5,
  baselineAlpha: 0.1,
  minCalls: 20,
  warmupWindows: 5,
  latencyFloorMs: 1,
  openAfter: 2,
  resolveAfter: 3,
  topK: 5,
  ttlDays: 30,
  rpctype: 'rpc',
};
