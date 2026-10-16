import { GremlinGraphSource } from '../src/scorer/graph';
import { GraphSnapshot } from '../src/scorer/types';

const snapshot: GraphSnapshot = { nodes: [], edges: [] };

function fakeClient(behaviours: (() => Promise<unknown>)[]) {
  let opens = 0;
  let closes = 0;
  return {
    get opens() { return opens; },
    get closes() { return closes; },
    async connectedSource() {
      const next = behaviours[Math.min(opens, behaviours.length - 1)];
      opens++;
      return next;
    },
    async close() {
      closes++;
    },
  };
}

describe('GremlinGraphSource', () => {
  test('a hung connection (frozen socket after a Lambda thaw) times out, is dropped, and the retry succeeds', async () => {
    const client = fakeClient([() => new Promise(() => undefined), async () => 'ok']);
    const source = new GremlinGraphSource(client as any, 50, async (g: any) => {
      await g();
      return snapshot;
    });
    await expect(source.read()).resolves.toBe(snapshot);
    expect(client.closes).toBe(1);
    expect(client.opens).toBe(2);
  });

  test('a connection error drops the connection and retries', async () => {
    const client = fakeClient([async () => { throw new Error('socket hang up'); }, async () => 'ok']);
    const source = new GremlinGraphSource(client as any, 1000, async (g: any) => {
      await g();
      return snapshot;
    });
    await expect(source.read()).resolves.toBe(snapshot);
    expect(client.closes).toBe(1);
  });

  test('gives up after three attempts and surfaces the error', async () => {
    const client = fakeClient([() => new Promise(() => undefined)]);
    const source = new GremlinGraphSource(client as any, 20, async (g: any) => {
      await g();
      return snapshot;
    });
    await expect(source.read()).rejects.toThrow(/timed out/);
    expect(client.opens).toBe(3);
  });

  test('a query-level failure (not a connection problem) is not retried', async () => {
    const client = fakeClient([async () => { throw new Error('not authorized to perform: neptune-db:ReadDataViaQuery'); }]);
    const source = new GremlinGraphSource(client as any, 1000, async (g: any) => {
      await g();
      return snapshot;
    });
    await expect(source.read()).rejects.toThrow(/not authorized/);
    expect(client.opens).toBe(1);
    expect(client.closes).toBe(0);
  });
});
