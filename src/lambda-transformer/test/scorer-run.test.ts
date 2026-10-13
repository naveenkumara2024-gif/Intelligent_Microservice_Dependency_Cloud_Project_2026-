import { DEFAULT_CONFIG } from '../src/scorer/config';
import { CycleDeps, CycleSummary, runCycle } from '../src/scorer/run';
import { FakeGraph, MemoryStore, StubModel } from './scorer-helpers';

const MIN = 60_000;

function harness() {
  const graph = new FakeGraph();
  const store = new MemoryStore();
  const model = new StubModel();
  let clock = 1_700_000_000_000;
  const deps: CycleDeps = { graph, scorer: model, store, now: () => clock };
  /** One minute of traffic, then one scorer run. */
  const minute = async (slowdown: Record<string, number> = {}, calls = 50): Promise<CycleSummary> => {
    graph.advance(calls, slowdown);
    clock += MIN;
    return runCycle(deps);
  };
  return { graph, store, model, deps, minute, clock: () => clock };
}

/** Enough calm windows for every service to have a warm baseline. */
async function warmUp(h: ReturnType<typeof harness>, extra = 0) {
  await runCycle(h.deps); // first run: snapshot only
  for (let i = 0; i < DEFAULT_CONFIG.warmupWindows + extra; i++) await h.minute();
}

