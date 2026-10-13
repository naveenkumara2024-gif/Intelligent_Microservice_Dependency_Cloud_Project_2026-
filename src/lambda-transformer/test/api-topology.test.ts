import * as fs from 'node:fs';
import * as path from 'node:path';
import { bucketOf } from '../src/aggregate';
import { handleTopology } from '../src/api/handler';
import { buildTopology, MAX_EDGES } from '../src/api/topology';
import { EdgeCounters, GraphSnapshot, IncidentRecord, ScorerState } from '../src/scorer/types';
import { incident, resolved, T0 } from './alert-helpers';
import { apiDeps, event, FakeDoc } from './api-helpers';
import { FakeGraph } from './scorer-helpers';

const GOLDEN = path.join(__dirname, 'fixtures', 'api-topology.json');
const NOW = T0 + 2 * 60_000;

const hist = (ms: number, n: number): number[] => {
  const h = new Array(10).fill(0);
  h[bucketOf(ms)] = n;
  return h;
};
const edge = (um: string, dm: string, calls: number, avgMs: number): EdgeCounters => ({
  um,
  dm,
  calls,
  sumMs: calls * avgMs,
  hist: hist(avgMs, calls),
});
const snap = (edges: EdgeCounters[], nodes: GraphSnapshot['nodes'] = []): GraphSnapshot => ({ nodes, edges });
const open = (overrides: Partial<IncidentRecord>) => incident({ blast_radius: [], at_risk: [], ...overrides });

describe('buildTopology: figures', () => {
  test('edge average and p95 come from the cumulative counters, busiest edge first', () => {
    const t = buildTopology(snap([edge('a', 'b', 10, 4), edge('a', 'c', 200, 12)]), [], {}, NOW);
    expect(t.edges.map((e) => `${e.source}>${e.target}`)).toEqual(['a>c', 'a>b']);
    expect(t.edges[0]).toMatchObject({ call_count: 200, avg_latency_ms: 12 });
    expect(t.edges[0].p95_latency_ms).toBeGreaterThan(0);
    expect(t.generated_at_ms).toBe(NOW);
    expect(t.schema_version).toBe(1);
  });

  test('an edge with no calls has average 0 and a null p95, never NaN', () => {
    const t = buildTopology(snap([{ um: 'a', dm: 'b', calls: 0, sumMs: 0, hist: new Array(10).fill(0) }]), [], {}, NOW);
    expect(t.edges[0].avg_latency_ms).toBe(0);
    expect(t.edges[0].p95_latency_ms).toBeNull();
  });

  test('vertices come from Neptune, and an edge endpoint Neptune has not listed yet is still a node', () => {
    const t = buildTopology(snap([edge('a', 'ghost', 5, 2)], [{ name: 'a', asUm: 5, asDm: 0 }]), [], {}, NOW);
    expect(t.nodes.map((n) => n.id)).toEqual(['a', 'ghost']);
    expect(t.nodes[0]).toMatchObject({ calls_as_caller: 5, calls_as_callee: 0 });
    expect(t.nodes[1]).toMatchObject({ calls_as_caller: 0, calls_as_callee: 0 });
  });

  test('baselines are joined by service, null before the scorer has one', () => {
    const t = buildTopology(snap([edge('a', 'b', 5, 2)]), [], { b: { ms: 2.0004, n: 9 } }, NOW);
    expect(t.nodes.find((n) => n.id === 'b')!.baseline_ms).toBe(2);
    expect(t.nodes.find((n) => n.id === 'a')!.baseline_ms).toBeNull();
  });

  test('the response is bounded: the busiest edges survive and the cut is declared', () => {
    const many = Array.from({ length: MAX_EDGES + 25 }, (_, i) => edge('src', `dst-${i}`, i + 1, 3));
    const t = buildTopology(snap(many), [], {}, NOW);
    expect(t.edges).toHaveLength(MAX_EDGES);
    expect(t.truncated).toBe(true);
    expect(t.edges[0].call_count).toBe(MAX_EDGES + 25);
    expect(buildTopology(snap(many.slice(0, 3)), [], {}, NOW).truncated).toBe(false);
  });
});

