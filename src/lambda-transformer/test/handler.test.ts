import { Aggregate } from '../src/aggregate';
import { getWriter, handler, setWriter } from '../src/handler';
import { LogWriter } from '../src/writers/log';
import { GraphWriter } from '../src/writers/types';
import { clientCall, mskEvent, traceMessage } from './fixtures';

class CapturingWriter implements GraphWriter {
  batches: Aggregate[] = [];
  async write(batch: Aggregate) {
    this.batches.push(batch);
    return { nodes: batch.nodes.length, edges: batch.edges.length };
  }
}

let captured: CapturingWriter;
beforeEach(() => {
  captured = new CapturingWriter();
  setWriter(captured);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  setWriter(undefined);
  jest.restoreAllMocks();
});

describe('handler', () => {
  test('turns a batch of base64 records into one aggregated write', async () => {
    const event = mskEvent([
      traceMessage('frontend', [clientCall('cartservice', 4), clientCall('cartservice', 6), clientCall('currencyservice', 1)]),
      traceMessage('checkoutservice', [clientCall('paymentservice:50051', 20), { kind: 2, attrs: { 'server.address': 'x' } }]),
    ]);
    const summary = await handler(event);

    expect(summary).toMatchObject({ records: 2, undecodable: 0, spans: 5, skippedSpans: 0, calls: 4, edges: 3, nodes: 5 });
    expect(captured.batches).toHaveLength(1); // one write per invocation, not per record
    const edges = captured.batches[0].edges.map((e) => `${e.caller}->${e.callee}:${e.count}`).sort();
    expect(edges).toEqual(['checkoutservice->paymentservice:1', 'frontend->cartservice:2', 'frontend->currencyservice:1']);
  });

  test('handles records from several topic-partitions in one event', async () => {
    const event = {
      records: {
        'otel.traces-0': mskEvent([traceMessage('a', [clientCall('b')])], 0).records['otel.traces-0'],
        'otel.traces-1': mskEvent([traceMessage('a', [clientCall('b')])], 1).records['otel.traces-1'],
      },
    };
    const summary = await handler(event);
    expect(summary.records).toBe(2);
    expect(captured.batches[0].edges[0].count).toBe(2);
  });

  test('a bad record does not fail the batch: it is counted and the good records still write', async () => {
    const summary = await handler(
      mskEvent([undefined, 'not json at all', traceMessage('frontend', [clientCall('cartservice')])]),
    );
    expect(summary).toMatchObject({ records: 3, undecodable: 1, skippedSpans: 1, calls: 1, edges: 1 });
    expect(captured.batches).toHaveLength(1);
  });

  test('does not touch the graph when a batch yields no calls', async () => {
    const summary = await handler(mskEvent([traceMessage('frontend', [{ kind: 1 }]), '{}']));
    expect(summary.calls).toBe(0);
    expect(captured.batches).toHaveLength(0);
  });

  test('an empty or missing records map is fine', async () => {
    await expect(handler({ records: {} })).resolves.toMatchObject({ records: 0 });
    await expect(handler({} as never)).resolves.toMatchObject({ records: 0 });
  });

  test('a writer failure propagates, so Lambda retries the whole batch', async () => {
    setWriter({ write: async () => { throw new Error('neptune down'); } });
    await expect(handler(mskEvent([traceMessage('a', [clientCall('b')])]))).rejects.toThrow('neptune down');
  });
});

describe('getWriter', () => {
  beforeEach(() => setWriter(undefined));

  test('defaults to the log writer', () => {
    expect(getWriter({})).toBeInstanceOf(LogWriter);
  });

  test('rejects unknown backends and gremlin without a URL', () => {
    expect(() => getWriter({ GRAPH_BACKEND: 'neo4j' })).toThrow(/Unknown GRAPH_BACKEND/);
    expect(() => getWriter({ GRAPH_BACKEND: 'gremlin' })).toThrow(/GREMLIN_URL/);
  });

  test('refuses IAM auth until Stage 9 implements it, instead of silently connecting unsigned', () => {
    expect(() => getWriter({ GRAPH_BACKEND: 'gremlin', GREMLIN_URL: 'wss://x:8182/gremlin', NEPTUNE_IAM_AUTH: 'true' })).toThrow(/Stage 9/);
  });
});
