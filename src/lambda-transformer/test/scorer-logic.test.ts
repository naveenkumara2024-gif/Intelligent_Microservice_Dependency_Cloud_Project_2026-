import { BUCKET_COUNT } from '../src/aggregate';
import { anomalousServices, observe, ownDeltas, updateBaselines } from '../src/scorer/baseline';
import { transitiveCallers } from '../src/scorer/blast';
import { DEFAULT_CONFIG } from '../src/scorer/config';
import { stepLifecycle } from '../src/scorer/lifecycle';
import { buildRequest } from '../src/scorer/request';
import { EdgeCounters, Implication, WindowEdge } from '../src/scorer/types';
import { computeWindow } from '../src/scorer/window';

const cfg = DEFAULT_CONFIG;
const hist = (b: number, n: number) => Array.from({ length: BUCKET_COUNT }, (_, i) => (i === b ? n : 0));
const edge = (um: string, dm: string, calls: number, sumMs: number, h = hist(3, calls)): EdgeCounters => ({ um, dm, calls, sumMs, hist: h });

describe('computeWindow', () => {
  test('no previous counters: first run, nothing to judge', () => {
    expect(computeWindow(undefined, [edge('a', 'b', 10, 100)])).toEqual({ kind: 'first', edges: [] });
  });

  test('differences of cumulative counters, per edge, histogram included', () => {
    const before = [edge('a', 'b', 100, 1000, hist(3, 100))];
    const after = [edge('a', 'b', 150, 1900, [0, 0, 0, 100, 0, 0, 0, 0, 0, 50])];
    const w = computeWindow(before, after);
    expect(w.kind).toBe('ok');
    expect(w.edges).toEqual([{ um: 'a', dm: 'b', calls: 50, sumMs: 900, hist: [0, 0, 0, 0, 0, 0, 0, 0, 0, 50] }]);
  });

  test('an idle edge is left out; an edge that appeared since counts from zero', () => {
    const before = [edge('a', 'b', 10, 100)];
    const after = [edge('a', 'b', 10, 100), edge('a', 'c', 5, 50, hist(3, 5))];
    const w = computeWindow(before, after);
    expect(w.edges.map((e) => `${e.um}>${e.dm}:${e.calls}`)).toEqual(['a>c:5']);
  });

  test('a counter that went down means the graph was reset: skip the window', () => {
    expect(computeWindow([edge('a', 'b', 100, 1000)], [edge('a', 'b', 3, 30)]).kind).toBe('reset');
    expect(computeWindow([edge('a', 'b', 100, 1000, hist(3, 100))], [edge('a', 'b', 100, 1000, hist(4, 100))]).kind).toBe('reset');
  });

  test('an edge that disappeared means the graph was rewritten: skip the window', () => {
    expect(computeWindow([edge('a', 'b', 10, 100), edge('b', 'c', 10, 100)], [edge('a', 'b', 20, 200)]).kind).toBe('reset');
  });
});

describe('observe / ownDeltas / updateBaselines', () => {
  const w = (dm: string, calls: number, sumMs: number, um = 'x'): WindowEdge => ({ um, dm, calls, sumMs, hist: hist(3, calls) });

  test('a service latency is call-weighted over the edges into it', () => {
    const o = observe([w('s', 10, 100, 'a'), w('s', 30, 900, 'b'), w('t', 5, 5)]);
    expect(o.s).toEqual({ calls: 40, avgMs: 25 });
    expect(o.t).toEqual({ calls: 5, avgMs: 1 });
  });

  test('own_delta = observed / baseline - 1, only with a warm baseline and enough calls', () => {
    const baselines = { s: { ms: 10, n: 5 }, cold: { ms: 10, n: 4 }, thin: { ms: 10, n: 9 } };
    const d = ownDeltas({ s: { calls: 40, avgMs: 30 }, cold: { calls: 40, avgMs: 99 }, thin: { calls: 19, avgMs: 99 }, unknown: { calls: 99, avgMs: 99 } }, baselines, cfg);
    expect(d.s).toBeCloseTo(2);
    expect(d).not.toHaveProperty('cold'); // 4 windows < warm-up of 5
    expect(d).not.toHaveProperty('thin'); // 19 calls < 20
    expect(d).not.toHaveProperty('unknown'); // no baseline yet
  });

  test('faster than normal is 0, and sub-millisecond jitter is not an incident (latency floor)', () => {
    const baselines = { fast: { ms: 10, n: 9 }, tiny: { ms: 0.2, n: 9 } };
    const d = ownDeltas({ fast: { calls: 50, avgMs: 4 }, tiny: { calls: 50, avgMs: 0.9 } }, baselines, cfg);
    expect(d.fast).toBe(0);
    expect(d.tiny).toBe(0);
  });

  test('baseline learns from calm windows (EWMA) and ignores a deviating one', () => {
    const calm = updateBaselines({ s: { ms: 10, n: 6 } }, { s: { calls: 50, avgMs: 12 } }, { s: 0.2 }, cfg);
    expect(calm.s.ms).toBeCloseTo(10.2);
    expect(calm.s.n).toBe(7);

    const fault = updateBaselines({ s: { ms: 10, n: 6 } }, { s: { calls: 50, avgMs: 80 } }, { s: 7 }, cfg);
    expect(fault.s).toEqual({ ms: 10, n: 6 });
  });

  test('first sight seeds the baseline; a thin window teaches nothing; input is not mutated', () => {
    const start = {};
    const seeded = updateBaselines(start, { a: { calls: 30, avgMs: 7 }, b: { calls: 3, avgMs: 7 } }, {}, cfg);
    expect(seeded).toEqual({ a: { ms: 7, n: 1 } });
    expect(start).toEqual({});
  });

  test('the gate: only deviations of at least 2x count', () => {
    expect(anomalousServices({ a: 0.99, b: 1.0, c: 6 }, cfg)).toEqual(['b', 'c']);
  });
});

