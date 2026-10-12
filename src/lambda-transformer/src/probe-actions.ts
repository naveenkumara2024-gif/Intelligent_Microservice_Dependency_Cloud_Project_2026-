// Graph operations used by the Stage 9 verification probe (src/probe.ts). They take a traversal
// source, so the same code runs against Neptune (9b) and a local Gremlin Server (integration
// tests), which is how the Gremlin is checked before any Neptune hour is spent.
import gremlin from 'gremlin';
import { aggregate, Aggregate } from './aggregate';
import { GraphWriter } from './writers/types';

const __ = gremlin.process.statics;
const { single } = gremlin.process.cardinality;
const { label: T_LABEL } = gremlin.process.t;
const { order } = gremlin.process;
const { TextP } = gremlin.process;

const NODE_CHUNK = 50;
const EDGE_CHUNK = 20;
const DROP_CHUNK = 1000;
/** Names the self-tests create; everything under this prefix is theirs to delete. */
export const PROBE_PREFIX = '__probe_';

/** A Stage 2 node row (Dataset/processed/nodes.csv). */
export interface LoadNode {
  name: string;
  total_calls_as_um: number;
  total_calls_as_dm: number;
}

/** A Stage 2 edge row (Dataset/processed/edges.csv), one per distinct (um, dm). */
export interface LoadEdge {
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

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Reported as a warning instead of a failure: a finding about behaviour, not a broken contract. */
  informational?: boolean;
}

const num = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));
const field = (row: any, key: string): any => (row instanceof Map ? row.get(key) : row[key]);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Stage 2 `MERGE ... SET` semantics: upsert the node and overwrite its properties. */
export function loadNodesTraversal(g: any, nodes: LoadNode[]): any {
  let t: any = g;
  for (const n of nodes) {
    t = t
      .mergeV(new Map<any, any>([[T_LABEL, 'Service'], ['name', n.name]]))
      .property(single, 'total_calls_as_um', n.total_calls_as_um)
      .property(single, 'total_calls_as_dm', n.total_calls_as_dm);
  }
  return t;
}

/** Stage 2 `MERGE (a)-[r:CALLS]->(b) SET r.*`: one edge per (um, dm), properties overwritten. */
export function loadEdgesTraversal(g: any, edges: LoadEdge[]): any {
  let t: any = g;
  for (const e of edges) {
    t = t
      .V().has('Service', 'name', e.um).as('a')
      .V().has('Service', 'name', e.dm).as('b')
      .coalesce(__.inE('CALLS').where(__.outV().as('a')), __.addE('CALLS').from_('a').to('b'))
      // Edge properties take no cardinality argument.
      .property('call_count', e.call_count)
      .property('avg_latency_ms', e.avg_latency_ms)
      .property('p95_latency_ms', e.p95_latency_ms)
      .property('rpctype', e.rpctype);
  }
  return t;
}

export async function loadGraph(g: any, nodes: LoadNode[], edges: LoadEdge[]): Promise<{ nodes: number; edges: number }> {
  for (const part of chunks(nodes, NODE_CHUNK)) await loadNodesTraversal(g, part).iterate();
  for (const part of chunks(edges, EDGE_CHUNK)) await loadEdgesTraversal(g, part).iterate();
  return { nodes: nodes.length, edges: edges.length };
}

/** Drops every vertex (and so every edge), in chunks so a large graph cannot hit the query timeout. */
export async function clearGraph(g: any): Promise<number> {
  let dropped = 0;
  for (;;) {
    const remaining = num((await g.V().count().next()).value);
    if (remaining === 0) return dropped;
    await g.V().limit(DROP_CHUNK).drop().iterate();
    dropped += Math.min(DROP_CHUNK, remaining);
  }
}

async function dropProbeVertices(g: any): Promise<void> {
  await g.V().has('Service', 'name', TextP.startingWith(PROBE_PREFIX)).drop().iterate();
}

