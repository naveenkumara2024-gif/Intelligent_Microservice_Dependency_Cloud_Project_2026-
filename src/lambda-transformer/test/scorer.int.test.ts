// Integration test: the scorer against a REAL Gremlin Server (counters written by the production
// GremlinWriter) and a REAL DynamoDB (Local), with a stub model. Start both with:
//   docker compose --profile gremlin --profile dynamodb up -d gremlin-server dynamodb-local
//   npm run test:integration
// What it cannot prove: Neptune (SigV4, IAM actions), the real model, a real network.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { aggregate } from '../src/aggregate';
import { Call } from '../src/edges';
import { GremlinGraphSource, readSnapshot } from '../src/scorer/graph';
import { runCycle } from '../src/scorer/run';
import { DynamoScorerStore, documentClient, getIncident, listIncidents, TableNames } from '../src/scorer/store';
import { IncidentRecord, ScorerState } from '../src/scorer/types';
import { GremlinWriter } from '../src/writers/gremlin';
import { createTables, dropTables, localClient, requireDynamoLocal, uniqueTables } from './dynamo-local';
import { BOUTIQUE_EDGES, NORMAL_MS, StubModel } from './scorer-helpers';

const GREMLIN_URL = process.env.GREMLIN_URL ?? 'ws://localhost:8182/gremlin';
const MIN = 60_000;

let ddb: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let tables: TableNames;
let writer: GremlinWriter;
let reader: GremlinWriter;
let g: any;

/** One minute of traffic written the way the transformer writes it: 50 calls per edge. */
async function traffic(slowdown: Record<string, number> = {}, calls = 50): Promise<void> {
  const batch: Call[] = [];
  for (const [caller, callee] of BOUTIQUE_EDGES) {
    for (let i = 0; i < calls; i++) {
      batch.push({ caller, callee, latencyMs: NORMAL_MS * (slowdown[callee] ?? 1), endMs: 1_700_000_000_000 });
    }
  }
  await writer.write(aggregate(batch));
}

beforeAll(async () => {
  ddb = localClient();
  await requireDynamoLocal(ddb);
  doc = documentClient(ddb);
  writer = new GremlinWriter({ url: GREMLIN_URL });
  reader = new GremlinWriter({ url: GREMLIN_URL });
  g = writer.source;
  try {
    await g.V().limit(1).toList();
  } catch (err) {
    throw new Error(
      `Cannot reach a Gremlin Server at ${GREMLIN_URL}. Start Docker Desktop, then:\n` +
        '  docker compose --profile gremlin up -d gremlin-server\n' +
        `(${(err as Error).message})`,
    );
  }
});

beforeEach(async () => {
  await g.V().hasLabel('Service').drop().iterate();
  tables = uniqueTables();
  await createTables(ddb, tables);
});

afterEach(async () => {
  await dropTables(ddb, tables);
});

afterAll(async () => {
  await writer?.close();
  await reader?.close();
  ddb?.destroy();
});

describe('readSnapshot (real Gremlin Server)', () => {
  test('returns the cumulative counters, histogram and node totals the writer stored', async () => {
    await traffic();
    await traffic({ paymentservice: 6 });
    const snap = await readSnapshot(await reader.connectedSource());

    expect(snap.edges).toHaveLength(BOUTIQUE_EDGES.length);
    const pay = snap.edges.find((e) => e.dm === 'paymentservice')!;
    expect(pay.calls).toBe(100);
    expect(pay.sumMs).toBeCloseTo(50 * 10 + 50 * 60, 6);
    expect(pay.hist.reduce((a, b) => a + b, 0)).toBe(100);
    expect(pay.hist[3]).toBe(50); // 10 ms -> bucket 3 (<= 10)
    expect(pay.hist[6]).toBe(50); // 60 ms -> bucket 6 (<= 100)
  });
});

