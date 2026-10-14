// One scoring cycle: read the graph, difference it against the previous run, derive own_delta,
// ask the model only when the evidence gate says something is deviating, advance the incident
// lifecycle, and commit state + incident records atomically.
//
// All I/O is injected (graph source, score client, store, clock), so the whole cycle runs in unit
// tests with in-memory fakes and in integration tests against Gremlin Server + DynamoDB Local.
import { anomalousServices, observe, ownDeltas, updateBaselines } from './baseline';
import { transitiveCallers } from './blast';
import { DEFAULT_CONFIG, ScorerConfig } from './config';
import { stepLifecycle } from './lifecycle';
import { buildRequest } from './request';
import {
  Action,
  Evidence,
  GraphSnapshot,
  Implication,
  IncidentRecord,
  ScoreRequest,
  ScoreResponse,
  ScorerState,
} from './types';
import { computeWindow } from './window';

export interface GraphSource {
  read(): Promise<GraphSnapshot>;
}

export interface ScoreClient {
  score(request: ScoreRequest): Promise<ScoreResponse>;
}

export interface ScorerStore {
  /** The stored state, or undefined if this is the first run. */
  load(): Promise<ScorerState | undefined>;
  /**
   * Atomically stores `state` (replacing the version it was loaded at) together with the incident
   * records. Returns false, writing nothing, if another run committed first.
   */
  commit(state: ScorerState, incidents: IncidentRecord[]): Promise<boolean>;
}

export interface CycleDeps {
  graph: GraphSource;
  scorer: ScoreClient;
  store: ScorerStore;
  now: () => number;
  config?: ScorerConfig;
}

export interface CycleSummary {
  status: 'first' | 'reset' | 'scored' | 'conflict';
  window: number;
  observed: number;
  anomalous: string[];
  modelCalled: boolean;
  implicated?: string;
  actions: { kind: Action['kind']; service: string; incident_id: string }[];
  openIncidents: string[];
  windows: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function emptyState(): ScorerState {
  return { version: 0, windows: 0, counters: [], baselines: {}, trackers: {}, updatedMs: 0 };
}

export async function runCycle(deps: CycleDeps): Promise<CycleSummary> {
  const cfg = deps.config ?? DEFAULT_CONFIG;
  const nowMs = deps.now();
  const stored = await deps.store.load();
  const state = stored ?? emptyState();
  const snapshot = await deps.graph.read();

  const result = computeWindow(stored ? state.counters : undefined, snapshot.edges);
  const openIncidents = (trackers: ScorerState['trackers']) =>
    Object.values(trackers).flatMap((t) => (t.incident ? [t.incident.incident_id] : []));

  if (result.kind !== 'ok') {
    // First run, or the graph was reset under us: remember where the counters are, judge nothing.
    const next: ScorerState = { ...state, counters: snapshot.edges, lastWindow: undefined, lastWindowMs: undefined, updatedMs: nowMs };
    const committed = await deps.store.commit(next, []);
    return {
      status: committed ? result.kind : 'conflict',
      window: 0,
      observed: 0,
      anomalous: [],
      modelCalled: false,
      actions: [],
      openIncidents: openIncidents(state.trackers),
      windows: state.windows,
    };
  }

  const observed = observe(result.edges);
  const deltas = ownDeltas(observed, state.baselines, cfg);
  const anomalous = anomalousServices(deltas, cfg);

  // The model always names a "root cause" (a softmax over services), even on a healthy system, so
  // it is only consulted when some service is measurably slower than its own baseline.
  let implication: Implication | undefined;
  let modelCalled = false;
  if (anomalous.length > 0 && snapshot.edges.length > 0) {
    const response = await deps.scorer.score(buildRequest(snapshot, result.edges, deltas, cfg));
    modelCalled = true;
    const top = response.ranking[0];
    if (top) {
      const atRisk = transitiveCallers(result.edges, top.name);
      const anomalousSet = new Set(anomalous);
      const involved = new Set<string>([top.name, ...anomalous]);
      const evidence: Record<string, Evidence> = {};
      for (const name of [...involved].sort()) {
        evidence[name] = {
          own_delta: r3(deltas[name] ?? 0),
          window_avg_ms: r3(observed[name]?.avgMs ?? 0),
          baseline_ms: r3(state.baselines[name]?.ms ?? 0),
          calls: observed[name]?.calls ?? 0,
        };
      }
      implication = {
        service: top.name,
        score: top.score,
        ranking: response.ranking.slice(0, cfg.topK).map((r) => ({ name: r.name, score: r.score })),
        blastRadius: atRisk.filter((s) => anomalousSet.has(s)),
        atRisk,
        evidence,
        modelVersion: response.model_version,
      };
    }
  }

  const { trackers, actions } = stepLifecycle(state.trackers, implication, nowMs, cfg);
  const next: ScorerState = {
    ...state,
    windows: state.windows + 1,
    counters: snapshot.edges,
    lastWindow: result.edges.map(({ um, dm, calls, sumMs }) => ({ um, dm, calls, sumMs })),
    lastWindowMs: Math.max(0, nowMs - state.updatedMs),
    baselines: updateBaselines(state.baselines, observed, deltas, cfg),
    trackers,
    updatedMs: nowMs,
  };

  const committed = await deps.store.commit(
    next,
    actions.map((a) => a.incident),
  );
  return {
    status: committed ? 'scored' : 'conflict',
    window: result.edges.length,
    observed: Object.keys(observed).length,
    anomalous,
    modelCalled,
    implicated: implication?.service,
    actions: committed ? actions.map((a) => ({ kind: a.kind, service: a.service, incident_id: a.incident.incident_id })) : [],
    openIncidents: openIncidents(committed ? trackers : state.trackers),
    windows: committed ? next.windows : state.windows,
  };
}
