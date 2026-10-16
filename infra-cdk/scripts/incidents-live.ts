// Pure logic for the Stage 11 live checks (verify-incidents.ts, verify-dynamodb.ts): no AWS here,
// unit-tested in test/incidents-live.test.ts. The scripts feed it AWS CLI output.
import type { Check } from './aws-cli';
import type { LiveEdge } from './probe-client';

/** Mirrors src/lambda-transformer/src/scorer/config.ts; asserted equal in the unit test. */
export const WARMUP_WINDOWS = 5;
export const ANOMALY_DELTA = 1.0;
export const TTL_DAYS = 30;
export const DEGRADE_MAX_CALLS = 2000;
export const INJECTIONS_PER_MINUTE = 4;

// --- DynamoDB JSON (what `aws dynamodb` prints) -----------------------------------------------

export type AttributeValue =
  | { S: string }
  | { N: string }
  | { BOOL: boolean }
  | { NULL: true }
  | { M: Record<string, AttributeValue> }
  | { L: AttributeValue[] };

export function unmarshall(value: AttributeValue): unknown {
  if ('S' in value) return value.S;
  if ('N' in value) return Number(value.N);
  if ('BOOL' in value) return value.BOOL;
  if ('NULL' in value) return null;
  if ('L' in value) return value.L.map(unmarshall);
  return Object.fromEntries(Object.entries(value.M).map(([k, v]) => [k, unmarshall(v)]));
}

export function unmarshallItem(item: Record<string, AttributeValue>): Record<string, any> {
  return unmarshall({ M: item }) as Record<string, any>;
}

export function marshall(value: unknown): AttributeValue {
  if (value === null || value === undefined) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'number') return { N: String(value) };
  if (typeof value === 'boolean') return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(marshall) };
  return { M: Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, marshall(v)])) };
}

export const marshallItem = (item: Record<string, unknown>): Record<string, AttributeValue> =>
  (marshall(item) as { M: Record<string, AttributeValue> }).M;

// --- scorer log lines ---------------------------------------------------------------------------

export interface CycleLog {
  status: 'first' | 'reset' | 'scored' | 'conflict';
  window: number;
  observed: number;
  anomalous: string[];
  modelCalled: boolean;
  implicated?: string;
  actions: { kind: string; service: string; incident_id: string }[];
  openIncidents: string[];
  windows: number;
}

/** The handler logs `scorer {json}`; Lambda prefixes the line with a timestamp and request id. */
export function parseScorerLog(message: string): CycleLog | undefined {
  const at = message.indexOf('scorer {');
  if (at === -1) return undefined;
  try {
    return JSON.parse(message.slice(at + 'scorer '.length).trim()) as CycleLog;
  } catch {
    return undefined;
  }
}

// --- choosing and sizing the synthetic slow-down ------------------------------------------------

export interface Rate {
  service: string;
  callsPerMinute: number;
  edgeCount: number;
}

/** Calls per minute INTO each service, from two samples of the live edges `seconds` apart. */
export function ratesPerService(before: LiveEdge[], after: LiveEdge[], seconds: number): Rate[] {
  const was = new Map(before.map((e) => [`${e.um}\u0000${e.dm}`, e.call_count]));
  const out = new Map<string, Rate>();
  for (const e of after) {
    const delta = e.call_count - (was.get(`${e.um}\u0000${e.dm}`) ?? 0);
    if (delta < 0) continue;
    const r = out.get(e.dm) ?? { service: e.dm, callsPerMinute: 0, edgeCount: 0 };
    r.callsPerMinute += (delta * 60) / seconds;
    r.edgeCount += 1;
    out.set(e.dm, r);
  }
  return [...out.values()];
}

export interface BaselineState {
  baselines: Record<string, { ms: number; n: number }>;
}

/** The busiest service whose baseline is warm; undefined if none can be judged yet. */
export function pickTarget(
  state: BaselineState,
  rates: Rate[],
  excluded: string[] = [],
): (Rate & { baselineMs: number }) | undefined {
  return rates
    .filter((r) => !excluded.includes(r.service) && (state.baselines[r.service]?.n ?? 0) >= WARMUP_WINDOWS && r.callsPerMinute >= 20)
    .sort((a, b) => b.callsPerMinute - a.callsPerMinute || (a.service < b.service ? -1 : 1))
    .map((r) => ({ ...r, baselineMs: state.baselines[r.service].ms }))[0];
}

export interface DegradePlan {
  service: string;
  /** Latency of each synthetic call. */
  latencyMs: number;
  /** Synthetic calls added to each incoming edge per injection. */
  callsPerInjection: number;
  injectionsPerMinute: number;
  /** What the scorer should see in a window: the mix of real and synthetic calls. */
  expectedWindowAvgMs: number;
  expectedDelta: number;
}