describe('end to end: graph -> scorer -> DynamoDB', () => {
  test('healthy, fault, recovery: one incident, persisted, queryable, then resolved', async () => {
    const model = new StubModel();
    let clock = 1_700_000_000_000;
    const deps = {
      graph: new GremlinGraphSource(reader),
      scorer: model,
      store: new DynamoScorerStore(doc, tables),
      now: () => clock,
    };
    const minute = async (slowdown: Record<string, number> = {}) => {
      await traffic(slowdown);
      clock += MIN;
      return runCycle(deps);
    };

    expect((await runCycle(deps)).status).toBe('first');
    for (let i = 0; i < 6; i++) await minute(); // warm baselines
    for (let i = 0; i < 6; i++) expect((await minute()).modelCalled).toBe(false);
    expect(await listIncidents(doc, { status: 'OPEN', nowMs: clock }, tables)).toEqual([]);

    // fault at paymentservice, 6x
    const first = await minute({ paymentservice: 6 });
    expect(first.implicated).toBe('paymentservice');
    expect(first.actions).toEqual([]);
    const second = await minute({ paymentservice: 6 });
    expect(second.actions).toMatchObject([{ kind: 'open', service: 'paymentservice' }]);

    const open = await listIncidents(doc, { status: 'OPEN', nowMs: clock }, tables);
    expect(open).toHaveLength(1);
    const incident = open[0];
    expect(incident).toMatchObject({ root_cause: 'paymentservice', status: 'OPEN', model_version: 'stub-1', windows: 2 });
    expect(incident.evidence.paymentservice.own_delta).toBeCloseTo(5, 1);
    expect(incident.at_risk).toEqual(['checkoutservice', 'frontend']);
    expect(incident.expires_at).toBe(Math.floor(clock / 1000) + 30 * 86_400);
    expect(await listIncidents(doc, { rootCause: 'paymentservice', nowMs: clock }, tables)).toHaveLength(1);
    expect(await getIncident(doc, incident.incident_id, tables)).toEqual(incident);

    // persists: updated in place, not duplicated
    await minute({ paymentservice: 6 });
    const updated = await getIncident(doc, incident.incident_id, tables);
    expect(updated).toMatchObject({ status: 'OPEN', windows: 3 });
    expect(await listIncidents(doc, { status: 'OPEN', nowMs: clock }, tables)).toHaveLength(1);

    // recovery: resolves after 3 clean windows
    await minute();
    await minute();
    const resolving = await minute();
    expect(resolving.actions).toMatchObject([{ kind: 'resolve' }]);
    expect(await listIncidents(doc, { status: 'OPEN', nowMs: clock }, tables)).toEqual([]);
    const resolved = await listIncidents(doc, { status: 'RESOLVED', nowMs: clock }, tables);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].resolved_at_ms).toBe(clock);
    expect(resolved[0].incident_id).toBe(incident.incident_id);
  }, 60_000);
});

describe('DynamoScorerStore (real DynamoDB semantics)', () => {
  const state = (version: number, windows: number): ScorerState => ({
    version,
    windows,
    counters: [{ um: 'a', dm: 'b', calls: 1, sumMs: 2, hist: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }],
    baselines: { b: { ms: 2, n: 1 } },
    trackers: {},
    updatedMs: 1,
  });
  const incident = (id: string): IncidentRecord => ({
    schema_version: 1,
    incident_id: id,
    status: 'OPEN',
    root_cause: 'b',
    opened_at_ms: 1_700_000_000_000,
    last_seen_ms: 1_700_000_000_000,
    score: 0.5,
    peak_score: 0.5,
    ranking: [{ name: 'b', score: 0.5 }],
    blast_radius: [],
    at_risk: [],
    evidence: {},
    windows: 2,
    model_version: 'm',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  });

  test('first load is empty; state round-trips with its version', async () => {
    const store = new DynamoScorerStore(doc, tables);
    expect(await store.load()).toBeUndefined();
    expect(await store.commit(state(0, 1), [])).toBe(true);
    expect(await store.load()).toEqual(state(1, 1));
  });

  test('a stale writer loses, and its incident is NOT written (state and incidents are one transaction)', async () => {
    const store = new DynamoScorerStore(doc, tables);
    expect(await store.commit(state(0, 1), [incident('winner')])).toBe(true);
    const loaded = (await store.load())!;

    expect(await store.commit({ ...loaded, windows: 2 }, [incident('also-winner')])).toBe(true);
    // a run that loaded `loaded` (version 1) before the commit above, committing now:
    expect(await store.commit({ ...loaded, windows: 99 }, [incident('loser')])).toBe(false);

    expect(await getIncident(doc, 'loser', tables)).toBeUndefined();
    expect(await getIncident(doc, 'also-winner', tables)).toBeDefined();
    expect((await store.load())!.windows).toBe(2);
  });

  test('a stale writer with no incidents also loses; the very first commit is exclusive too', async () => {
    const store = new DynamoScorerStore(doc, tables);
    expect(await store.commit(state(0, 1), [])).toBe(true);
    expect(await store.commit(state(0, 7), [])).toBe(false); // second "first" run
    const loaded = (await store.load())!;
    expect(await store.commit(loaded, [])).toBe(true);
    expect(await store.commit(loaded, [])).toBe(false);
  });

  test('concurrent commits from one version: exactly one wins', async () => {
    const store = new DynamoScorerStore(doc, tables);
    await store.commit(state(0, 1), []);
    const loaded = (await store.load())!;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.commit({ ...loaded, windows: 100 + i }, [incident(`race-${i}`)])),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.findIndex(Boolean);
    expect(await getIncident(doc, `race-${winner}`, tables)).toBeDefined();
    for (let i = 0; i < 8; i++) if (i !== winner) expect(await getIncident(doc, `race-${i}`, tables)).toBeUndefined();
  });

  test('readers filter expired-but-not-yet-deleted items and return newest first', async () => {
    const store = new DynamoScorerStore(doc, tables);
    const now = 1_800_000_000_000;
    const old = { ...incident('old'), opened_at_ms: now - 3 * MIN, expires_at: Math.floor(now / 1000) + 1000 };
    const recent = { ...incident('recent'), opened_at_ms: now - MIN, expires_at: Math.floor(now / 1000) + 1000 };
    const expired = { ...incident('expired'), opened_at_ms: now - 2 * MIN, expires_at: Math.floor(now / 1000) - 10 };
    expect(await store.commit(state(0, 1), [old, recent, expired])).toBe(true);

    const list = await listIncidents(doc, { status: 'OPEN', nowMs: now }, tables);
    expect(list.map((i) => i.incident_id)).toEqual(['recent', 'old']);
  });
});
