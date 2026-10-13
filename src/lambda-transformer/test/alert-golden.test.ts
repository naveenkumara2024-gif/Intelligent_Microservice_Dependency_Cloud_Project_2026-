// Pins the alert-event contract (what is published to SNS, v1) and the exact Slack / PagerDuty
// bodies rendered from it. Every subscriber, and the Stage 13 dashboard if it reads alerts, depends
// on these shapes, so a change has to be deliberate.
//
// Regenerate deliberately with:  UPDATE_GOLDEN=1 npx jest test/alert-golden
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classify } from '../src/alerts/classify';
import { renderPagerDuty } from '../src/alerts/pagerduty';
import { renderSlack } from '../src/alerts/slack';
import { AlertEvent, StreamRecord } from '../src/alerts/types';
import { incident, opened, resolvedRecord } from './alert-helpers';

const EVENTS = path.join(__dirname, 'fixtures', 'alert-event.json');
const PAYLOADS = path.join(__dirname, 'fixtures', 'alert-payloads.json');

const eventOf = (record: StreamRecord): AlertEvent => {
  const result = classify(record);
  if (result.kind !== 'alert') throw new Error(result.reason);
  return result.event;
};

/** A propagating fault: productcatalogservice slow, checkoutservice already rippling. */
const active = incident({
  blast_radius: ['checkoutservice'],
  evidence: {
    productcatalogservice: { own_delta: 7.2, window_avg_ms: 8.4, baseline_ms: 1.025, calls: 120 },
    checkoutservice: { own_delta: 1.4, window_avg_ms: 5.1, baseline_ms: 2.125, calls: 60 },
  },
});

const events = { opened: eventOf(opened(active)), resolved: eventOf(resolvedRecord(active)) };
const payloads = {
  slack_opened: renderSlack(events.opened),
  slack_resolved: renderSlack(events.resolved),
  pagerduty_trigger: renderPagerDuty(events.opened, 'ROUTING-KEY'),
  pagerduty_resolve: renderPagerDuty(events.resolved, 'ROUTING-KEY'),
};

function pinned(file: string, actual: unknown) {
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  }
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(actual)));
}

describe('alert contract v1', () => {
  test('the published events match the committed golden file', () => {
    pinned(EVENTS, events);
  });

  test('the rendered Slack and PagerDuty bodies match the committed golden file', () => {
    pinned(PAYLOADS, payloads);
  });

  test('the contract carries what every consumer reads', () => {
    for (const e of Object.values(events)) {
      expect(Object.keys(e).sort()).toEqual(['event', 'incident', 'occurred_at_ms', 'schema_version']);
      expect(Object.keys(e.incident).sort()).toEqual(
        [
          'at_risk', 'blast_radius', 'evidence', 'incident_id', 'model_version', 'opened_at_ms', 'peak_score',
          'resolved_at_ms', 'root_cause', 'score', 'severity', 'status', 'top_candidates', 'windows',
        ].sort(),
      );
    }
    expect(events.opened.incident.severity).toBe('critical');
    expect(events.resolved.occurred_at_ms).toBe(events.resolved.incident.resolved_at_ms);
  });
});