describe('buildRequest', () => {
  const snapshot = {
    nodes: [
      { name: 'b', asUm: 0, asDm: 40 },
      { name: 'a', asUm: 40, asDm: 0 },
    ],
    edges: [edge('a', 'b', 40, 800, hist(5, 40)), edge('a', 'ghost', 4, 4, hist(1, 4))],
  };

  test('latencies from the window, totals cumulative, rpctype constant, nodes sorted', () => {
    const win: WindowEdge[] = [{ um: 'a', dm: 'b', calls: 10, sumMs: 600, hist: hist(8, 10) }];
    const req = buildRequest(snapshot, win, { b: 2.5 }, cfg);
    expect(req.nodes.map((n) => n.name)).toEqual(['a', 'b', 'ghost']);
    expect(req.nodes.find((n) => n.name === 'b')).toEqual({ name: 'b', total_calls_as_um: 0, total_calls_as_dm: 40, own_delta: 2.5 });
    const ab = req.edges.find((e) => e.dm === 'b')!;
    expect(ab).toEqual({ um: 'a', dm: 'b', avg_latency_ms: 60, p95_latency_ms: 500, call_count: 40, rpctype: 'rpc' });
    expect(req.top_k).toBe(5);
  });

  test('an edge idle in the window falls back to its lifetime figures; unknown endpoints become nodes', () => {
    const req = buildRequest(snapshot, [], {}, cfg);
    const ab = req.edges.find((e) => e.dm === 'b')!;
    expect(ab.avg_latency_ms).toBe(20);
    expect(ab.p95_latency_ms).toBe(50);
    expect(req.nodes.find((n) => n.name === 'ghost')).toEqual({ name: 'ghost', total_calls_as_um: 0, total_calls_as_dm: 0, own_delta: 0 });
  });

  test('never emits NaN, Infinity or negative numbers (the endpoint rejects them)', () => {
    const odd = { nodes: [], edges: [edge('a', 'b', 0, 0, hist(0, 0))] };
    const req = buildRequest(odd, [], { a: Number.NaN, b: -1 }, cfg);
    const values = JSON.stringify(req);
    expect(values).not.toMatch(/NaN|Infinity|-\d/);
  });
});

describe('transitiveCallers', () => {
  const edges = [
    { um: 'frontend', dm: 'checkout' },
    { um: 'checkout', dm: 'payment' },
    { um: 'cron', dm: 'checkout' },
    { um: 'payment', dm: 'checkout' }, // cycle
    { um: 'payment', dm: 'payment' }, // self-loop
    { um: 'other', dm: 'catalog' },
  ];

  test('everything upstream of the root, through cycles and self-loops, excluding the root', () => {
    expect(transitiveCallers(edges, 'payment')).toEqual(['checkout', 'cron', 'frontend']);
    expect(transitiveCallers(edges, 'frontend')).toEqual([]);
    expect(transitiveCallers(edges, 'catalog')).toEqual(['other']);
  });
});