describe('runCycle', () => {
  test('the first run only records where the counters are', async () => {
    const h = harness();
    h.graph.advance();
    const s = await runCycle(h.deps);
    expect(s.status).toBe('first');
    expect(s.modelCalled).toBe(false);
    expect(h.store.state!.counters.length).toBeGreaterThan(0);
    expect(h.store.incidents.size).toBe(0);
  });

  test('a healthy system: many windows, the model is never consulted, no incident', async () => {
    const h = harness();
    await warmUp(h);
    for (let i = 0; i < 10; i++) {
      const s = await h.minute();
      expect(s.status).toBe('scored');
      expect(s.anomalous).toEqual([]);
      expect(s.modelCalled).toBe(false);
    }
    expect(h.model.calls).toHaveLength(0);
    expect(h.store.incidents.size).toBe(0);
  });

  test('warm-up: a fault in the first windows is not judged (no baseline yet)', async () => {
    const h = harness();
    await runCycle(h.deps);
    const s = await h.minute({ paymentservice: 8 });
    expect(s.anomalous).toEqual([]);
    expect(h.store.incidents.size).toBe(0);
  });

  test('a fault opens exactly one incident on the second consecutive window, with evidence and blast radius', async () => {
    const h = harness();
    await warmUp(h);

    const first = await h.minute({ paymentservice: 6 });
    expect(first.anomalous).toEqual(['paymentservice']);
    expect(first.modelCalled).toBe(true);
    expect(first.implicated).toBe('paymentservice');
    expect(first.actions).toEqual([]);
    expect(h.store.incidents.size).toBe(0);

    const second = await h.minute({ paymentservice: 6 });
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]).toMatchObject({ kind: 'open', service: 'paymentservice' });

    expect(h.store.incidents.size).toBe(1);
    const incident = [...h.store.incidents.values()][0];
    expect(incident).toMatchObject({
      status: 'OPEN',
      root_cause: 'paymentservice',
      model_version: 'stub-1',
      windows: 2,
      at_risk: ['checkoutservice', 'frontend'],
      blast_radius: [], // nobody upstream is itself anomalous in this fake
    });
    expect(incident.evidence.paymentservice).toMatchObject({ own_delta: 5, window_avg_ms: 60, baseline_ms: 10, calls: 50 });
    expect(incident.ranking[0].name).toBe('paymentservice');
    expect(incident.expires_at).toBeGreaterThan(Math.floor(h.clock() / 1000));
  });

  test('blast radius = anomalous transitive callers of the root cause', async () => {
    const h = harness();
    await warmUp(h);
    const slow = { paymentservice: 6, checkoutservice: 4 };
    await h.minute(slow);
    await h.minute(slow);
    const incident = [...h.store.incidents.values()][0];
    expect(incident.root_cause).toBe('paymentservice');
    expect(incident.blast_radius).toEqual(['checkoutservice']);
    expect(incident.at_risk).toEqual(['checkoutservice', 'frontend']);
  });

  test('persisting fault: one incident is updated, never duplicated; recovery resolves after 3 clean windows', async () => {
    const h = harness();
    await warmUp(h);
    for (let i = 0; i < 6; i++) await h.minute({ paymentservice: 6 });
    expect(h.store.incidents.size).toBe(1);
    expect([...h.store.incidents.values()][0]).toMatchObject({ status: 'OPEN', windows: 6 });

    await h.minute();
    await h.minute();
    expect([...h.store.incidents.values()][0].status).toBe('OPEN');
    const done = await h.minute();
    expect(done.actions[0]).toMatchObject({ kind: 'resolve' });
    expect(done.openIncidents).toEqual([]);
    const incident = [...h.store.incidents.values()][0];
    expect(incident.status).toBe('RESOLVED');
    expect(incident.resolved_at_ms).toBe(h.clock());
    expect(h.store.incidents.size).toBe(1);
  });

  test('the fault is not absorbed into the baseline, so it still reads as a fault after many windows', async () => {
    const h = harness();
    await warmUp(h);
    for (let i = 0; i < 30; i++) await h.minute({ paymentservice: 6 });
    expect(h.store.state!.baselines.paymentservice.ms).toBeCloseTo(10, 5);
    const s = await h.minute({ paymentservice: 6 });
    expect(s.anomalous).toEqual(['paymentservice']);
  });

  test('a graph reset skips the window and keeps open incidents and baselines', async () => {
    const h = harness();
    await warmUp(h);
    await h.minute({ paymentservice: 6 });
    await h.minute({ paymentservice: 6 });
    expect(h.store.incidents.size).toBe(1);

    h.graph.wipe();
    h.graph.advance(50);
    const s = await runCycle(h.deps);
    expect(s.status).toBe('reset');
    expect(s.openIncidents).toHaveLength(1);
    expect(h.store.state!.baselines.paymentservice.n).toBeGreaterThanOrEqual(5);

    // and scoring resumes from the new counters
    const next = await h.minute();
    expect(next.status).toBe('scored');
    expect(next.anomalous).toEqual([]);
  });

  test('overlapping runs: the loser commits nothing and reports a conflict', async () => {
    const h = harness();
    await warmUp(h);
    await h.minute({ paymentservice: 6 });
    h.graph.advance(50, { paymentservice: 6 });

    // Both runs load version V; the first commits, the second must lose.
    const slowRead = h.graph.read.bind(h.graph);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowGraph = { read: async () => { const snap = await slowRead(); await gate; return snap; } };
    const loser = runCycle({ ...h.deps, graph: slowGraph });
    await new Promise((r) => setImmediate(r));
    const winner = await runCycle(h.deps);
    release();
    const lost = await loser;

    expect(winner.status).toBe('scored');
    expect(lost.status).toBe('conflict');
    expect(lost.actions).toEqual([]);
    expect(h.store.incidents.size).toBe(1); // opened exactly once, by the winner
  });

  test('a model failure leaves state untouched, so the window is judged on the next run', async () => {
    const h = harness();
    await warmUp(h);
    await h.minute({ paymentservice: 6 });
    const before = structuredClone(h.store.state);
    const beforeCommits = h.store.commits;

    h.graph.advance(50, { paymentservice: 6 });
    const failing = { score: async () => { throw new Error('endpoint down'); } };
    await expect(runCycle({ ...h.deps, scorer: failing })).rejects.toThrow('endpoint down');
    expect(h.store.commits).toBe(beforeCommits);
    expect(h.store.state).toEqual(before);

    const recovered = await runCycle(h.deps);
    expect(recovered.status).toBe('scored');
    expect(recovered.implicated).toBe('paymentservice');
  });

  test('a service with too few calls cannot be judged even when it is slow', async () => {
    const h = harness();
    await warmUp(h);
    const s = await h.minute({ paymentservice: 20 }, 10); // 10 calls < minCalls
    expect(s.anomalous).toEqual([]);
    expect(s.modelCalled).toBe(false);
  });
});