/** Read-only summary used for the parity check; ties in the top 10 are broken by (um, dm) name. */
export async function graphStats(g: any): Promise<GraphStats> {
  const nodes = num((await g.V().hasLabel('Service').count().next()).value);
  const edges = num((await g.E().hasLabel('CALLS').count().next()).value);
  const callCountSum = num((await g.E().hasLabel('CALLS').values('call_count').sum().next()).value);
  const totalCallsAsUmSum = num((await g.V().hasLabel('Service').values('total_calls_as_um').sum().next()).value);
  const totalCallsAsDmSum = num((await g.V().hasLabel('Service').values('total_calls_as_dm').sum().next()).value);

  const degreeRows = await g.V().hasLabel('Service').project('n', 'o', 'i')
    .by('name').by(__.outE('CALLS').count()).by(__.inE('CALLS').count()).toList();
  const degrees: Record<string, [number, number]> = {};
  for (const row of degreeRows) degrees[String(field(row, 'n'))] = [num(field(row, 'o')), num(field(row, 'i'))];

  const topRows = await g.E().hasLabel('CALLS')
    .order()
    .by('call_count', order.desc)
    .by(__.outV().values('name'), order.asc)
    .by(__.inV().values('name'), order.asc)
    .limit(10)
    .project('um', 'dm', 'c').by(__.outV().values('name')).by(__.inV().values('name')).by('call_count')
    .toList();
  const top10 = topRows.map((r: any) => ({ um: String(field(r, 'um')), dm: String(field(r, 'dm')), call_count: num(field(r, 'c')) }));

  return { nodes, edges, callCountSum, totalCallsAsUmSum, totalCallsAsDmSum, degrees, top10 };
}

// --- Self-tests of the production writer -------------------------------------------------------

const call = (caller: string, callee: string, latencyMs: number) => ({ caller, callee, latencyMs, endMs: 1_700_000_000_000 });

/** Same batch as the local integration test: 2 x 4 ms and 1 x 600 ms a->b, plus one b->c. */
export function smokeBatch(): Aggregate {
  const a = `${PROBE_PREFIX}a`;
  const b = `${PROBE_PREFIX}b`;
  const c = `${PROBE_PREFIX}c`;
  return aggregate([call(a, b, 4), call(a, b, 4), call(a, b, 600), call(b, c, 10)]);
}

