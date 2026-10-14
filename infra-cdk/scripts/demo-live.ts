// Pure judgement of a Stage 14 demo run (scripts/verify-demo.ts feeds it what it observed).
// No AWS here; unit-tested in test/demo-live.test.ts with recorded timelines.
//
// The point of this file: the verdict on "did a real fault come out as the right incident and
// alerts" is decided by rules written before the run, not by reading the output afterwards.
import type { Check } from './aws-cli';
import type { LiveEdge } from './probe-client';

/** Scorer windows are one minute (ScorerStack.SCORER_INTERVAL_MINUTES). */
export const WINDOW_MS = 60_000;
/** Opening needs 2 implicated windows after warm-up; allow for a cold model call and window alignment. */
export const OPEN_WITHIN_WINDOWS = 5;
/** Resolving needs 3 clean windows; allow for alignment and the rollout of the healthy pods. */
export const RESOLVE_WITHIN_WINDOWS = 6;
/** The fault must at least double the latency seen on the edges into the faulted service. */
export const MIN_LATENCY_RATIO = 2;

export interface EdgeWindow {
  um: string;
  dm: string;
  calls: number;
  avgMs: number;
}

/** Per-edge calls and average latency between two cumulative samples (counter resets are skipped). */
export function windowEdges(before: LiveEdge[], after: LiveEdge[]): EdgeWindow[] {
  const was = new Map(before.map((e) => [`${e.um}\u0000${e.dm}`, e]));
  const out: EdgeWindow[] = [];
  for (const e of after) {
    const b = was.get(`${e.um}\u0000${e.dm}`);
    const calls = e.call_count - (b?.call_count ?? 0);
    const sum = e.latency_sum_ms - (b?.latency_sum_ms ?? 0);
    if (calls <= 0 || sum < 0) continue;
    out.push({ um: e.um, dm: e.dm, calls, avgMs: sum / calls });
  }
  return out;
}

/** Call-weighted average latency of the edges INTO `service`, or undefined if it received no calls. */
export function intoService(edges: EdgeWindow[], service: string): { calls: number; avgMs: number } | undefined {
  const into = edges.filter((e) => e.dm === service);
  const calls = into.reduce((a, e) => a + e.calls, 0);
  if (calls === 0) return undefined;
  return { calls, avgMs: into.reduce((a, e) => a + e.calls * e.avgMs, 0) / calls };
}

/** 1-based rank of `service` in the model ranking, or 0 if it is not there. */
export function rankOf(ranking: { name: string }[] | undefined, service: string): number {
  return (ranking ?? []).findIndex((r) => r.name === service) + 1;
}

export interface DemoIncident {
  incident_id: string;
  status: string;
  root_cause: string;
  opened_at_ms: number;
  resolved_at_ms?: number;
  windows: number;
  score: number;
  ranking: { name: string; score: number }[];
  blast_radius: string[];
  at_risk: string[];
}

export interface DemoObservation {
  fault: { service: string; description: string; appliedAtMs: number; clearedAtMs?: number };
  soak: { minutes: number; incidentsOpened: number; modelCalls: number; scorerRuns: number };
  /** Window latency into the faulted service before and while faulted (from Neptune). */
  latency: { before?: { calls: number; avgMs: number }; during?: { calls: number; avgMs: number } };
  /** Incidents that opened after the fault was applied. */
  incidents: DemoIncident[];
  /** The tracked incident as last read (may be RESOLVED). */
  final?: DemoIncident;
  /** `alert.published` events for the tracked incident, from the dispatcher log. */
  alertsPublished: string[];
  sns: { delivered: number; failed: number };
  deadLetters: number;
  faultRemoved: boolean;
}

