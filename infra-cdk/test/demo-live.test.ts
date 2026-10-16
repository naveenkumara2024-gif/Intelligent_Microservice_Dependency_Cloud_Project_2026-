import { DemoIncident, DemoObservation, evaluateDemo, intoService, rankOf, windowEdges, WINDOW_MS } from '../scripts/demo-live';
import { LiveEdge } from '../scripts/probe-client';

const T = Date.UTC(2026, 9, 14, 10, 0, 0);
const edge = (um: string, dm: string, call_count: number, latency_sum_ms: number): LiveEdge => ({ um, dm, call_count, latency_sum_ms, last_seen_ms: T });

function incident(overrides: Partial<DemoIncident> = {}): DemoIncident {
  return {
    incident_id: `${T + 3 * WINDOW_MS}-productcatalogservice`,
    status: 'OPEN',
    root_cause: 'productcatalogservice',
    opened_at_ms: T + 3 * WINDOW_MS,
    windows: 2,
    score: 0.91,
    ranking: [
      { name: 'productcatalogservice', score: 0.91 },
      { name: 'frontend', score: 0.05 },
    ],
    blast_radius: ['frontend'],
    at_risk: ['frontend', 'recommendationservice', 'checkoutservice'],
    ...overrides,
  };
}

/** A run that did everything right. Each test breaks one thing. */
function good(): DemoObservation {
  const resolved = incident({ status: 'RESOLVED', resolved_at_ms: T + 12 * WINDOW_MS, windows: 9 });
  return {
    fault: { service: 'productcatalogservice', description: 'EXTRA_LATENCY=300ms', appliedAtMs: T, clearedAtMs: T + 8 * WINDOW_MS },
    soak: { minutes: 8, incidentsOpened: 0, modelCalls: 0, scorerRuns: 8 },
    latency: { before: { calls: 300, avgMs: 1.2 }, during: { calls: 120, avgMs: 301 } },
    incidents: [incident()],
    final: resolved,
    alertsPublished: ['incident.opened', 'incident.resolved'],
    sns: { delivered: 2, failed: 0 },
    deadLetters: 0,
    faultRemoved: true,
  };
}

const verdict = (o: DemoObservation) => Object.fromEntries(evaluateDemo(o).map((c) => [c.name, c.ok ? 'PASS' : c.warn ? 'WARN' : 'FAIL']));
const failures = (o: DemoObservation) => evaluateDemo(o).filter((c) => !c.ok && !c.warn).map((c) => c.name);

describe('window helpers', () => {
  test('windowEdges differences cumulative counters per edge and skips resets', () => {
    const before = [edge('frontend', 'productcatalogservice', 100, 120), edge('checkoutservice', 'productcatalogservice', 50, 60)];
    const after = [
      edge('frontend', 'productcatalogservice', 140, 12_120), // 40 calls, 12000 ms -> 300 ms
      edge('checkoutservice', 'productcatalogservice', 40, 10), // went down: reset, skipped
      edge('recommendationservice', 'productcatalogservice', 10, 3000), // new edge: all of it
    ];
    expect(windowEdges(before, after)).toEqual([
      { um: 'frontend', dm: 'productcatalogservice', calls: 40, avgMs: 300 },
      { um: 'recommendationservice', dm: 'productcatalogservice', calls: 10, avgMs: 300 },
    ]);
  });

  test('intoService is call-weighted and undefined when nothing arrived', () => {
    const w = [
      { um: 'a', dm: 's', calls: 30, avgMs: 10 },
      { um: 'b', dm: 's', calls: 10, avgMs: 50 },
      { um: 'c', dm: 'other', calls: 99, avgMs: 1 },
    ];
    expect(intoService(w, 's')).toEqual({ calls: 40, avgMs: 20 });
    expect(intoService(w, 'nobody')).toBeUndefined();
  });

  test('rankOf is 1-based, 0 when absent', () => {
    const ranking = [{ name: 'a' }, { name: 'b' }];
    expect(rankOf(ranking, 'b')).toBe(2);
    expect(rankOf(ranking, 'z')).toBe(0);
    expect(rankOf(undefined, 'a')).toBe(0);
  });
});