describe('stepLifecycle', () => {
  const impl = (service: string, score = 0.8): Implication => ({
    service,
    score,
    ranking: [{ name: service, score }],
    blastRadius: ['frontend'],
    atRisk: ['frontend'],
    evidence: { [service]: { own_delta: 3, window_avg_ms: 40, baseline_ms: 10, calls: 50 } },
    modelVersion: 'm1',
  });
  const T = 1_700_000_000_000;
  const MIN = 60_000;

  test('one implicated window opens nothing; two consecutive open at the FIRST window time', () => {
    const a = stepLifecycle({}, impl('pay'), T, cfg);
    expect(a.actions).toEqual([]);
    const b = stepLifecycle(a.trackers, impl('pay'), T + MIN, cfg);
    expect(b.actions).toHaveLength(1);
    const open = b.actions[0];
    expect(open.kind).toBe('open');
    expect(open.incident).toMatchObject({
      incident_id: `${T}-pay`,
      status: 'OPEN',
      root_cause: 'pay',
      opened_at_ms: T,
      last_seen_ms: T + MIN,
      windows: 2,
      blast_radius: ['frontend'],
    });
    expect(open.incident.expires_at).toBe(Math.floor((T + MIN) / 1000) + 30 * 86_400);
  });

  test('a flapping signal never opens (hits must be consecutive)', () => {
    let t = stepLifecycle({}, impl('pay'), T, cfg);
    t = stepLifecycle(t.trackers, undefined, T + MIN, cfg);
    t = stepLifecycle(t.trackers, impl('pay'), T + 2 * MIN, cfg);
    expect(t.actions).toEqual([]);
    expect(t.trackers.pay.hits).toBe(1);
  });

  test('while open: updates keep the peak and bump windows; 3 clean windows resolve', () => {
    let s = stepLifecycle({}, impl('pay', 0.6), T, cfg);
    s = stepLifecycle(s.trackers, impl('pay', 0.9), T + MIN, cfg); // open
    s = stepLifecycle(s.trackers, impl('pay', 0.7), T + 2 * MIN, cfg); // update
    expect(s.actions[0].kind).toBe('update');
    expect(s.actions[0].incident).toMatchObject({ score: 0.7, peak_score: 0.9, windows: 3, last_seen_ms: T + 2 * MIN });

    s = stepLifecycle(s.trackers, undefined, T + 3 * MIN, cfg);
    s = stepLifecycle(s.trackers, undefined, T + 4 * MIN, cfg);
    expect(s.actions).toEqual([]);
    s = stepLifecycle(s.trackers, undefined, T + 5 * MIN, cfg);
    expect(s.actions).toHaveLength(1);
    expect(s.actions[0]).toMatchObject({ kind: 'resolve', service: 'pay' });
    expect(s.actions[0].incident).toMatchObject({ status: 'RESOLVED', resolved_at_ms: T + 5 * MIN, last_seen_ms: T + 2 * MIN });
    expect(s.trackers).toEqual({});
  });

  test('being implicated again resets the resolve countdown', () => {
    let s = stepLifecycle({}, impl('pay'), T, cfg);
    s = stepLifecycle(s.trackers, impl('pay'), T + MIN, cfg);
    s = stepLifecycle(s.trackers, undefined, T + 2 * MIN, cfg);
    s = stepLifecycle(s.trackers, undefined, T + 3 * MIN, cfg);
    s = stepLifecycle(s.trackers, impl('pay'), T + 4 * MIN, cfg);
    expect(s.actions[0].kind).toBe('update');
    s = stepLifecycle(s.trackers, undefined, T + 5 * MIN, cfg);
    s = stepLifecycle(s.trackers, undefined, T + 6 * MIN, cfg);
    expect(s.actions).toEqual([]);
  });

  test('a root-cause flip: the new service opens, the old one resolves after its countdown, no duplicates', () => {
    let s = stepLifecycle({}, impl('pay'), T, cfg);
    s = stepLifecycle(s.trackers, impl('pay'), T + MIN, cfg); // pay open
    const opened: string[] = [];
    const resolved: string[] = [];
    for (let i = 2; i <= 6; i++) {
      s = stepLifecycle(s.trackers, impl('mail'), T + i * MIN, cfg);
      for (const a of s.actions) (a.kind === 'open' ? opened : a.kind === 'resolve' ? resolved : []).push(a.service);
    }
    expect(opened).toEqual(['mail']);
    expect(resolved).toEqual(['pay']);
  });
});
