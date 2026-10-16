// Offline checks of the Gremlin writer: the traversals it builds, inspected as bytecode without
// any server. The real behaviour (idempotency, counters) is covered by gremlin.int.test.ts.
import gremlin from 'gremlin';
import { aggregate } from '../src/aggregate';
import { edgeTraversal, isConnectionError, isRetryable, nodeTraversal } from '../src/writers/gremlin';

// A traversal source with no server behind it: enough to build traversals and read their bytecode.
const g = () => gremlin.process.AnonymousTraversalSource.traversal().withGraph(new gremlin.structure.Graph());
const steps = (t: any): string[] => t.getBytecode().stepInstructions.map((s: any[]) => s[0]);

const batch = aggregate([
  { caller: 'frontend', callee: 'cartservice', latencyMs: 4, endMs: 100 },
  { caller: 'frontend', callee: 'cartservice', latencyMs: 600, endMs: 200 },
]);

describe('nodeTraversal', () => {
  test('one mergeV per node, with counter increments only for the roles a node plays', () => {
    const s = steps(nodeTraversal(g(), batch.nodes));
    expect(s.filter((x) => x === 'mergeV')).toHaveLength(2);
    // frontend is only a caller, cartservice only a callee: one counter property each
    expect(s.filter((x) => x === 'property')).toHaveLength(2);
  });
});

describe('edgeTraversal', () => {
  test('looks both endpoints up by name, then upserts the edge with coalesce(inE, addE)', () => {
    const s = steps(edgeTraversal(g(), batch.edges));
    expect(s.slice(0, 5)).toEqual(['V', 'has', 'as', 'V', 'has']);
    expect(s).toContain('coalesce');
    expect(s.indexOf('coalesce')).toBeGreaterThan(s.indexOf('as', 3));
  });

  test('writes counters, the recent average, last-seen and only the non-empty histogram buckets', () => {
    const t = edgeTraversal(g(), batch.edges);
    const written = t.getBytecode().stepInstructions
      .filter((s: any[]) => s[0] === 'property')
      // edge properties are [name, key, value]: no cardinality argument (a real server rejects one on an edge)
      .map((s: any[]) => s[1]);
    expect(written).toEqual(
      expect.arrayContaining(['call_count', 'latency_sum_ms', 'latency_recent_avg_ms', 'last_seen_ms', 'h2', 'h9']),
    );
    expect(written).not.toContain('h0'); // empty buckets are not written
    // no property step on an edge may carry a cardinality
    const cardinalityOnEdge = t.getBytecode().stepInstructions.some((s: any[]) => s[0] === 'property' && typeof s[1] !== 'string');
    expect(cardinalityOnEdge).toBe(false);
  });

  test('chains several edges into one traversal (one request, not one per edge)', () => {
    const many = aggregate([
      { caller: 'a', callee: 'b', latencyMs: 1, endMs: 1 },
      { caller: 'a', callee: 'c', latencyMs: 1, endMs: 1 },
      { caller: 'b', callee: 'c', latencyMs: 1, endMs: 1 },
    ]);
    expect(steps(edgeTraversal(g(), many.edges)).filter((x) => x === 'coalesce')).toHaveLength(3);
  });
});

describe('isRetryable', () => {
  test.each([
    'ConcurrentModificationException: element changed',
    'Operation terminated: ConcurrentUpdate',
    'Request timed out',
    'read ECONNRESET',
  ])('retries %p', (msg) => expect(isRetryable(new Error(msg))).toBe(true));

  test.each([
    'MalformedQueryException',
    'Authentication failed',
    // a query-level authorization failure on an OPEN connection: retrying cannot help
    'Server error: User: arn:aws:sts::1:assumed-role/r/f is not authorized to perform: neptune-db:DeleteDataViaQuery (403)',
  ])('does not retry %p', (msg) => expect(isRetryable(new Error(msg))).toBe(false));

  // a rejected opening handshake means a stale/invalid signature: re-sign on a new connection
  test.each(['Unexpected server response: 403', 'Unexpected server response: 401'])('retries %p', (msg) =>
    expect(isRetryable(new Error(msg))).toBe(true),
  );
});

describe('isConnectionError', () => {
  test.each(['read ECONNRESET', 'connect ECONNREFUSED 10.0.0.1:8182', 'write EPIPE', 'socket hang up', 'WebSocket is not open'])(
    'a lost socket (%p) needs a new, re-signed connection',
    (msg) => expect(isConnectionError(new Error(msg))).toBe(true),
  );

  test.each(['Unexpected server response: 403', 'Unexpected server response: 401'])(
    'a rejected handshake (%p) needs a new, re-signed connection',
    (msg) => expect(isConnectionError(new Error(msg))).toBe(true),
  );

  test.each(['ConcurrentModificationException', 'Request timed out'])(
    'a server-side error (%p) keeps the connection',
    (msg) => expect(isConnectionError(new Error(msg))).toBe(false),
  );
});