describe('evaluateDemo', () => {
  test('a run that did everything right passes every check', () => {
    expect(failures(good())).toEqual([]);
    expect(Object.values(verdict(good())).every((v) => v === 'PASS')).toBe(true);
  });

  test('a false alarm during the soak fails the run, even if the fault is then found', () => {
    const o = good();
    o.soak.incidentsOpened = 1;
    expect(failures(o)).toContain('Healthy soak (8 min): no incident, no model call');
  });

  test('a fault that never shows in the graph is caught at the source', () => {
    const o = good();
    o.latency.during = { calls: 120, avgMs: 1.5 };
    expect(failures(o).some((n) => n.startsWith('The fault is visible in the graph'))).toBe(true);
    o.latency.during = undefined;
    expect(failures(o).some((n) => n.startsWith('The fault is visible in the graph'))).toBe(true);
  });

  test('opening too late fails; no incident at all fails', () => {
    const late = good();
    late.incidents = [incident({ opened_at_ms: T + 7 * WINDOW_MS })];
    expect(failures(late)).toContain('An incident opens within 5 windows of the fault');

    const none = good();
    none.incidents = [];
    none.final = undefined;
    expect(failures(none)).toEqual(expect.arrayContaining(['An incident opens within 5 windows of the fault', 'Exactly one incident opened (no duplicates, no unrelated alarms)']));
  });

  test('a wrong top-1 is a WARN (a finding about the model), but top-3 still has to hold', () => {
    const o = good();
    o.incidents = [incident({ root_cause: 'frontend', ranking: [{ name: 'frontend', score: 0.6 }, { name: 'productcatalogservice', score: 0.3 }] })];
    const v = verdict(o);
    expect(v['Root cause is the faulted service (productcatalogservice)']).toBe('WARN');
    expect(v["productcatalogservice is in the model's top 3"]).toBe('PASS');

    o.incidents = [incident({ root_cause: 'frontend', ranking: [{ name: 'frontend', score: 0.9 }] })];
    expect(verdict(o)["productcatalogservice is in the model's top 3"]).toBe('FAIL');
  });

  test('duplicates fail', () => {
    const o = good();
    o.incidents = [incident(), incident({ incident_id: 'second', opened_at_ms: T + 5 * WINDOW_MS })];
    expect(failures(o)).toContain('Exactly one incident opened (no duplicates, no unrelated alarms)');
  });

  test('never resolving, resolving late, or never clearing all fail', () => {
    const open = good();
    open.final = incident();
    expect(failures(open)).toContain('The incident resolves within 6 windows of clearing the fault');

    const late = good();
    late.final = incident({ status: 'RESOLVED', resolved_at_ms: T + 8 * WINDOW_MS + 7 * WINDOW_MS });
    expect(failures(late)).toContain('The incident resolves within 6 windows of clearing the fault');

    const stuck = good();
    stuck.fault.clearedAtMs = undefined;
    stuck.faultRemoved = false;
    expect(failures(stuck)).toEqual(expect.arrayContaining(['The fault was cleared', 'The fault was removed from the cluster']));
  });

  test('alert accounting: a missing, duplicated or undelivered alert fails', () => {
    for (const alerts of [['incident.opened'], ['incident.opened', 'incident.opened', 'incident.resolved'], []]) {
      const o = good();
      o.alertsPublished = alerts;
      expect(failures(o)).toContain('Alerts: exactly one "opened" and one "resolved" for the incident');
    }
    const undelivered = good();
    undelivered.sns = { delivered: 2, failed: 1 };
    undelivered.deadLetters = 1;
    expect(failures(undelivered)).toEqual(expect.arrayContaining(['SNS delivered the alerts, none failed', 'Dead-letter queue is empty']));
  });

  test('no ripple reported fails (the case Stage 11 never exercised)', () => {
    const o = good();
    o.incidents = [incident({ at_risk: [], blast_radius: [] })];
    expect(failures(o).some((n) => n.startsWith('The ripple is reported'))).toBe(true);
  });
});
