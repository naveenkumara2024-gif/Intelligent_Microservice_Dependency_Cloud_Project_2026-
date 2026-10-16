// Pins the request the scorer sends to the SageMaker endpoint. The golden file is also fed through
// the container's own handler by src/ml-engine/tests/test_scorer_contract.py, so a drift in field
// names, rpctype or top_k fails in CI on one side or the other, not in a live session.
//
// Regenerate deliberately with:  UPDATE_GOLDEN=1 npx jest test/scorer-contract
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bucketOf } from '../src/aggregate';
import { ownDeltas, observe } from '../src/scorer/baseline';
import { DEFAULT_CONFIG } from '../src/scorer/config';
import { buildRequest } from '../src/scorer/request';
import { EdgeCounters, WindowEdge } from '../src/scorer/types';

const FIXTURE = path.join(__dirname, '..', '..', 'ml-engine', 'fixtures', 'boutique_topology.json');
const GOLDEN = path.join(__dirname, 'fixtures', 'scorer-request.json');

interface Topology {
  nodes: { name: string; total_calls_as_um: number; total_calls_as_dm: number }[];
  edges: { um: string; dm: string; call_count: number; avg_latency_ms: number }[];
}

/** Boutique with a 6x slow-down at paymentservice and a ripple at checkoutservice, one window of 100 calls/edge. */
function scenario() {
  const topo = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Topology;
  const hist = (ms: number, n: number) => {
    const h = new Array(10).fill(0);
    h[bucketOf(ms)] = n;
    return h;
  };
  const counters: EdgeCounters[] = topo.edges.map((e) => ({
    um: e.um,
    dm: e.dm,
    calls: e.call_count,
    sumMs: e.call_count * e.avg_latency_ms,
    hist: hist(e.avg_latency_ms, e.call_count),
  }));
  const slow: Record<string, number> = { paymentservice: 6, checkoutservice: 2 };
  const window: WindowEdge[] = topo.edges.map((e) => {
    const ms = e.avg_latency_ms * (slow[e.dm] ?? 1);
    return { um: e.um, dm: e.dm, calls: 100, sumMs: 100 * ms, hist: hist(ms, 100) };
  });
  const baselines = Object.fromEntries(
    Object.entries(observe(window.map((w) => ({ ...w, sumMs: w.sumMs / (slow[w.dm] ?? 1) })))).map(([k, o]) => [k, { ms: o.avgMs, n: 9 }]),
  );
  const deltas = ownDeltas(observe(window), baselines, DEFAULT_CONFIG);
  const nodes = topo.nodes.map((n) => ({ name: n.name, asUm: n.total_calls_as_um, asDm: n.total_calls_as_dm }));
  return buildRequest({ nodes, edges: counters }, window, deltas, DEFAULT_CONFIG);
}

describe('scorer -> endpoint request contract', () => {
  test('matches the committed golden request', () => {
    const request = scenario();
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(request, null, 2) + '\n');
    }
    expect(JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))).toEqual(JSON.parse(JSON.stringify(request)));
  });

  test('the scenario carries the deviation the model should see', () => {
    const request = scenario();
    const delta = Object.fromEntries(request.nodes.map((n) => [n.name, n.own_delta]));
    // paymentservice's baseline in the fixture is 0.694 ms, below the 1 ms latency floor, so its
    // 6x slow-down reads as (6 x 0.694 / 1) - 1 = 3.16 rather than 5: still well past the gate.
    expect(delta.paymentservice).toBeCloseTo(3.164, 2);
    expect(delta.paymentservice).toBeGreaterThanOrEqual(DEFAULT_CONFIG.anomalyDelta);
    expect(delta.checkoutservice).toBeCloseTo(1, 1);
    expect(delta.frontend).toBe(0);
    expect(request.edges.every((e) => ['rpc', 'db', 'mc', 'http', 'mq', 'userDefined'].includes(e.rpctype))).toBe(true);
  });
});
