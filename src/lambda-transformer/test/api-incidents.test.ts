import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleIncidents } from '../src/api/handler';
import { MAX_LIMIT, parseListQuery, toView } from '../src/api/incidents';
import { IncidentRecord } from '../src/scorer/types';
import { incident, resolved, T0 } from './alert-helpers';
import { apiDeps, event, FakeDoc, SECRET } from './api-helpers';

const GOLDEN = path.join(__dirname, 'fixtures', 'api-incidents.json');

const body = (res: { body: string }) => JSON.parse(res.body);
const depsWith = (items: IncidentRecord[]) => {
  const doc = new FakeDoc();
  doc.items = items;
  return apiDeps({ doc });
};

describe('parseListQuery', () => {
  test('defaults to the open incidents, 50 of them', () => {
    expect(parseListQuery(undefined)).toEqual({ status: 'OPEN', service: undefined, limit: 50 });
    expect(parseListQuery({})).toEqual({ status: 'OPEN', service: undefined, limit: 50 });
  });

  test('accepts status in any case, a service, and a limit', () => {
    expect(parseListQuery({ status: 'resolved', limit: '5' })).toEqual({ status: 'RESOLVED', service: undefined, limit: 5 });
    expect(parseListQuery({ service: 'checkoutservice' })).toEqual({ status: undefined, service: 'checkoutservice', limit: 50 });
  });

  test.each([
    [{ status: 'closed' }, /status must be/],
    [{ limit: '0' }, /between 1 and/],
    [{ limit: String(MAX_LIMIT + 1) }, /between 1 and/],
    [{ limit: '-3' }, /positive integer/],
    [{ limit: '5; DROP' }, /positive integer/],
    [{ service: 'a b' }, /invalid characters/],
    [{ service: 'x'.repeat(201) }, /invalid characters/],
  ])('rejects %j', (params, message) => {
    expect(() => parseListQuery(params as Record<string, string>)).toThrow(message);
  });
});

describe('GET /api/incidents', () => {
  test('lists open incidents newest first, as the contract view', async () => {
    const older = incident({ incident_id: 'a', root_cause: 'svc-a', opened_at_ms: T0 });
    const newer = incident({ incident_id: 'b', root_cause: 'svc-b', opened_at_ms: T0 + 60_000 });
    const res = await handleIncidents(event('/api/incidents', { queryStringParameters: { status: 'OPEN' } }), depsWith([older, newer, resolved({ incident_id: 'c' })]));

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body(res).count).toBe(2);
    expect(body(res).incidents.map((i: { incident_id: string }) => i.incident_id)).toEqual(['b', 'a']);
  });

  test('with no parameters it means "open now"', async () => {
    const res = await handleIncidents(event('/api/incidents'), depsWith([incident(), resolved({ incident_id: 'r' })]));
    expect(body(res).incidents.map((i: { status: string }) => i.status)).toEqual(['OPEN']);
  });

  test('by service uses the service index, and a status narrows it', async () => {
    const items = [
      incident({ incident_id: 'o', root_cause: 'svc' }),
      resolved({ incident_id: 'r', root_cause: 'svc' }),
      incident({ incident_id: 'other', root_cause: 'elsewhere' }),
    ];
    const deps = depsWith(items);
    const all = await handleIncidents(event('/api/incidents', { queryStringParameters: { service: 'svc' } }), deps);
    expect(body(all).incidents.map((i: { incident_id: string }) => i.incident_id).sort()).toEqual(['o', 'r']);
    expect(deps.doc.sent[0].input.IndexName).toBe('by-service');

    const onlyResolved = await handleIncidents(
      event('/api/incidents', { queryStringParameters: { service: 'svc', status: 'RESOLVED' } }),
      depsWith(items),
    );
    expect(body(onlyResolved).incidents.map((i: { incident_id: string }) => i.incident_id)).toEqual(['r']);
  });

  test('expired-but-present items are not listed (TTL deletion is lazy)', async () => {
    const stale = incident({ incident_id: 'stale', expires_at: Math.floor(T0 / 1000) - 10 });
    const res = await handleIncidents(event('/api/incidents'), depsWith([stale, incident({ incident_id: 'live' })]));
    expect(body(res).incidents.map((i: { incident_id: string }) => i.incident_id)).toEqual(['live']);
  });

  test('the limit is passed to the query', async () => {
    const deps = depsWith([incident()]);
    await handleIncidents(event('/api/incidents', { queryStringParameters: { limit: '7' } }), deps);
    expect(deps.doc.sent[0].input.Limit).toBe(7);
  });

  test('invalid input is a 400 with a message, not a 500', async () => {
    const res = await handleIncidents(event('/api/incidents', { queryStringParameters: { status: 'nope' } }), depsWith([]));
    expect(res.statusCode).toBe(400);
    expect(body(res).error).toMatch(/status must be/);
  });
});

