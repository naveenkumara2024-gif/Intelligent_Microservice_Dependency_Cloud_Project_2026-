import { classify } from '../src/alerts/classify';
import { formatDuration, formatMs, listNames, truncate } from '../src/alerts/format';
import { renderPagerDuty } from '../src/alerts/pagerduty';
import { escapeSlack, renderSlack } from '../src/alerts/slack';
import { AlertEvent } from '../src/alerts/types';
import { INCIDENT_ID, incident, opened, resolvedRecord } from './alert-helpers';

function event(record: ReturnType<typeof opened>): AlertEvent {
  const result = classify(record);
  if (result.kind !== 'alert') throw new Error(result.reason);
  return result.event;
}

const blocksOf = (msg: ReturnType<typeof renderSlack>) => msg.blocks as { type: string; [k: string]: any }[];
const allText = (msg: ReturnType<typeof renderSlack>) => JSON.stringify(msg);

describe('format helpers', () => {
  test('truncate keeps the limit and marks the cut', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abcdefgh', 5)).toHaveLength(5);
  });

  test('durations and milliseconds', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatMs(0.694)).toBe('0.69 ms');
    expect(formatMs(8.4)).toBe('8.4 ms');
    expect(formatMs(120.4)).toBe('120 ms');
    expect(formatMs(NaN)).toBe('n/a');
  });

  test('listNames shows a few and counts the rest', () => {
    expect(listNames([], 3, 80)).toBe('none');
    expect(listNames(['a', 'b'], 3, 80)).toBe('a, b');
    expect(listNames(['a', 'b', 'c', 'd', 'e'], 3, 80)).toBe('a, b, c +2 more');
  });
});

describe('Slack message', () => {
  test('opened: header, key fields, evidence and ranking', () => {
    const msg = renderSlack(event(opened()));
    const [header, fields, evidence, ranking, footer] = blocksOf(msg);
    expect(header.type).toBe('header');
    expect(header.text.text).toBe(':warning: Incident opened: productcatalogservice');
    const labels = fields.fields.map((f: { text: string }) => f.text);
    expect(labels).toContain('*Root cause*\n`productcatalogservice`');
    expect(labels).toContain('*Confidence*\n99.4%');
    expect(labels).toContain('*Severity*\nerror');
    expect(labels).toContain('*Blast radius*\nnone');
    expect(evidence.text.text).toContain('`productcatalogservice`: 8.4 ms vs 1.0 ms baseline (+720%, 120 calls)');
    expect(ranking.text.text).toContain('1. `productcatalogservice` 99.4%');
    expect(footer.type).toBe('context');
    expect(msg.text).toBe('Incident opened: productcatalogservice (confidence 99.4%, severity error)');
  });

  test('a propagating fault is critical and says so', () => {
    const msg = renderSlack(event(opened(incident({ blast_radius: ['checkoutservice', 'frontend'] }))));
    expect(blocksOf(msg)[0].text.text).toBe(':rotating_light: Incident opened: productcatalogservice');
    expect(allText(msg)).toContain('checkoutservice, frontend');
    expect(allText(msg)).toContain('*Severity*\\ncritical');
  });

  test('resolved: duration and peak confidence, no ranking block', () => {
    const msg = renderSlack(event(resolvedRecord()));
    const types = blocksOf(msg).map((b) => b.type);
    expect(types).toEqual(['header', 'section', 'section', 'context']);
    expect(blocksOf(msg)[0].text.text).toBe(':white_check_mark: Incident resolved: productcatalogservice');
    expect(allText(msg)).toContain('*Duration*\\n8m 00s');
    expect(allText(msg)).toContain('*Peak confidence*\\n99.7%');
    expect(msg.text).toBe('Incident resolved: productcatalogservice after 8m 00s');
  });

  test('control characters in service names are escaped, long ones truncated', () => {
    expect(escapeSlack('<!channel> & more')).toBe('&lt;!channel&gt; &amp; more');
    const nasty = '<!channel>' + 'x'.repeat(300);
    const msg = renderSlack(event(opened(incident({ root_cause: nasty }))));
    // Everything Slack renders as mrkdwn (the fallback text and every non-header block) is escaped.
    // The header is plain_text and is shown literally, so it keeps the raw name.
    expect(msg.text).not.toContain('<!channel>');
    expect(msg.text).toContain('&lt;!channel&gt;');
    const mrkdwn = JSON.stringify(blocksOf(msg).filter((b) => b.type !== 'header'));
    expect(mrkdwn).not.toContain('<!channel>');
    expect(mrkdwn).toContain('&lt;!channel&gt;');
    expect(blocksOf(msg)[0].text.type).toBe('plain_text');
    expect(blocksOf(msg)[0].text.text.length).toBeLessThanOrEqual(150);
  });

  test('many evidence entries are capped with a "+N more" line, worst first', () => {
    const evidence = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`svc${i}`, { own_delta: i, window_avg_ms: 10 + i, baseline_ms: 10, calls: 50 }]),
    );
    const msg = renderSlack(event(opened(incident({ evidence }))));
    const text = blocksOf(msg)[2].text.text as string;
    expect(text.indexOf('svc8')).toBeLessThan(text.indexOf('svc7'));
    expect(text).toContain('+4 more');
    expect(text).not.toContain('svc0');
    expect(text.length).toBeLessThanOrEqual(3000);
  });

  test('no evidence means no evidence block; dashboard link only when configured', () => {
    const bare = renderSlack(event(opened(incident({ evidence: {} }))));
    expect(blocksOf(bare).filter((b) => b.type === 'section')).toHaveLength(2); // fields + ranking
    expect(allText(bare)).not.toContain('dashboard');
    const linked = renderSlack(event(opened()), { dashboardUrl: 'https://dash.example/incidents' });
    expect(allText(linked)).toContain('<https://dash.example/incidents|dashboard>');
  });
});

