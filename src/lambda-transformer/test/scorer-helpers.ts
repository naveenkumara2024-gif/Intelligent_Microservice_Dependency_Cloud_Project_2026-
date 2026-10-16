// Fakes for the scorer's tests: a graph whose cumulative counters advance like the transformer's,
// an in-memory store with the real store's version semantics, and a stub model.
import { BUCKET_COUNT, bucketOf } from '../src/aggregate';
import { GraphSource, ScoreClient, ScorerStore } from '../src/scorer/run';
import {
  EdgeCounters,
  GraphSnapshot,
  IncidentRecord,
  ScoreRequest,
  ScoreResponse,
  ScorerState,
} from '../src/scorer/types';

/** Online Boutique's call topology (caller -> callee), as in src/ml-engine/fixtures. */
export const BOUTIQUE_EDGES: [string, string][] = [
  ['frontend', 'productcatalogservice'],
  ['frontend', 'currencyservice'],
  ['frontend', 'recommendationservice'],
  ['frontend', 'checkoutservice'],
  ['recommendationservice', 'productcatalogservice'],
  ['checkoutservice', 'productcatalogservice'],
  ['checkoutservice', 'currencyservice'],
  ['checkoutservice', 'paymentservice'],
  ['checkoutservice', 'emailservice'],
];

/** Baseline latency of every service in the fake system. */
export const NORMAL_MS = 10;

export class FakeGraph implements GraphSource {
  private edges = new Map<string, EdgeCounters>();
  private nodeCalls = new Map<string, { asUm: number; asDm: number }>();
  reads = 0;

  constructor(topology: [string, string][] = BOUTIQUE_EDGES) {
    for (const [um, dm] of topology) {
      this.edges.set(`${um}>${dm}`, { um, dm, calls: 0, sumMs: 0, hist: new Array(BUCKET_COUNT).fill(0) });
      for (const name of [um, dm]) if (!this.nodeCalls.has(name)) this.nodeCalls.set(name, { asUm: 0, asDm: 0 });
    }
  }

  /** One minute of traffic: `calls` per edge; callee latency is NORMAL_MS x slowdown[callee]. */
  advance(calls = 50, slowdown: Record<string, number> = {}): void {
    for (const e of this.edges.values()) {
      const latency = NORMAL_MS * (slowdown[e.dm] ?? 1);
      e.calls += calls;
      e.sumMs += calls * latency;
      e.hist[bucketOf(latency)] += calls;
      this.nodeCalls.get(e.um)!.asUm += calls;
      this.nodeCalls.get(e.dm)!.asDm += calls;
    }
  }

  /** Simulates a cleared/reloaded graph. */
  wipe(): void {
    for (const e of this.edges.values()) {
      e.calls = 0;
      e.sumMs = 0;
      e.hist = new Array(BUCKET_COUNT).fill(0);
    }
  }

  removeEdge(um: string, dm: string): void {
    this.edges.delete(`${um}>${dm}`);
  }

  async read(): Promise<GraphSnapshot> {
    this.reads++;
    return structuredClone({
      nodes: [...this.nodeCalls.entries()].map(([name, c]) => ({ name, ...c })),
      edges: [...this.edges.values()],
    });
  }
}

export class MemoryStore implements ScorerStore {
  state?: ScorerState;
  version = 0;
  incidents = new Map<string, IncidentRecord>();
  commits = 0;

  async load(): Promise<ScorerState | undefined> {
    return this.state ? structuredClone({ ...this.state, version: this.version }) : undefined;
  }

  async commit(state: ScorerState, incidents: IncidentRecord[]): Promise<boolean> {
    if (state.version !== this.version) return false;
    this.version += 1;
    this.commits += 1;
    this.state = structuredClone({ ...state, version: this.version });
    for (const i of incidents) this.incidents.set(i.incident_id, structuredClone(i));
    return true;
  }
}

/**
 * Stand-in for the GNN: ranks candidate roots (nodes with an incoming call) by own_delta. Good enough
 * to drive the lifecycle deterministically; the real model is exercised by the live phase.
 */
export class StubModel implements ScoreClient {
  calls: ScoreRequest[] = [];
  /** Force the answer, overriding the ranking. */
  force?: string;

  async score(request: ScoreRequest): Promise<ScoreResponse> {
    this.calls.push(request);
    const delta = new Map(request.nodes.map((n) => [n.name, n.own_delta]));
    const candidates = [...new Set(request.edges.map((e) => e.dm))];
    const ranked = candidates
      .map((name) => ({ name, d: name === this.force ? Infinity : delta.get(name) ?? 0 }))
      .sort((a, b) => b.d - a.d || (a.name < b.name ? -1 : 1));
    const total = ranked.length;
    return {
      model_version: 'stub-1',
      ranking: ranked.slice(0, request.top_k).map((r, i) => ({ name: r.name, score: 0.9 - i * (0.8 / total), rank: i + 1 })),
    };
  }
}
