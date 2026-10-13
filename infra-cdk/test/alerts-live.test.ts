import { classify } from '../../src/lambda-transformer/src/alerts/classify';
import { StreamRecord } from '../../src/lambda-transformer/src/alerts/types';
import {
  eventsFor,
  incidentIdOf,
  incidentItem,
  parseAlertLog,
  tally,
} from '../scripts/alerts-live';
import { marshallItem } from '../scripts/incidents-live';

const NOW = Date.UTC(2026, 9, 13, 15, 0, 0);
const OPENED = NOW - 5 * 60_000;

const record = (
  eventName: 'INSERT' | 'MODIFY',
  parts: { old?: Record<string, unknown>; next: Record<string, unknown> },
): StreamRecord =>
  ({
    eventName,
    dynamodb: {
      ...(parts.old ? { OldImage: marshallItem(parts.old) } : {}),
      NewImage: marshallItem(parts.next),
    },
  }) as unknown as StreamRecord;

describe('parseAlertLog', () => {
  test('reads the name and JSON fields from a prefixed Lambda log line', () => {
    const line = '2026-10-13T15:00:01.234Z\t2f1c\tINFO\talert.published {"event":"incident.opened","incident_id":"x","severity":"critical"}\n';
    expect(parseAlertLog(line)).toEqual({
      name: 'published',
      fields: { event: 'incident.opened', incident_id: 'x', severity: 'critical' },
    });
  });

  test('handles names with underscores, nested objects, and ignores other lines', () => {
    expect(parseAlertLog('INFO alert.publish_failed {"error":"boom"}')?.name).toBe('publish_failed');
    expect(parseAlertLog('INFO alert.skipped {"rendered":{"blocks":[{"type":"header"}]},"channel":"slack"}')?.fields.channel).toBe('slack');
    expect(parseAlertLog('START RequestId: abc')).toBeUndefined();
    expect(parseAlertLog('alert.batch {not json}')).toBeUndefined();
  });
});

describe('eventsFor / tally', () => {
  const lines = [
    { name: 'published', fields: { incident_id: 'a', event: 'incident.opened' } },
    { name: 'published', fields: { incident_id: 'b', event: 'incident.opened' } },
    { name: 'sent', fields: { incident_id: 'a', event: 'incident.opened', channel: 'slack' } },
    { name: 'skipped', fields: { incident_id: 'a', event: 'incident.resolved', channel: 'slack' } },
    { name: 'batch', fields: { records: 1 } },
  ];

  test('filters by log name and incident', () => {
    expect(eventsFor(lines, ['published'], 'a')).toEqual(['incident.opened']);
    expect(eventsFor(lines, ['sent', 'skipped'], 'a')).toEqual(['incident.opened', 'incident.resolved']);
    expect(eventsFor(lines, ['published'], 'zzz')).toEqual([]);
  });

  test('tallies opens and resolves', () => {
    expect(tally(['incident.opened', 'incident.resolved', 'incident.opened'])).toEqual({ opened: 2, resolved: 1 });
    expect(tally([])).toEqual({ opened: 0, resolved: 0 });
  });
});

describe('synthetic incidents match what the real dispatcher classifies', () => {
  const open = incidentItem('verify-1', 'open', OPENED, OPENED);
  const update = incidentItem('verify-1', 'update', NOW - 60_000, OPENED);
  const resolve = incidentItem('verify-1', 'resolve', NOW, OPENED);

  test('all three steps share one incident id, in the scorer id format', () => {
    expect(incidentIdOf(open)).toBe(`${OPENED}-verify-1-svc`);
    expect(incidentIdOf(update)).toBe(incidentIdOf(open));
    expect(incidentIdOf(resolve)).toBe(incidentIdOf(open));
  });

  test('open -> incident.opened, critical because the blast radius is non-empty', () => {
    const result = classify(record('INSERT', { next: open }));
    expect(result.kind).toBe('alert');
    if (result.kind !== 'alert') return;
    expect(result.event.event).toBe('incident.opened');
    expect(result.event.incident.severity).toBe('critical');
    expect(result.event.incident.root_cause).toBe('verify-1-svc');
    expect(Object.keys(result.event.incident.evidence)).toHaveLength(2);
  });

  test('update (OPEN -> OPEN) alerts nothing', () => {
    expect(classify(record('MODIFY', { old: open, next: update }))).toEqual({ kind: 'ignored', reason: 'modify-not-resolution' });
  });

  test('resolve -> incident.resolved, stamped with the resolution time', () => {
    const result = classify(record('MODIFY', { old: update, next: resolve }));
    expect(result.kind).toBe('alert');
    if (result.kind !== 'alert') return;
    expect(result.event.event).toBe('incident.resolved');
    expect(result.event.occurred_at_ms).toBe(NOW);
  });

  test('every item carries a TTL an hour out, so a leaked synthetic incident expires', () => {
    for (const item of [open, update, resolve]) {
      expect(item.expires_at).toBeGreaterThan(Math.floor(NOW / 1000));
      expect(item.expires_at).toBeLessThanOrEqual(Math.floor(NOW / 1000) + 3600 + 1);
    }
  });
});