async function edgeProps(g: any, from: string, to: string): Promise<Record<string, any> | undefined> {
  const rows = await g.V().has('Service', 'name', from).outE('CALLS').where(__.inV().has('name', to)).valueMap().toList();
  if (rows.length !== 1) return undefined;
  const out: Record<string, any> = {};
  for (const [k, v] of rows[0] as Map<string, unknown>) out[String(k)] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

/**
 * The checks a mock cannot make: the real writer, run twice against the real engine, produces the
 * documented structure and additive counters. Cleans up after itself.
 */
export async function smokeTest(writer: GraphWriter, g: any): Promise<Check[]> {
  const a = `${PROBE_PREFIX}a`;
  const b = `${PROBE_PREFIX}b`;
  const c = `${PROBE_PREFIX}c`;
  const checks: Check[] = [];
  await dropProbeVertices(g);
  try {
    const batch = smokeBatch();
    await writer.write(batch);
    await writer.write(batch);

    const named = TextP.startingWith(PROBE_PREFIX);
    const vertices = num((await g.V().has('Service', 'name', named).count().next()).value);
    const edgeCount = num((await g.V().has('Service', 'name', named).outE('CALLS').count().next()).value);
    checks.push({ name: 'idempotent structure after 2 identical writes', ok: vertices === 3 && edgeCount === 2, detail: `${vertices} vertices (want 3), ${edgeCount} edges (want 2)` });

    const ab = await edgeProps(g, a, b);
    // 2 writes x (2 x 4 ms + 600 ms) = 1216 ms over 6 calls
    checks.push({
      name: 'edge counters are additive (property(key, traversal) on an edge)',
      ok: !!ab && ab.call_count === 6 && Math.abs(num(ab.latency_sum_ms) - 1216) < 0.001,
      detail: ab ? `call_count=${ab.call_count} (want 6), latency_sum_ms=${ab.latency_sum_ms} (want 1216)` : 'edge a->b missing or duplicated',
    });
    checks.push({
      name: 'latency histogram buckets are additive',
      ok: !!ab && ab.h2 === 4 && ab.h9 === 2 && ab.h0 === undefined,
      detail: ab ? `h2=${ab.h2} (want 4), h9=${ab.h9} (want 2), h0=${ab.h0} (want undefined)` : 'edge a->b missing',
    });

    const counters = async (name: string) => (await g.V().has('Service', 'name', name).valueMap('total_calls_as_um', 'total_calls_as_dm').toList())[0] as Map<string, any[]> | undefined;
    const bCounters = await counters(b);
    const bUm = bCounters ? num(bCounters.get('total_calls_as_um')?.[0]) : -1;
    const bDm = bCounters ? num(bCounters.get('total_calls_as_dm')?.[0]) : -1;
    checks.push({ name: 'node counters are additive', ok: bUm === 2 && bDm === 6, detail: `b: as_um=${bUm} (want 2), as_dm=${bDm} (want 6)` });
    const cCounters = await counters(c);
    const cDm = cCounters ? num(cCounters.get('total_calls_as_dm')?.[0]) : -1;
    checks.push({ name: 'a callee that never reports spans still gets counters', ok: cDm === 2, detail: `c: as_dm=${cDm} (want 2)` });
  } finally {
    await dropProbeVertices(g);
  }
  return checks;
}

/**
 * Concurrent writers hitting one edge. Warm: the vertices and edge already exist, so only the
 * counters race (the ConcurrentModification retry path must make the total exact). Cold: nothing
 * exists yet, so the create races too; duplicates there are reported as a finding, not a failure.
 */
export async function concurrencyTest(makeWriter: () => GraphWriter, g: any, writers: number): Promise<Check[]> {
  const x = `${PROBE_PREFIX}x`;
  const y = `${PROBE_PREFIX}y`;
  const perWriter = 5;
  const batch = aggregate(Array.from({ length: perWriter }, () => call(x, y, 4)));
  const checks: Check[] = [];

  const run = async () => {
    const instances = Array.from({ length: writers }, makeWriter);
    try {
      await Promise.all(instances.map((w) => w.write(batch)));
    } finally {
      await Promise.all(instances.map((w) => w.close?.()));
    }
  };
  const observe = async () => {
    const vertices = num((await g.V().has('Service', 'name', TextP.startingWith(PROBE_PREFIX)).count().next()).value);
    const edgeRows = await g.V().has('Service', 'name', x).outE('CALLS').valueMap('call_count').toList();
    const total = edgeRows.reduce((s: number, r: Map<string, unknown>) => s + num(r.get('call_count')), 0);
    return { vertices, edges: edgeRows.length, total };
  };

  await dropProbeVertices(g);
  try {
    const seed = makeWriter();
    try {
      await seed.write(batch); // creates the two vertices and the edge, count = perWriter
    } finally {
      await seed.close?.();
    }
    await run();
    const warm = await observe();
    const want = perWriter * (writers + 1);
    checks.push({
      name: `${writers} concurrent writers on an existing edge: exact total`,
      ok: warm.vertices === 2 && warm.edges === 1 && warm.total === want,
      detail: `${warm.vertices} vertices (want 2), ${warm.edges} edges (want 1), call_count=${warm.total} (want ${want})`,
    });

    await dropProbeVertices(g);
    await run();
    const cold = await observe();
    checks.push({
      name: `${writers} concurrent writers creating the edge from nothing`,
      ok: cold.vertices === 2 && cold.edges === 1 && cold.total === perWriter * writers,
      detail: `${cold.vertices} vertices (want 2), ${cold.edges} edges (want 1), call_count=${cold.total} (want ${perWriter * writers})`,
      informational: true,
    });
  } finally {
    await dropProbeVertices(g);
  }
  return checks;
}
