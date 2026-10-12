// The writer's connection handling with a mocked driver: no server, no network. It checks what the
// real driver is handed (signed headers), when connections open, and that a lost connection is
// re-opened with a FRESH signature (a signature is only valid at the WebSocket handshake).
import { aggregate } from '../src/aggregate';

const connections: Array<{ url: string; options: any; closed: boolean }> = [];
let iterate: jest.Mock;

jest.mock('gremlin', () => {
  // Any traversal chain: every step returns the chain; iterate() is the test's hook.
  const chain: any = new Proxy(function () {}, {
    // `then` must be undefined, or `await chain` treats the proxy as a thenable and never settles.
    get: (_t, prop) => (prop === 'iterate' ? (...a: unknown[]) => iterate(...a) : prop === 'then' ? undefined : chain),
    apply: () => chain,
  });
  return {
    driver: {
      DriverRemoteConnection: class {
        record: { url: string; options: any; closed: boolean };
        constructor(url: string, options: any) {
          this.record = { url, options, closed: false };
          connections.push(this.record);
        }
        async close() {
          this.record.closed = true;
        }
      },
    },
    process: {
      AnonymousTraversalSource: { traversal: () => ({ withRemote: () => chain }) },
      statics: chain,
      cardinality: { single: 'single' },
      t: { label: 'label' },
    },
  };
});

// Imported after the mock is registered (jest hoists jest.mock above imports).
import { GremlinWriter } from '../src/writers/gremlin';

const credentials = async () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret', sessionToken: 'tok' });
const URL = 'wss://neptune.example:8182/gremlin';
const batch = aggregate([{ caller: 'a', callee: 'b', latencyMs: 4, endMs: 1 }]);

beforeEach(() => {
  connections.length = 0;
  iterate = jest.fn().mockResolvedValue(undefined);
});

describe('GremlinWriter connection handling', () => {
  test('unauthenticated: connects immediately, with no headers', () => {
    new GremlinWriter({ url: 'ws://localhost:8182/gremlin' });
    expect(connections).toHaveLength(1);
    expect(connections[0].options).toEqual({});
  });

  test('iamAuth: construction does not throw and does not connect until first use', () => {
    expect(() => new GremlinWriter({ url: URL, iamAuth: true, credentials })).not.toThrow();
    expect(connections).toHaveLength(0);
  });

  test('iamAuth: `source` explains itself before the first connection instead of returning undefined', () => {
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    expect(() => w.source).toThrow(/connectedSource/);
  });

  test('iamAuth: the first write opens one connection handed SigV4 headers for neptune-db', async () => {
    const w = new GremlinWriter({ url: URL, iamAuth: true, region: 'us-east-1', credentials });
    await w.write(batch);

    expect(connections).toHaveLength(1);
    const { headers } = connections[0].options;
    expect(headers.host).toBe('neptune.example:8182');
    expect(headers['x-amz-security-token']).toBe('tok');
    expect(headers.authorization).toMatch(/Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/neptune-db\/aws4_request/);
  });

  test('iamAuth: later writes reuse the connection (one signature per connection, not per request)', async () => {
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    await w.write(batch);
    await w.write(batch);
    expect(connections).toHaveLength(1);
  });

  test('a lost connection is closed and re-opened with fresh signed headers, then the write succeeds', async () => {
    iterate.mockRejectedValueOnce(new Error('read ECONNRESET')).mockResolvedValue(undefined);
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    await expect(w.write(batch)).resolves.toEqual({ nodes: 2, edges: 1 });

    expect(connections).toHaveLength(2);
    expect(connections[0].closed).toBe(true);
    expect(connections[1].options.headers.authorization).toBeDefined();
  });

  test('a concurrent-modification error retries on the SAME connection', async () => {
    iterate.mockRejectedValueOnce(new Error('ConcurrentModificationException')).mockResolvedValue(undefined);
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    await w.write(batch);
    expect(connections).toHaveLength(1);
  });

  test('an authentication failure is not retried', async () => {
    iterate.mockRejectedValue(new Error('Unexpected server response: 403'));
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    await expect(w.write(batch)).rejects.toThrow(/403/);
    expect(iterate).toHaveBeenCalledTimes(1);
  });

  test('close() closes the connection and a later write opens a new one', async () => {
    const w = new GremlinWriter({ url: URL, iamAuth: true, credentials });
    await w.write(batch);
    await w.close();
    expect(connections[0].closed).toBe(true);
    await w.write(batch);
    expect(connections).toHaveLength(2);
  });
});
