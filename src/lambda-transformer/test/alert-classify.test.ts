import { classify, toIncident, unmarshall } from '../src/alerts/classify';
import { StreamRecord } from '../src/alerts/types';
import { INCIDENT_ID, incident, opened, resolved, resolvedRecord, streamRecord, T0, updated } from './alert-helpers';

function alertOf(record: StreamRecord) {
  const result = classify(record);
  if (result.kind !== 'alert') throw new Error(`expected an alert, got ignored: ${result.reason}`);
  return result.event;
}

const reasonOf = (record: StreamRecord) => {
  const result = classify(record);
  if (result.kind !== 'ignored') throw new Error('expected the record to be ignored');
  return result.reason;
};

describe('classify: the two transitions that alert', () => {
  test('INSERT with status OPEN -> incident.opened, stamped at opened_at_ms', () => {
    const event = alertOf(opened());
    expect(event.schema_version).toBe(1);
    expect(event.event).toBe('incident.opened');
    expect(event.occurred_at_ms).toBe(T0);
    expect(event.incident).toMatchObject({
      incident_id: INCIDENT_ID,
      status: 'OPEN',
      root_cause: 'productcatalogservice',
      score: 0.994,
      blast_radius: [],
      resolved_at_ms: null,
      windows: 2,
    });
    expect(event.incident.top_candidates[0]).toEqual({ name: 'productcatalogservice', score: 0.994 });
    expect(event.incident.evidence.productcatalogservice.own_delta).toBeCloseTo(7.2);
  });

  test('MODIFY OPEN -> RESOLVED -> incident.resolved, stamped at resolved_at_ms', () => {
    const event = alertOf(resolvedRecord());
    expect(event.event).toBe('incident.resolved');
    expect(event.occurred_at_ms).toBe(T0 + 8 * 60_000);
    expect(event.incident.status).toBe('RESOLVED');
    expect(event.incident.resolved_at_ms).toBe(T0 + 8 * 60_000);
    expect(event.incident.peak_score).toBe(0.997);
  });
});

describe('classify: everything else is ignored', () => {
  test('the per-window OPEN -> OPEN rewrite never alerts', () => {
    expect(reasonOf(updated())).toBe('modify-not-resolution');
  });

  test('a duplicate RESOLVED -> RESOLVED rewrite never alerts twice', () => {
    const done = resolved();
    expect(reasonOf(streamRecord('MODIFY', { old: done, next: { ...done, last_seen_ms: done.last_seen_ms + 1 } }))).toBe(
      'modify-not-resolution',
    );
  });

  test('an incident inserted already RESOLVED (replay/backfill) is not "opened"', () => {
    expect(reasonOf(streamRecord('INSERT', { next: resolved() }))).toBe('insert-not-open');
  });

  test('TTL expiry (REMOVE) is ignored', () => {
    expect(reasonOf(streamRecord('REMOVE', { old: resolved() }))).toBe('event-REMOVE');
  });

  test('a MODIFY without an old image cannot prove a transition, so it is ignored', () => {
    expect(reasonOf(streamRecord('MODIFY', { next: resolved() }))).toBe('modify-not-resolution');
  });

  test('records that are not incidents are ignored, never thrown on', () => {
    expect(reasonOf({ eventName: 'INSERT', dynamodb: {} })).toBe('no-new-image');
    expect(reasonOf({ dynamodb: { NewImage: { incident_id: { S: 'x' } } } })).toBe('event-missing');
    expect(reasonOf(streamRecord('INSERT', { next: incident({ incident_id: '' }) }))).toBe('malformed-incident');
    expect(reasonOf(streamRecord('INSERT', { next: incident({ root_cause: '' }) }))).toBe('malformed-incident');
    expect(reasonOf(streamRecord('INSERT', { next: { ...incident(), status: 'WEIRD' as never } }))).toBe('malformed-incident');
  });
});

describe('classify: severity', () => {
  test('error for a single service, critical once the fault is propagating', () => {
    expect(alertOf(opened(incident({ blast_radius: [] }))).incident.severity).toBe('error');
    expect(alertOf(opened(incident({ blast_radius: ['checkoutservice'] }))).incident.severity).toBe('critical');
  });
});

describe('toIncident / unmarshall', () => {
  test('tolerates missing optional fields with safe defaults', () => {
    const minimal = toIncident({ incident_id: 'i', status: 'OPEN', root_cause: 'svc' })!;
    expect(minimal).toMatchObject({
      score: 0,
      peak_score: 0,
      blast_radius: [],
      at_risk: [],
      top_candidates: [],
      evidence: {},
      resolved_at_ms: null,
      model_version: '',
    });
  });

  test('drops malformed list/evidence entries instead of failing the alert', () => {
    const inc = toIncident({
      incident_id: 'i',
      status: 'OPEN',
      root_cause: 'svc',
      blast_radius: ['a', 5, null],
      ranking: [{ name: 'a', score: 0.5 }, 'junk', { score: 1 }],
      evidence: { a: { own_delta: 2, calls: 'many' }, b: 'junk' },
    })!;
    expect(inc.blast_radius).toEqual(['a']);
    expect(inc.top_candidates).toEqual([{ name: 'a', score: 0.5 }]);
    expect(inc.evidence).toEqual({ a: { own_delta: 2, window_avg_ms: 0, baseline_ms: 0, calls: 0 } });
  });

  test('unmarshalls every DynamoDB type the scorer can write', () => {
    expect(unmarshall({ S: 'a' })).toBe('a');
    expect(unmarshall({ N: '1.5' })).toBe(1.5);
    expect(unmarshall({ BOOL: false })).toBe(false);
    expect(unmarshall({ NULL: true })).toBeNull();
    expect(unmarshall({ L: [{ S: 'a' }, { N: '2' }] })).toEqual(['a', 2]);
    expect(unmarshall({ M: { k: { N: '3' } } })).toEqual({ k: 3 });
    expect(unmarshall({ SS: ['x', 'y'] })).toEqual(['x', 'y']);
    expect(unmarshall({ NS: ['1', '2'] })).toEqual([1, 2]);
    expect(unmarshall(undefined)).toBeUndefined();
  });
});
