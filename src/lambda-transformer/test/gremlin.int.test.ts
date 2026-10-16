// Integration test against a REAL local TinkerPop Gremlin Server (3.7.3, in-memory TinkerGraph):
//   docker compose --profile gremlin up -d gremlin-server
//   npm run test:integration
// It proves the upsert traversals actually run and behave: idempotent structure, additive
// counters, and the property contract. It cannot prove Neptune-specific behaviour (SigV4,
// concurrent-modification retries): TinkerGraph is not transactional.
import gremlin from 'gremlin';
import { aggregate, BUCKET_COUNT } from '../src/aggregate';
import { handler, setWriter } from '../src/handler';
import { GremlinWriter } from '../src/writers/gremlin';
import { clientCall, mskEvent, traceMessage } from './fixtures';

const URL = process.env.GREMLIN_URL ?? 'ws://localhost:8182/gremlin';
const { statics: __ } = gremlin.process;

let writer: GremlinWriter;
let g: any;

/** Normalize a valueMap() entry: Map -> plain object, single-element arrays unwrapped, Long -> number. */
function plain(m: Map<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of m) {
    const x = Array.isArray(v) && v.length === 1 ? v[0] : v;
    out[String(k)] = typeof x === 'bigint' ? Number(x) : x;
  }
  return out;
}

const vertex = async (name: string) => {
  const rows = await g.V().has('Service', 'name', name).valueMap().toList();
  return rows.map(plain);
};
const edges = async () => (await g.E().hasLabel('CALLS').project('from', 'to', 'p')
  .by(__.outV().values('name')).by(__.inV().values('name')).by(__.valueMap()).toList())
  .map((r: Map<string, any>) => ({ from: r.get('from'), to: r.get('to'), ...plain(r.get('p')) }));

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
  await g.V().hasLabel('Service').drop().iterate();
});

afterAll(async () => {
  await writer?.close();
});

const calls = (n: number, caller = 'frontend', callee = 'cartservice', ms = 4) =>
  Array.from({ length: n }, () => ({ caller, callee, latencyMs: ms, endMs: 1_700_000_000_000 }));

describe('GremlinWriter against a real Gremlin Server', () => {
  test('creates the vertices and the edge with the documented properties', async () => {
    await writer.write(aggregate([...calls(2), ...calls(1, 'frontend', 'cartservice', 600)]));

    expect(await vertex('frontend')).toEqual([expect.objectContaining({ name: 'frontend', total_calls_as_um: 3 })]);
    expect(await vertex('cartservice')).toEqual([expect.objectContaining({ name: 'cartservice', total_calls_as_dm: 3 })]);

    const [edge] = await edges();
    expect(edge).toMatchObject({ from: 'frontend', to: 'cartservice', call_count: 3, last_seen_ms: 1_700_000_000_000 });
    expect(Number(edge.latency_sum_ms)).toBeCloseTo(608, 3);
    expect(Number(edge.latency_recent_avg_ms)).toBeCloseTo(608 / 3, 3);
    expect(edge.h2).toBe(2); // two 4 ms calls (<= 5 ms)
    expect(edge.h9).toBe(1); // one 600 ms call (> 500 ms)
    expect(edge.h0).toBeUndefined(); // empty buckets are not written
    expect(Object.keys(edge).filter((k) => /^h\d$/.test(k)).length).toBeLessThanOrEqual(BUCKET_COUNT);
  });

  test('is idempotent in structure: writing the same batch twice never duplicates vertices or edges', async () => {
    const batch = aggregate(calls(2));
    await writer.write(batch);
    await writer.write(batch);
    await writer.write(batch);

    expect(await g.V().hasLabel('Service').count().next().then((r: any) => Number(r.value))).toBe(2);
    expect(await g.E().hasLabel('CALLS').count().next().then((r: any) => Number(r.value))).toBe(1);
  });

  test('counters add across batches', async () => {
    await writer.write(aggregate(calls(2)));
    await writer.write(aggregate(calls(3, 'frontend', 'cartservice', 10)));

    const [edge] = await edges();
    expect(edge.call_count).toBe(5);
    expect(Number(edge.latency_sum_ms)).toBeCloseTo(2 * 4 + 3 * 10, 3);
    expect(Number(edge.latency_recent_avg_ms)).toBeCloseTo(10, 3); // overwritten by the latest batch
    expect(edge.h2).toBe(2);
    expect(edge.h3).toBe(3); // 10 ms falls in the <= 10 ms bucket
    expect((await vertex('frontend'))[0].total_calls_as_um).toBe(5);
    expect((await vertex('cartservice'))[0].total_calls_as_dm).toBe(5);
  });

  test('a service can be a caller in one edge and a callee in another', async () => {
    await writer.write(aggregate([...calls(1, 'frontend', 'checkoutservice'), ...calls(2, 'checkoutservice', 'paymentservice')]));

    const checkout = (await vertex('checkoutservice'))[0];
    expect(checkout).toMatchObject({ total_calls_as_um: 2, total_calls_as_dm: 1 });
    expect((await edges()).map((e: any) => `${e.from}->${e.to}`).sort()).toEqual([
      'checkoutservice->paymentservice',
      'frontend->checkoutservice',
    ]);
  });

  test('handles a batch larger than one chunk (more than 20 edges)', async () => {
    const many = Array.from({ length: 45 }, (_, i) => calls(1, 'frontend', `svc${i}`)).flat();
    await writer.write(aggregate(many));
    expect(await g.E().hasLabel('CALLS').count().next().then((r: any) => Number(r.value))).toBe(45);
    expect(await g.V().hasLabel('Service').count().next().then((r: any) => Number(r.value))).toBe(46);
  });
});

describe('end to end: Kafka-style event -> handler -> Gremlin Server', () => {
  test('derives the call graph from base64 OTLP/JSON records', async () => {
    setWriter(writer);
    const summary = await handler(
      mskEvent([
        traceMessage('frontend', [clientCall('productcatalogservice:3550', 8), clientCall('cartservice:7070', 3)]),
        traceMessage('checkoutservice', [clientCall('paymentservice:50051', 40)]),
      ]),
    );
    setWriter(undefined);

    expect(summary).toMatchObject({ calls: 3, edges: 3, nodes: 5 });
    expect((await edges()).map((e: any) => `${e.from}->${e.to}`).sort()).toEqual([
      'checkoutservice->paymentservice',
      'frontend->cartservice',
      'frontend->productcatalogservice',
    ]);
  });
});