describe('PagerDuty event', () => {
  test('trigger: dedup_key is the incident id, severity and details are filled', () => {
    const body = renderPagerDuty(event(opened()), 'R0UT1NGKEY');
    expect(body).toMatchObject({
      routing_key: 'R0UT1NGKEY',
      event_action: 'trigger',
      dedup_key: INCIDENT_ID,
    });
    expect(body.payload).toMatchObject({
      severity: 'error',
      source: 'rca-framework',
      component: 'productcatalogservice',
      timestamp: '2026-10-13T12:00:00.000Z',
    });
    expect(body.payload!.summary).toBe('Root cause productcatalogservice (confidence 99.4%); no other service affected yet');
    expect(body.payload!.custom_details).toMatchObject({ incident_id: expect.any(String), at_risk: expect.any(Array) });
    expect(body.links).toBeUndefined();
  });

  test('critical when the blast radius is non-empty, and the summary counts it', () => {
    const body = renderPagerDuty(event(opened(incident({ blast_radius: ['checkoutservice'] }))), 'k');
    expect(body.payload!.severity).toBe('critical');
    expect(body.payload!.summary).toContain('blast radius 1 service: checkoutservice');
  });

  test('resolve carries the same dedup_key and nothing else', () => {
    const trigger = renderPagerDuty(event(opened()), 'k');
    const resolve = renderPagerDuty(event(resolvedRecord()), 'k');
    expect(resolve).toEqual({ routing_key: 'k', event_action: 'resolve', dedup_key: trigger.dedup_key });
  });

  test('summary never exceeds PagerDuty\'s 1024 characters; link only when configured', () => {
    const many = Array.from({ length: 50 }, (_, i) => `service-${i}-${'y'.repeat(60)}`);
    const body = renderPagerDuty(event(opened(incident({ blast_radius: many, root_cause: 'r'.repeat(500) }))), 'k', {
      dashboardUrl: 'https://dash.example',
    });
    expect(body.payload!.summary.length).toBeLessThanOrEqual(1024);
    expect(body.payload!.component.length).toBeLessThanOrEqual(255);
    expect(body.links).toEqual([{ href: 'https://dash.example', text: 'RCA dashboard' }]);
  });
});
