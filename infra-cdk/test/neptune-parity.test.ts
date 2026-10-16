import {
  compareStats,
  CsvEdge,
  CsvNode,
  distinctEdges,
  expectedStats,
  parseEdgesCsv,
  parseNodesCsv,
  selectSubset,
} from '../scripts/neptune-parity';

const node = (name: string, um = 0, dm = 0): CsvNode => ({ name, total_calls_as_um: um, total_calls_as_dm: dm });
const edge = (um: string, dm: string, call_count: number, rpctype = 'rpc'): CsvEdge => ({
  um,
  dm,
  call_count,
  avg_latency_ms: 1,
  p95_latency_ms: 2,
  rpctype,
});

describe('CSV parsing', () => {
  test('reads Stage 2 edges.csv, by column name, not position', () => {
    const text = 'um,dm,call_count,avg_latency_ms,p95_latency_ms,rpctype\nabc,def,190574,0.39,1.0,mc\n';
    expect(parseEdgesCsv(text)).toEqual([
      { um: 'abc', dm: 'def', call_count: 190574, avg_latency_ms: 0.39, p95_latency_ms: 1, rpctype: 'mc' },
    ]);
    const reordered = 'rpctype,call_count,um,dm,p95_latency_ms,avg_latency_ms\nmc,5,a,b,4,2\n';
    expect(parseEdgesCsv(reordered)[0]).toMatchObject({ um: 'a', dm: 'b', call_count: 5, avg_latency_ms: 2, p95_latency_ms: 4 });
  });

  test('reads Stage 2 nodes.csv and tolerates CRLF line endings', () => {
    const text = 'service_name,total_calls_as_um,total_calls_as_dm\r\nx,34408,1504\r\n';
    expect(parseNodesCsv(text)).toEqual([{ name: 'x', total_calls_as_um: 34408, total_calls_as_dm: 1504 }]);
  });

  test('rejects a missing column, a ragged row and a non-numeric value instead of guessing', () => {
    expect(() => parseEdgesCsv('um,dm,call_count\na,b,1\n')).toThrow(/missing columns/);
    expect(() => parseNodesCsv('service_name,total_calls_as_um,total_calls_as_dm\nx,1\n')).toThrow(/cells/);
    expect(() => parseNodesCsv('service_name,total_calls_as_um,total_calls_as_dm\nx,1,NaN\n')).toThrow(/finite/);
  });
});

describe('distinctEdges (Stage 2 MERGE semantics)', () => {
  const names = new Set(['a', 'b', 'c']);

  test('a repeated (um, dm) pair collapses and the last row wins', () => {
    const out = distinctEdges([edge('a', 'b', 1, 'rpc'), edge('a', 'b', 9, 'db'), edge('b', 'c', 3)], names);
    expect(out).toHaveLength(2);
    expect(out.find((e) => e.um === 'a')).toMatchObject({ call_count: 9, rpctype: 'db' });
  });

  test('an edge whose endpoint is not a node is dropped, as MATCH would', () => {
    expect(distinctEdges([edge('a', 'zzz', 1), edge('a', 'b', 2)], names)).toEqual([edge('a', 'b', 2)]);
  });

  test('keeps self-loops', () => {
    expect(distinctEdges([edge('a', 'a', 5)], names)).toHaveLength(1);
  });
});

describe('selectSubset', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map((n, i) => node(n, i, i * 2));
  const edges = [edge('a', 'b', 10), edge('c', 'd', 50), edge('b', 'c', 50), edge('d', 'e', 1)];

  test('takes the highest call_count edges, ties broken by um then dm', () => {
    const { edges: chosen } = selectSubset(edges, nodes, 2);
    expect(chosen.map((e) => `${e.um}>${e.dm}`)).toEqual(['b>c', 'c>d']); // both 50; 'b' sorts before 'c'
  });

  test('returns exactly the endpoint nodes of the chosen edges', () => {
    const { nodes: chosen } = selectSubset(edges, nodes, 2);
    expect(chosen.map((n) => n.name).sort()).toEqual(['b', 'c', 'd']);
  });

  test('no limit means the whole graph', () => {
    const all = selectSubset(edges, nodes);
    expect(all.edges).toHaveLength(4);
    expect(all.nodes).toHaveLength(5);
  });

  test('is deterministic regardless of input order', () => {
    const shuffled = [...edges].reverse();
    expect(selectSubset(shuffled, nodes, 3)).toEqual(selectSubset(edges, nodes, 3));
  });
});

describe('expectedStats', () => {
  const nodes = [node('a', 10, 1), node('b', 5, 10), node('c', 0, 7)];

  test('counts, sums and degrees, with a self-loop counted once out and once in on the same node', () => {
    const s = expectedStats(nodes, [edge('a', 'b', 100), edge('b', 'c', 40), edge('c', 'c', 7)]);
    expect(s.nodes).toBe(3);
    expect(s.edges).toBe(3);
    expect(s.callCountSum).toBe(147);
    expect(s.totalCallsAsUmSum).toBe(15);
    expect(s.totalCallsAsDmSum).toBe(18);
    expect(s.degrees).toEqual({ a: [1, 0], b: [1, 1], c: [1, 2] });
  });

  test('top 10 is limited to ten and ordered by call_count then names', () => {
    const many = Array.from({ length: 15 }, (_, i) => edge('a', `n${String(i).padStart(2, '0')}`, 100 - i));
    const s = expectedStats([node('a')], many);
    expect(s.top10).toHaveLength(10);
    expect(s.top10[0].call_count).toBe(100);
    expect(s.top10[9].call_count).toBe(91);
  });

  test('an empty graph is all zeros', () => {
    expect(expectedStats([], [])).toMatchObject({ nodes: 0, edges: 0, callCountSum: 0, degrees: {}, top10: [] });
  });
});

describe('compareStats', () => {
  const nodes = [node('a', 1, 0), node('b', 0, 1)];
  const edges = [edge('a', 'b', 5)];
  const want = expectedStats(nodes, edges);

  test('an identical graph passes every check', () => {
    const checks = compareStats('Neptune vs CSV', want, structuredClone(want));
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'Neptune vs CSV: node count',
        'Neptune vs CSV: distinct edge count',
        'Neptune vs CSV: per-node out/in degree',
        'Neptune vs CSV: top 10 edges by call_count',
      ]),
    );
  });

  test('a missing edge fails the edge count, the call_count sum, the degrees and the top 10', () => {
    const got = expectedStats(nodes, []);
    const failed = compareStats('x', want, got).filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(
      expect.arrayContaining(['x: distinct edge count', 'x: sum of call_count', 'x: per-node out/in degree', 'x: top 10 edges by call_count']),
    );
  });

  test('an extra node in the actual graph is reported, not ignored', () => {
    const got = structuredClone(want);
    got.degrees.ghost = [0, 0];
    const degree = compareStats('x', want, got).find((c) => c.name.endsWith('out/in degree'))!;
    expect(degree.ok).toBe(false);
    expect(degree.detail).toContain('ghost');
  });
});
