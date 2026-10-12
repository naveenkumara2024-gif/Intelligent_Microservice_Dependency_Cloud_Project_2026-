import { aggregate, BUCKET_COUNT, bucketOf, estimateP95 } from '../src/aggregate';
import { Call } from '../src/edges';

const call = (caller: string, callee: string, latencyMs: number, endMs = 1000): Call => ({ caller, callee, latencyMs, endMs });

describe('bucketOf', () => {
  test.each([
    [0, 0], [1, 0], [1.0001, 1], [2, 1], [5, 2], [10, 3], [20, 4], [50, 5], [100, 6], [200, 7], [500, 8], [500.01, 9], [60000, 9],
  ])('%p ms -> bucket %p', (ms, bucket) => {
    expect(bucketOf(ms)).toBe(bucket);
  });
});

describe('aggregate', () => {
  test('groups calls per (caller, callee) with count, sum, recent average, last seen and histogram', () => {
    const { edges } = aggregate([
      call('frontend', 'cartservice', 4, 1000),
      call('frontend', 'cartservice', 6, 3000),
      call('frontend', 'cartservice', 200, 2000),
      call('frontend', 'currencyservice', 1, 500),
    ]);
    expect(edges).toHaveLength(2);
    const cart = edges.find((e) => e.callee === 'cartservice')!;
    expect(cart.count).toBe(3);
    expect(cart.sumMs).toBe(210);
    expect(cart.recentAvgMs).toBe(70);
    expect(cart.lastSeenMs).toBe(3000);
    expect(cart.hist).toHaveLength(BUCKET_COUNT);
    expect(cart.hist[2]).toBe(1); // 4 ms  (<= 5)
    expect(cart.hist[3]).toBe(1); // 6 ms  (<= 10)
    expect(cart.hist[7]).toBe(1); // 200 ms
    expect(cart.hist.reduce((a, b) => a + b, 0)).toBe(cart.count);
  });

  test('direction matters: a->b and b->a are different edges', () => {
    expect(aggregate([call('a', 'b', 1), call('b', 'a', 1)]).edges).toHaveLength(2);
  });

  test('node counters: calls made as caller, calls received as callee, and callee-only nodes exist', () => {
    const { nodes } = aggregate([
      call('frontend', 'cartservice', 1),
      call('frontend', 'cartservice', 1),
      call('frontend', 'checkoutservice', 1),
      call('checkoutservice', 'cartservice', 1),
    ]);
    const byName = Object.fromEntries(nodes.map((n) => [n.name, n]));
    expect(byName.frontend).toMatchObject({ asCaller: 3, asCallee: 0 });
    expect(byName.checkoutservice).toMatchObject({ asCaller: 1, asCallee: 1 });
    // cartservice never reports spans itself, but is still a node via its callers
    expect(byName.cartservice).toMatchObject({ asCaller: 0, asCallee: 3 });
    expect(nodes).toHaveLength(3);
  });

  test('empty input gives an empty aggregate', () => {
    expect(aggregate([])).toEqual({ edges: [], nodes: [] });
  });

  test('self-calls are kept (Stage 2 data has self-edges) and count on both sides', () => {
    const { edges, nodes } = aggregate([call('a', 'a', 3)]);
    expect(edges).toHaveLength(1);
    expect(nodes).toEqual([{ name: 'a', asCaller: 1, asCallee: 1 }]);
  });
});

describe('estimateP95', () => {
  test('is the upper bound of the bucket holding the 95th percentile', () => {
    const hist = new Array(BUCKET_COUNT).fill(0);
    hist[2] = 94; // <= 5 ms
    hist[6] = 6; // <= 100 ms; 95th of 100 falls here
    expect(estimateP95(hist)).toBe(100);
    hist[2] = 95;
    hist[6] = 5; // exactly 95% at <= 5 ms
    expect(estimateP95(hist)).toBe(5);
  });

  test('reports the last finite bound for the open-ended bucket and undefined when empty', () => {
    const hist = new Array(BUCKET_COUNT).fill(0);
    hist[9] = 10;
    expect(estimateP95(hist)).toBe(500);
    expect(estimateP95(new Array(BUCKET_COUNT).fill(0))).toBeUndefined();
  });
});
