// Integration test of the Stage 9 probe's graph actions against a REAL local TinkerPop Gremlin
// Server (same setup as gremlin.int.test.ts):
//   docker compose --profile gremlin up -d gremlin-server
//   npm run test:integration
// It proves the Gremlin the probe will run on Neptune is valid and behaves as intended. It cannot
// prove Neptune-specific behaviour (IAM auth, concurrent-modification handling): TinkerGraph is
// neither authenticated nor transactional, so the concurrency totals are NOT asserted here.
import { GremlinWriter } from '../src/writers/gremlin';
import {
  clearGraph,
  concurrencyTest,
  graphStats,
  LoadEdge,
  LoadNode,
  loadGraph,
  PROBE_PREFIX,
  smokeTest,
} from '../src/probe-actions';

const URL = process.env.GREMLIN_URL ?? 'ws://localhost:8182/gremlin';

let writer: GremlinWriter;
let g: any;

beforeAll(async () => {
  writer = new GremlinWriter({ url: URL });
  g = writer.source;
  try {
    await g.V().limit(1).toList();
  } catch (err) {
    throw new Error(
      `Cannot reach a Gremlin Server at ${URL}. Start Docker Desktop, then:\n` +
        '  docker compose --profile gremlin up -d gremlin-server\n' +
        `(${(err as Error).message})`,
    );
  }
});

beforeEach(async () => {
  await clearGraph(g);
});

afterAll(async () => {
  await clearGraph(g);
  await writer?.close();
});

const node = (name: string, um: number, dm: number): LoadNode => ({ name, total_calls_as_um: um, total_calls_as_dm: dm });
const edge = (um: string, dm: string, call_count: number, rpctype = 'rpc'): LoadEdge => ({
  um,
  dm,
  call_count,
  avg_latency_ms: 2.5,
  p95_latency_ms: 9,
  rpctype,
});

describe('loadGraph + graphStats (the Stage 2 parity path)', () => {
  const nodes = [node('a', 10, 0), node('b', 5, 10), node('c', 0, 7), node('d', 1, 1)];
  const edges = [edge('a', 'b', 100), edge('b', 'c', 100), edge('a', 'c', 40), edge('d', 'a', 7, 'db')];

  test('loads Stage 2 rows and reports counts, sums and per-node degrees', async () => {
    await loadGraph(g, nodes, edges);
    const s = await graphStats(g);

    expect(s.nodes).toBe(4);
    expect(s.edges).toBe(4);
    expect(s.callCountSum).toBe(247);
    expect(s.totalCallsAsUmSum).toBe(16);
    expect(s.totalCallsAsDmSum).toBe(18);
    expect(s.degrees).toEqual({ a: [2, 1], b: [1, 1], c: [0, 2], d: [1, 0] });
  });

  test('top 10 is ordered by call_count desc, ties broken by (um, dm) name', async () => {
    await loadGraph(g, nodes, edges);
    const { top10 } = await graphStats(g);
    expect(top10).toEqual([
      { um: 'a', dm: 'b', call_count: 100 },
      { um: 'b', dm: 'c', call_count: 100 },
      { um: 'a', dm: 'c', call_count: 40 },
      { um: 'd', dm: 'a', call_count: 7 },
    ]);
  });

  test('is idempotent: loading the same rows again changes nothing (MERGE ... SET, not increment)', async () => {
    await loadGraph(g, nodes, edges);
    const before = await graphStats(g);
    await loadGraph(g, nodes, edges);
    expect(await graphStats(g)).toEqual(before);
  });

  test('a re-load overwrites properties instead of adding to them', async () => {
    await loadGraph(g, nodes, edges);
    await loadGraph(g, [node('a', 99, 0)], [edge('a', 'b', 1)]);
    const s = await graphStats(g);
    expect(s.edges).toBe(4);
    expect(s.callCountSum).toBe(1 + 100 + 40 + 7);
    expect(s.totalCallsAsUmSum).toBe(99 + 5 + 0 + 1);
  });

  test('loads more than one chunk of nodes and edges', async () => {
    const manyNodes = Array.from({ length: 120 }, (_, i) => node(`n${i}`, 1, 1));
    const manyEdges = Array.from({ length: 119 }, (_, i) => edge(`n${i}`, `n${i + 1}`, i + 1));
    await loadGraph(g, manyNodes, manyEdges);
    const s = await graphStats(g);
    expect(s.nodes).toBe(120);
    expect(s.edges).toBe(119);
    expect(s.callCountSum).toBe((119 * 120) / 2);
  });

  test('an empty graph reports zeros rather than failing', async () => {
    const s = await graphStats(g);
    expect(s).toMatchObject({ nodes: 0, edges: 0, callCountSum: 0, degrees: {}, top10: [] });
  });
});

describe('clearGraph', () => {
  test('drops everything, in chunks, and reports how many vertices it removed', async () => {
    const nodes = Array.from({ length: 2500 }, (_, i) => node(`n${i}`, 0, 0));
    await loadGraph(g, nodes, []);
    expect(await clearGraph(g)).toBe(2500);
    expect((await graphStats(g)).nodes).toBe(0);
  });
});

describe('self-tests of the production writer', () => {
  test('smokeTest passes against a real engine and leaves nothing behind', async () => {
    const checks = await smokeTest(writer, g);
    const failed = checks.filter((c) => !c.ok);
    expect(failed).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(5);
    expect((await graphStats(g)).nodes).toBe(0);
  });

  test('concurrencyTest runs end to end and cleans up (totals are only meaningful on Neptune)', async () => {
    const checks = await concurrencyTest(() => new GremlinWriter({ url: URL }), g, 4);
    expect(checks).toHaveLength(2);
    expect(checks.map((c) => c.name)[0]).toMatch(/4 concurrent writers/);
    expect(await g.V().count().next().then((r: any) => Number(r.value))).toBe(0);
  });

  test('the probe prefix is reserved for self-tests', () => {
    expect(PROBE_PREFIX).toBe('__probe_');
  });
});
