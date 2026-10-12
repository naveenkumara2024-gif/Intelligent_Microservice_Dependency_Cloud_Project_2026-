// Pure logic for the Stage 9b parity check: Stage 2's processed CSVs -> the subset to load into
// Neptune and the statistics Neptune (and Neo4j) must then report. No AWS, no I/O: unit-tested in
// test/neptune-parity.test.ts. The Lambda probe computes the *actual* side (probe-actions.ts).
import type { Check } from './aws-cli';

export interface CsvNode {
  name: string;
  total_calls_as_um: number;
  total_calls_as_dm: number;
}

export interface CsvEdge {
  um: string;
  dm: string;
  call_count: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
  rpctype: string;
}

export interface TopEdge {
  um: string;
  dm: string;
  call_count: number;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  callCountSum: number;
  totalCallsAsUmSum: number;
  totalCallsAsDmSum: number;
  /** service name -> [out-degree, in-degree] */
  degrees: Record<string, [number, number]>;
  top10: TopEdge[];
}

function table(text: string, required: string[]): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty CSV');
  const header = lines[0].split(',').map((h) => h.trim());
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`CSV is missing columns: ${missing.join(', ')} (has: ${header.join(', ')})`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split(',');
    if (cells.length !== header.length) {
      throw new Error(`CSV row ${i + 2} has ${cells.length} cells, expected ${header.length}`);
    }
    return Object.fromEntries(header.map((h, j) => [h, cells[j].trim()]));
  });
}

function finite(value: string, what: string, row: number): number {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n)) throw new Error(`row ${row}: ${what} is not a finite number: "${value}"`);
  return n;
}

export function parseNodesCsv(text: string): CsvNode[] {
  return table(text, ['service_name', 'total_calls_as_um', 'total_calls_as_dm']).map((r, i) => ({
    name: r.service_name,
    total_calls_as_um: finite(r.total_calls_as_um, 'total_calls_as_um', i + 2),
    total_calls_as_dm: finite(r.total_calls_as_dm, 'total_calls_as_dm', i + 2),
  }));
}

export function parseEdgesCsv(text: string): CsvEdge[] {
  return table(text, ['um', 'dm', 'call_count', 'avg_latency_ms', 'p95_latency_ms', 'rpctype']).map((r, i) => ({
    um: r.um,
    dm: r.dm,
    call_count: finite(r.call_count, 'call_count', i + 2),
    avg_latency_ms: finite(r.avg_latency_ms, 'avg_latency_ms', i + 2),
    p95_latency_ms: finite(r.p95_latency_ms, 'p95_latency_ms', i + 2),
    rpctype: r.rpctype,
  }));
}

const byRank = (a: CsvEdge, b: CsvEdge): number =>
  b.call_count - a.call_count || (a.um < b.um ? -1 : a.um > b.um ? 1 : 0) || (a.dm < b.dm ? -1 : a.dm > b.dm ? 1 : 0);

/**
 * Stage 2 loaded with `MERGE (a)-[r:CALLS]->(b) SET r.*`, which keys an edge on (um, dm) only: a
 * repeated pair collapses and the LAST row's properties win. `MATCH` on both endpoints also drops
 * any edge whose endpoint is not a loaded node.
 */
export function distinctEdges(edges: CsvEdge[], nodeNames: Set<string>): CsvEdge[] {
  const byPair = new Map<string, CsvEdge>();
  for (const e of edges) {
    if (!nodeNames.has(e.um) || !nodeNames.has(e.dm)) continue;
    byPair.set(`${e.um}\u0000${e.dm}`, e);
  }
  return [...byPair.values()];
}

/**
 * The deterministic subset both sides agree on: the `limit` highest call_count edges (ties broken
 * by um, then dm, the same ORDER BY used against Neo4j), with exactly their endpoint nodes.
 * `limit` undefined means the whole graph.
 */