describe('GET /api/incidents/{id}', () => {
  test('returns the incident, resolved timestamp included', async () => {
    const done = resolved({ incident_id: '1700-svc', root_cause: 'svc' });
    const res = await handleIncidents(event('/api/incidents/1700-svc', { pathParameters: { id: '1700-svc' } }), depsWith([done]));
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ incident_id: '1700-svc', status: 'RESOLVED', resolved_at_ms: done.resolved_at_ms });
  });

  test('unknown and expired ids are 404', async () => {
    const stale = incident({ incident_id: 'old', expires_at: Math.floor(T0 / 1000) - 1 });
    expect((await handleIncidents(event('/api/incidents/nope'), depsWith([]))).statusCode).toBe(404);
    expect((await handleIncidents(event('/api/incidents/old'), depsWith([stale]))).statusCode).toBe(404);
  });

  test('an id with unsafe characters is a 400 and never reaches DynamoDB', async () => {
    const deps = depsWith([]);
    const res = await handleIncidents(event('/api/incidents/a%20b', { pathParameters: { id: 'a%20b' } }), deps);
    expect(res.statusCode).toBe(400);
    expect(deps.doc.sent).toHaveLength(0);
    const bad = await handleIncidents(event('/api/incidents/%E0%A4%A', { pathParameters: { id: '%E0%A4%A' } }), deps);
    expect(bad.statusCode).toBe(400);
  });
});

describe('routing, method and origin gate', () => {
  test('health needs no table access', async () => {
    const deps = depsWith([]);
    const res = await handleIncidents(event('/api/health'), deps);
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ status: 'ok', time_ms: T0 + 2 * 60_000 });
    expect(deps.doc.sent).toHaveLength(0);
  });

  test('requests without the right origin header are refused before anything is read', async () => {
    const deps = depsWith([incident()]);
    for (const secret of [null, 'wrong', '']) {
      const res = await handleIncidents(event('/api/incidents', { secret }), deps);
      expect(res.statusCode).toBe(403);
      expect(res.body).toBe('{"error":"forbidden"}');
    }
    expect(deps.doc.sent).toHaveLength(0);
  });

  test('with no secret configured the API refuses everything (fail closed)', async () => {
    const res = await handleIncidents(event('/api/health'), { ...depsWith([]), originSecret: undefined });
    expect(res.statusCode).toBe(403);
  });

  test('only GET is allowed, unknown paths are 404', async () => {
    expect((await handleIncidents(event('/api/incidents', { method: 'DELETE' }), depsWith([]))).statusCode).toBe(405);
    expect((await handleIncidents(event('/api/incidents', { method: 'POST' }), depsWith([]))).statusCode).toBe(405);
    expect((await handleIncidents(event('/api/other'), depsWith([]))).statusCode).toBe(404);
    expect((await handleIncidents(event('/api/incidents/a/b'), depsWith([]))).statusCode).toBe(404);
  });

  test('a data store failure is a 502 with a generic body', async () => {
    const deps = depsWith([]);
    deps.doc.failWith = new Error('ProvisionedThroughputExceeded arn:aws:dynamodb:us-east-1:111122223333:table/rca-incidents');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await handleIncidents(event('/api/incidents'), deps);
    spy.mockRestore();
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('arn:');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('the secret is never echoed back', async () => {
    const res = await handleIncidents(event('/api/incidents/ok'), depsWith([]));
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});

describe('IncidentView contract', () => {
  test('matches the golden file the dashboard reads', () => {
    const open = incident({
      incident_id: `${T0}-productcatalogservice`,
      blast_radius: ['checkoutservice'],
      evidence: {
        productcatalogservice: { own_delta: 7.2, window_avg_ms: 8.4, baseline_ms: 1.025, calls: 120 },
        checkoutservice: { own_delta: 1.4, window_avg_ms: 5.1, baseline_ms: 2.125, calls: 60 },
      },
    });
    const done = resolved({ incident_id: `${T0 - 3_600_000}-currencyservice`, root_cause: 'currencyservice', opened_at_ms: T0 - 3_600_000 });
    const actual = {
      incidents: [toView(open), toView(done)],
      count: 2,
    };
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    expect(JSON.parse(fs.readFileSync(GOLDEN, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
  });

  test('persistence bookkeeping does not leak into the API', () => {
    const view = toView(incident()) as unknown as Record<string, unknown>;
    expect(view.expires_at).toBeUndefined();
    expect(view.schema_version).toBeUndefined();
    expect(view.severity).toBe('error');
    expect(view.resolved_at_ms).toBeNull();
  });
});