/**
 * Synthetic calls should outnumber real ones about 4:1 in every window and be ~7x the baseline, so
 * the window average lands near a 5x deviation (inside the trained 2-9 range) however busy the
 * service is. The scorer divides by max(baseline, 1 ms), so the 7x is taken against that too:
 * a 0.6 ms baseline gets 7 ms calls, not 4.2 ms ones that could never cross the gate.
 */
export function planDegrade(target: Rate & { baselineMs: number }): DegradePlan {
  const latencyMs = Math.round(7 * Math.max(target.baselineMs, 1) * 10) / 10;
  const perEdgePerMinute = target.callsPerMinute / Math.max(target.edgeCount, 1);
  const callsPerInjection = Math.min(DEGRADE_MAX_CALLS, Math.max(20, Math.ceil(perEdgePerMinute)));
  const syntheticPerMinute = callsPerInjection * INJECTIONS_PER_MINUTE * target.edgeCount;
  const real = target.callsPerMinute;
  const expectedWindowAvgMs = (real * target.baselineMs + syntheticPerMinute * latencyMs) / (real + syntheticPerMinute);
  return {
    service: target.service,
    latencyMs,
    callsPerInjection,
    injectionsPerMinute: INJECTIONS_PER_MINUTE,
    expectedWindowAvgMs,
    expectedDelta: expectedWindowAvgMs / Math.max(target.baselineMs, 1) - 1, // the scorer's 1 ms floor
  };
}

// --- the persisted incident ---------------------------------------------------------------------

/** Schema checks on one incident item (decision 8 in prompt/stage-11-incident-persistence.md). */
export function validateIncident(item: Record<string, any>, target: string, nowSeconds: number): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const isStringArray = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string');
  const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);

  add('incident: identity', item.schema_version === 1 && /^\d+-.+/.test(String(item.incident_id)) && typeof item.root_cause === 'string',
    `schema_version=${item.schema_version}, id=${item.incident_id}, root_cause=${item.root_cause}`);
  add('incident: id embeds the opening time and root cause',
    String(item.incident_id) === `${item.opened_at_ms}-${item.root_cause}`, `${item.incident_id} vs ${item.opened_at_ms}-${item.root_cause}`);
  add('incident: times ordered', finite(item.opened_at_ms) && finite(item.last_seen_ms) && item.opened_at_ms <= item.last_seen_ms,
    `opened ${item.opened_at_ms}, last seen ${item.last_seen_ms}`);
  add('incident: needed >= 2 windows to open', finite(item.windows) && item.windows >= 2, `windows=${item.windows}`);
  add('incident: scores', finite(item.score) && finite(item.peak_score) && item.peak_score >= item.score && item.score > 0 && item.score <= 1,
    `score=${item.score}, peak=${item.peak_score}`);
  add('incident: ranking', Array.isArray(item.ranking) && item.ranking.length > 0 && item.ranking.every((r: any) => typeof r.name === 'string' && finite(r.score)),
    `${Array.isArray(item.ranking) ? item.ranking.length : 'no'} entries`);
  add('incident: blast radius and at-risk are service lists', isStringArray(item.blast_radius) && isStringArray(item.at_risk),
    `blast_radius=${JSON.stringify(item.blast_radius)}, at_risk=${JSON.stringify(item.at_risk)}`);
  add('incident: blast radius is a subset of at-risk',
    isStringArray(item.blast_radius) && isStringArray(item.at_risk) && item.blast_radius.every((s: string) => item.at_risk.includes(s)),
    'every anomalous caller must be a caller');
  const evidence = item.evidence?.[target];
  add(`incident: evidence for ${target} shows a deviation past the gate`,
    !!evidence && finite(evidence.own_delta) && evidence.own_delta >= ANOMALY_DELTA && evidence.baseline_ms > 0,
    evidence ? JSON.stringify(evidence) : `no evidence entry for ${target}`);
  add('incident: model version recorded', typeof item.model_version === 'string' && item.model_version.length > 0, String(item.model_version));
  const wantExpiry = Math.floor(item.last_seen_ms / 1000) + TTL_DAYS * 86_400;
  add('incident: TTL is 30 days after the last update (epoch seconds)',
    finite(item.expires_at) && Math.abs(item.expires_at - wantExpiry) <= 3600 && item.expires_at > nowSeconds,
    `expires_at=${item.expires_at}, want about ${wantExpiry}`);
  return checks;
}
