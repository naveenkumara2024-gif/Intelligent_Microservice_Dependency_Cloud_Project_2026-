import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ANOMALY_DELTA,
  DEGRADE_MAX_CALLS,
  INJECTIONS_PER_MINUTE,
  marshallItem,
  parseScorerLog,
  pickTarget,
  planDegrade,
  ratesPerService,
  TTL_DAYS,
  unmarshallItem,
  validateIncident,
  WARMUP_WINDOWS,
} from '../scripts/incidents-live';

const edge = (um: string, dm: string, call_count: number) => ({ um, dm, call_count, latency_sum_ms: 0, last_seen_ms: 0 });

describe('constants stay in step with the scorer', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

  test('the live scripts use the scorer config and the probe limit', () => {
    const config = read('src', 'lambda-transformer', 'src', 'scorer', 'config.ts');
    expect(config).toMatch(new RegExp(`warmupWindows: ${WARMUP_WINDOWS},`));
    expect(config).toMatch(new RegExp(`anomalyDelta: ${ANOMALY_DELTA.toFixed(1)},`));
    expect(config).toMatch(new RegExp(`ttlDays: ${TTL_DAYS},`));
    expect(read('src', 'lambda-transformer', 'src', 'probe-actions.ts')).toMatch(
      new RegExp(`DEGRADE_MAX_CALLS = ${DEGRADE_MAX_CALLS};`),
    );
  });
});

describe('DynamoDB JSON', () => {
  test('round-trips nested items, lists, numbers and booleans', () => {
    const item = { id: 'a', n: 3.5, ok: true, list: [1, 'x', { k: 2 }], map: { deep: { v: 1 } }, nothing: null };
    expect(unmarshallItem(marshallItem(item))).toEqual(item);
  });
});

describe('parseScorerLog', () => {
  test('extracts the cycle summary from a Lambda log line, and ignores everything else', () => {
    const line = '2026-10-13T10:00:00.000Z\t1234\tINFO\tscorer {"status":"scored","window":9,"observed":5,"anomalous":["pay"],"modelCalled":true,"actions":[],"openIncidents":[],"windows":7}\n';
    expect(parseScorerLog(line)).toMatchObject({ status: 'scored', anomalous: ['pay'], modelCalled: true, windows: 7 });
    expect(parseScorerLog('START RequestId: 1')).toBeUndefined();
    expect(parseScorerLog('scorer {not json')).toBeUndefined();
  });
});

describe('target selection and sizing', () => {
  const rates = ratesPerService(
    [edge('fe', 'cart', 100), edge('fe', 'pay', 100), edge('co', 'pay', 100)],
    [edge('fe', 'cart', 400), edge('fe', 'pay', 160), edge('co', 'pay', 190), edge('fe', 'new', 30)],
    60,
  );

  test('rates are calls per minute into each service, summed over its incoming edges', () => {
    const byName = Object.fromEntries(rates.map((r) => [r.service, r]));
    expect(byName.cart).toMatchObject({ callsPerMinute: 300, edgeCount: 1 });
    expect(byName.pay).toMatchObject({ callsPerMinute: 150, edgeCount: 2 });
    expect(byName.new).toMatchObject({ callsPerMinute: 30, edgeCount: 1 });
  });

  test('a counter that went down (graph reset between samples) is ignored, not negative', () => {
    expect(ratesPerService([edge('a', 'b', 500)], [edge('a', 'b', 10)], 60)).toEqual([]);
  });

  test('picks the busiest service with a warm baseline and enough traffic', () => {
    const state = { baselines: { cart: { ms: 4, n: 2 }, pay: { ms: 10, n: 9 }, new: { ms: 1, n: 9 } } };
    const target = pickTarget(state, rates)!;
    expect(target.service).toBe('pay'); // cart is busier but its baseline is cold; new has < 20 calls/min... 30 is fine but pay is busier
    expect(target.baselineMs).toBe(10);
    expect(pickTarget({ baselines: {} }, rates)).toBeUndefined();
    expect(pickTarget(state, rates, ['pay'])!.service).toBe('new');
  });

  test('the plan puts the window average inside the trained 2-9x range, whatever the traffic', () => {
    for (const [callsPerMinute, baselineMs, edgeCount] of [
      [60, 3, 1],
      [600, 12, 3],
      [5000, 2, 2],
      [25, 0.6, 1],
    ]) {
      const plan = planDegrade({ service: 's', callsPerMinute, baselineMs, edgeCount });
      expect(plan.callsPerInjection).toBeGreaterThanOrEqual(20);
      expect(plan.callsPerInjection).toBeLessThanOrEqual(DEGRADE_MAX_CALLS);
      expect(plan.injectionsPerMinute).toBe(INJECTIONS_PER_MINUTE);
      expect(plan.latencyMs).toBeGreaterThanOrEqual(7);
      expect(plan.expectedDelta).toBeGreaterThan(ANOMALY_DELTA * 1.5);
      expect(plan.expectedDelta).toBeLessThan(10);
    }
  });
});

describe('validateIncident', () => {
  const NOW = 1_800_000_000;
  const good = () => ({
    schema_version: 1,
    incident_id: '1799999000000-paymentservice',
    status: 'OPEN',
    root_cause: 'paymentservice',
    opened_at_ms: 1_799_999_000_000,
    last_seen_ms: 1_799_999_060_000,
    score: 0.8,
    peak_score: 0.9,
    ranking: [{ name: 'paymentservice', score: 0.8 }],
    blast_radius: ['checkoutservice'],
    at_risk: ['checkoutservice', 'frontend'],
    evidence: { paymentservice: { own_delta: 4.8, window_avg_ms: 58, baseline_ms: 10, calls: 300 } },
    windows: 2,
    model_version: 'd77fda205a82',
    expires_at: Math.floor(1_799_999_060_000 / 1000) + TTL_DAYS * 86_400,
  });

  test('a well-formed incident passes every check', () => {
    const checks = validateIncident(good(), 'paymentservice', NOW);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(10);
  });

  test.each([
    ['evidence below the gate', (i: any) => (i.evidence.paymentservice.own_delta = 0.2)],
    ['blast radius outside at-risk', (i: any) => (i.blast_radius = ['somebody-else'])],
    ['id not matching opened_at_ms', (i: any) => (i.incident_id = '1-paymentservice')],
    ['TTL in the past', (i: any) => (i.expires_at = NOW - 10)],
    ['TTL 1 day instead of 30', (i: any) => (i.expires_at = Math.floor(i.last_seen_ms / 1000) + 86_400)],
    ['opened after last seen', (i: any) => (i.opened_at_ms = i.last_seen_ms + 1)],
    ['no model version', (i: any) => delete i.model_version],
    ['peak below score', (i: any) => (i.peak_score = 0.1)],
  ])('flags %s', (_label, mutate) => {
    const item = good();
    mutate(item);
    expect(validateIncident(item, 'paymentservice', NOW).some((c) => !c.ok)).toBe(true);
  });
});