export function evaluateDemo(o: DemoObservation): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) => checks.push({ name, ok, detail, ...(warn ? { warn } : {}) });
  const f = o.fault;
  const minutes = (ms: number) => (ms / 60_000).toFixed(1);

  add(
    `Healthy soak (${o.soak.minutes} min): no incident, no model call`,
    o.soak.incidentsOpened === 0 && o.soak.modelCalls === 0 && o.soak.scorerRuns > 0,
    `${o.soak.scorerRuns} scorer runs, ${o.soak.modelCalls} model calls, ${o.soak.incidentsOpened} incidents`,
  );

  const { before, during } = o.latency;
  const ratio = before && during ? during.avgMs / Math.max(before.avgMs, 0.001) : undefined;
  add(
    `The fault is visible in the graph: latency into ${f.service} rose >= ${MIN_LATENCY_RATIO}x`,
    ratio !== undefined && ratio >= MIN_LATENCY_RATIO,
    before && during
      ? `${before.avgMs.toFixed(2)} ms (${before.calls} calls) -> ${during.avgMs.toFixed(2)} ms (${during.calls} calls), x${ratio!.toFixed(1)}`
      : `no window data (before=${!!before}, during=${!!during}): the service received no calls in a window`,
  );

  // Opening ------------------------------------------------------------------------------------
  const opened = o.incidents;
  const first = [...opened].sort((a, b) => a.opened_at_ms - b.opened_at_ms)[0];
  const openDelay = first ? first.opened_at_ms - f.appliedAtMs : undefined;
  add(
    `An incident opens within ${OPEN_WITHIN_WINDOWS} windows of the fault`,
    !!first && openDelay! <= OPEN_WITHIN_WINDOWS * WINDOW_MS,
    first ? `${first.incident_id} opened ${minutes(openDelay!)} min after the fault` : 'no incident opened',
  );
  add(
    'Exactly one incident opened (no duplicates, no unrelated alarms)',
    opened.length === 1,
    `${opened.length} incident(s): ${opened.map((i) => `${i.root_cause}`).join(', ') || 'none'}`,
  );

  if (first) {
    const rank = rankOf(first.ranking, f.service);
    // A miss is a finding about the model, reported plainly; it is not hidden and not a pipeline failure.
    add(
      `Root cause is the faulted service (${f.service})`,
      first.root_cause === f.service,
      first.root_cause === f.service
        ? `top-1 at score ${first.score.toFixed(3)}`
        : `model named ${first.root_cause}; ${f.service} is ${rank ? `#${rank}` : 'not in the ranking'} (Boutique top-1 was 65.5% on synthetic scenarios)`,
      first.root_cause !== f.service,
    );
    add(`${f.service} is in the model's top 3`, rank >= 1 && rank <= 3, rank ? `rank #${rank}` : 'not ranked');
    add(
      'The ripple is reported: callers at risk listed (blast radius = callers that also slowed)',
      first.at_risk.length > 0,
      `at_risk=${JSON.stringify(first.at_risk)}, blast_radius=${JSON.stringify(first.blast_radius)}`,
    );
  }

  // Recovery -----------------------------------------------------------------------------------
  const final = o.final;
  if (f.clearedAtMs === undefined) {
    add('The fault was cleared', false, 'the demo never reached the recovery step');
  } else {
    const resolvedDelay = final?.resolved_at_ms !== undefined ? final.resolved_at_ms - f.clearedAtMs : undefined;
    add(
      `The incident resolves within ${RESOLVE_WITHIN_WINDOWS} windows of clearing the fault`,
      final?.status === 'RESOLVED' && resolvedDelay !== undefined && resolvedDelay <= RESOLVE_WITHIN_WINDOWS * WINDOW_MS,
      final?.status === 'RESOLVED' ? `resolved ${minutes(resolvedDelay!)} min after clearing (windows=${final.windows})` : `status ${final?.status ?? 'unknown'}`,
    );
  }
  add('The fault was removed from the cluster', o.faultRemoved, o.faultRemoved ? 'deployment back to the manifest values' : 'STILL APPLIED: run npm run fault -- clear');

  // Alerts -------------------------------------------------------------------------------------
  const count = (e: string) => o.alertsPublished.filter((x) => x === e).length;
  add(
    'Alerts: exactly one "opened" and one "resolved" for the incident',
    count('incident.opened') === 1 && count('incident.resolved') === 1,
    `opened=${count('incident.opened')}, resolved=${count('incident.resolved')}`,
  );
  add('SNS delivered the alerts, none failed', o.sns.delivered > 0 && o.sns.failed === 0, `delivered=${o.sns.delivered}, failed=${o.sns.failed}`);
  add('Dead-letter queue is empty', o.deadLetters === 0, `${o.deadLetters} message(s)`);
  return checks;
}