export function selectSubset(
  edges: CsvEdge[],
  nodes: CsvNode[],
  limit?: number,
): { nodes: CsvNode[]; edges: CsvEdge[] } {
  const names = new Set(nodes.map((n) => n.name));
  const ranked = distinctEdges(edges, names).sort(byRank);
  const chosen = limit === undefined ? ranked : ranked.slice(0, limit);
  const endpoints = new Set<string>();
  for (const e of chosen) {
    endpoints.add(e.um);
    endpoints.add(e.dm);
  }
  return { edges: chosen, nodes: nodes.filter((n) => endpoints.has(n.name)) };
}

/** What a correct graph holding exactly `nodes` and `edges` must report. */
export function expectedStats(nodes: CsvNode[], edges: Pick<CsvEdge, 'um' | 'dm' | 'call_count'>[]): GraphStats {
  const degrees: Record<string, [number, number]> = {};
  for (const n of nodes) degrees[n.name] = [0, 0];
  for (const e of edges) {
    (degrees[e.um] ??= [0, 0])[0]++;
    (degrees[e.dm] ??= [0, 0])[1]++; // a self-loop counts once out and once in, on the same node
  }
  const top10 = [...edges]
    .sort((a, b) => b.call_count - a.call_count || (a.um < b.um ? -1 : a.um > b.um ? 1 : 0) || (a.dm < b.dm ? -1 : a.dm > b.dm ? 1 : 0))
    .slice(0, 10)
    .map((e) => ({ um: e.um, dm: e.dm, call_count: e.call_count }));
  return {
    nodes: nodes.length,
    edges: edges.length,
    callCountSum: edges.reduce((s, e) => s + e.call_count, 0),
    totalCallsAsUmSum: nodes.reduce((s, n) => s + n.total_calls_as_um, 0),
    totalCallsAsDmSum: nodes.reduce((s, n) => s + n.total_calls_as_dm, 0),
    degrees,
    top10,
  };
}

/** Compares an observed graph against an expectation, one named check per property. */
export function compareStats(label: string, expected: GraphStats, actual: GraphStats): Check[] {
  const checks: Check[] = [];
  const scalar = (name: string, want: number, got: number) =>
    checks.push({ name: `${label}: ${name}`, ok: want === got, detail: `${got} (expected ${want})` });
  scalar('node count', expected.nodes, actual.nodes);
  scalar('distinct edge count', expected.edges, actual.edges);
  scalar('sum of call_count', expected.callCountSum, actual.callCountSum);
  scalar('sum of total_calls_as_um', expected.totalCallsAsUmSum, actual.totalCallsAsUmSum);
  scalar('sum of total_calls_as_dm', expected.totalCallsAsDmSum, actual.totalCallsAsDmSum);

  const wrong: string[] = [];
  const names = new Set([...Object.keys(expected.degrees), ...Object.keys(actual.degrees)]);
  for (const name of names) {
    const want = expected.degrees[name];
    const got = actual.degrees[name];
    if (!want || !got || want[0] !== got[0] || want[1] !== got[1]) {
      wrong.push(`${name.slice(0, 12)}…: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }
  checks.push({
    name: `${label}: per-node out/in degree`,
    ok: wrong.length === 0,
    detail: wrong.length === 0 ? `all ${names.size} nodes match` : `${wrong.length} of ${names.size} differ, e.g. ${wrong.slice(0, 3).join('; ')}`,
  });

  const sameTop =
    expected.top10.length === actual.top10.length &&
    expected.top10.every((e, i) => e.um === actual.top10[i].um && e.dm === actual.top10[i].dm && e.call_count === actual.top10[i].call_count);
  checks.push({
    name: `${label}: top 10 edges by call_count`,
    ok: sameTop,
    detail: sameTop
      ? `identical; busiest ${expected.top10[0]?.call_count ?? 'n/a'}`
      : `expected ${JSON.stringify(expected.top10.slice(0, 3))}… got ${JSON.stringify(actual.top10.slice(0, 3))}…`,
  });
  return checks;
}