describe('buildTopology: status overlay', () => {
  const graph = snap([edge('frontend', 'checkout', 50, 5), edge('checkout', 'payment', 50, 5), edge('frontend', 'catalog', 50, 5)]);
  const status = (t: ReturnType<typeof buildTopology>) => Object.fromEntries(t.nodes.map((n) => [n.id, n.status]));

  test('healthy by default', () => {
    expect(Object.values(status(buildTopology(graph, [], {}, NOW)))).toEqual(['healthy', 'healthy', 'healthy', 'healthy']);
  });

  test('root cause, blast radius and callers at risk', () => {
    const inc = open({ incident_id: 'i1', root_cause: 'payment', blast_radius: ['checkout'], at_risk: ['checkout', 'frontend'] });
    const t = buildTopology(graph, [inc], {}, NOW);
    expect(status(t)).toEqual({ catalog: 'healthy', checkout: 'affected', frontend: 'at_risk', payment: 'root_cause' });
    expect(t.nodes.find((n) => n.id === 'payment')!.incident_id).toBe('i1');
    expect(t.nodes.find((n) => n.id === 'catalog')!.incident_id).toBeNull();
    expect(t.open_incidents).toEqual(['i1']);
  });

  test('the strongest claim wins: a root cause outranks being at risk of another incident', () => {
    const a = open({ incident_id: 'a', root_cause: 'payment', at_risk: ['checkout'], opened_at_ms: T0 });
    const b = open({ incident_id: 'b', root_cause: 'checkout', opened_at_ms: T0 - 1000 });
    const t = buildTopology(graph, [a, b], {}, NOW);
    expect(status(t).checkout).toBe('root_cause');
    expect(t.nodes.find((n) => n.id === 'checkout')!.incident_id).toBe('b');
  });

  test('equal claims go to the newer incident', () => {
    const older = open({ incident_id: 'old', root_cause: 'x', at_risk: ['frontend'], opened_at_ms: T0 - 5000 });
    const newer = open({ incident_id: 'new', root_cause: 'y', at_risk: ['frontend'], opened_at_ms: T0 });
    const t = buildTopology(graph, [older, newer], {}, NOW);
    expect(t.nodes.find((n) => n.id === 'frontend')!.incident_id).toBe('new');
  });

  test('a resolved incident colours nothing and is not listed as open', () => {
    const t = buildTopology(graph, [resolved({ root_cause: 'payment' })], {}, NOW);
    expect(Object.values(status(t)).every((s) => s === 'healthy')).toBe(true);
    expect(t.open_incidents).toEqual([]);
  });
});

describe('GET /api/topology', () => {
  const state: ScorerState = {
    version: 3,
    windows: 40,
    counters: [],
    baselines: { frontend: { ms: 10, n: 40 }, productcatalogservice: { ms: 10, n: 40 } },
    trackers: {},
    updatedMs: T0,
  };

  async function boutique() {
    const g = new FakeGraph();
    for (let i = 0; i < 3; i++) g.advance(50, i === 2 ? { productcatalogservice: 6 } : {});
    return g;
  }

  test('503 with the documented body when no graph backend is configured', async () => {
    const res = await handleTopology(event('/api/topology'), apiDeps());
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'graph backend not configured' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('403 without the origin header, before any read', async () => {
    const graph = await boutique();
    const res = await handleTopology(event('/api/topology', { secret: null }), apiDeps({ graph }));
    expect(res.statusCode).toBe(403);
    expect(graph.reads).toBe(0);
  });

  test('200: graph + open incidents + baselines, cacheable for the configured seconds', async () => {
    const graph = await boutique();
    const doc = new FakeDoc();
    doc.items = [
      incident({
        incident_id: 'inc-1',
        root_cause: 'productcatalogservice',
        blast_radius: ['checkoutservice'],
        at_risk: ['frontend', 'recommendationservice', 'checkoutservice'],
      }),
    ];
    const res = await handleTopology(event('/api/topology'), apiDeps({ graph, doc, state }));

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=10');
    const body = JSON.parse(res.body);
    const byId = Object.fromEntries(body.nodes.map((n: { id: string }) => [n.id, n]));
    expect(byId.productcatalogservice).toMatchObject({ status: 'root_cause', incident_id: 'inc-1', baseline_ms: 10 });
    expect(byId.checkoutservice.status).toBe('affected');
    expect(byId.frontend).toMatchObject({ status: 'at_risk', baseline_ms: 10 });
    expect(byId.paymentservice.status).toBe('healthy');
    expect(body.open_incidents).toEqual(['inc-1']);
    expect(graph.reads).toBe(1);
    // the open-incident query is by status and bounded
    expect(doc.sent[0].input.IndexName).toBe('by-status');
    expect(doc.sent[0].input.ExpressionAttributeValues[':v']).toBe('OPEN');
  });

  test('works before the scorer has run (no state item yet): no baselines, still 200', async () => {
    const graph = await boutique();
    const res = await handleTopology(event('/api/topology'), apiDeps({ graph }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).nodes.every((n: { baseline_ms: number | null }) => n.baseline_ms === null)).toBe(true);
  });

  test('a Neptune or DynamoDB failure is a 502, not cached, nothing leaked', async () => {
    const graph = await boutique();
    graph.read = async () => {
      throw new Error('WebSocket handshake 403 wss://db-xyz.cluster-abc.us-east-1.neptune.amazonaws.com:8182/gremlin');
    };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handleTopology(event('/api/topology'), apiDeps({ graph }));
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('neptune.amazonaws.com');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('matches the golden file the dashboard reads', async () => {
    const graph = await boutique();
    const doc = new FakeDoc();
    doc.items = [
      incident({
        incident_id: `${T0}-productcatalogservice`,
        root_cause: 'productcatalogservice',
        blast_radius: ['checkoutservice'],
        at_risk: ['frontend', 'recommendationservice', 'checkoutservice'],
      }),
    ];
    const res = await handleTopology(event('/api/topology'), apiDeps({ graph, doc, state }));
    const actual = JSON.parse(res.body);
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    expect(JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))).toEqual(actual);
  });
});
