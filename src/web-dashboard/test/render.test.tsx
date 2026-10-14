import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/api';
import { bannerMessage } from '../src/components/Banner';
import { IncidentDetail, NodeDetail } from '../src/components/Detail';
import { IncidentList } from '../src/components/IncidentList';
import { incidentsGolden, topologyGolden } from './fixtures';

const open = incidentsGolden.incidents.find((i) => i.status === 'OPEN')!;
const resolved = incidentsGolden.incidents.find((i) => i.status === 'RESOLVED')!;
const NOW = open.opened_at_ms + 4 * 60_000;
const noop = () => undefined;

describe('IncidentList', () => {
  test('shows severity, confidence, blast radius count and age for an open incident', () => {
    const html = renderToStaticMarkup(
      <IncidentList title="Open incidents" incidents={[open]} selectedId={undefined} nowMs={NOW} emptyText="none" onSelect={noop} />,
    );
    expect(html).toContain('productcatalogservice');
    expect(html).toContain('critical');
    expect(html).toContain('99.4% confidence');
    expect(html).toContain('1 affected');
    expect(html).toContain('opened 4 min ago');
    expect(html).toContain('aria-pressed="false"');
  });

  test('a resolved incident shows how long it lasted; the selected one is marked', () => {
    const html = renderToStaticMarkup(
      <IncidentList
        title="Recently resolved"
        incidents={[resolved]}
        selectedId={resolved.incident_id}
        nowMs={NOW}
        emptyText="none"
        onSelect={noop}
      />,
    );
    expect(html).toContain('lasted');
    expect(html).toContain('aria-pressed="true"');
  });

  test('before the feed has answered there is no count, so "0" never reads as "nothing open"', () => {
    const html = renderToStaticMarkup(
      <IncidentList title="Open incidents" incidents={[]} loaded={false} selectedId={undefined} nowMs={NOW} emptyText="Loading…" onSelect={noop} />,
    );
    expect(html).not.toContain('class="count"');
    expect(html).toContain('Loading…');
    const loaded = renderToStaticMarkup(
      <IncidentList title="Open incidents" incidents={[]} loaded selectedId={undefined} nowMs={NOW} emptyText="none" onSelect={noop} />,
    );
    expect(loaded).toContain('class="count"');
  });

  test('empty state says why', () => {
    const html = renderToStaticMarkup(
      <IncidentList title="Open incidents" incidents={[]} selectedId={undefined} nowMs={NOW} emptyText="No open incidents." onSelect={noop} />,
    );
    expect(html).toContain('No open incidents.');
    expect(html).not.toContain('<ul');
  });
});

describe('detail panels', () => {
  test('incident detail: evidence sorted by rise, ranking, and chips for the affected services', () => {
    const html = renderToStaticMarkup(<IncidentDetail incident={open} nowMs={NOW} onSelectNode={noop} />);
    expect(html.indexOf('productcatalogservice')).toBeLessThan(html.indexOf('checkoutservice'));
    expect(html).toContain('+720%');
    expect(html).toContain('Model ranking');
    expect(html).toContain('Callers at risk');
    expect(html).toContain('model rca-gat-small-2026-10-12');
  });

  test('node detail: status, volume, baseline, neighbours and incidents', () => {
    const node = topologyGolden.nodes.find((n) => n.id === 'checkoutservice')!;
    const html = renderToStaticMarkup(
      <NodeDetail
        node={node}
        callers={topologyGolden.edges.filter((e) => e.target === node.id)}
        callees={topologyGolden.edges.filter((e) => e.source === node.id)}
        incidents={[open]}
        onSelectNode={noop}
        onSelectIncident={noop}
      />,
    );
    expect(html).toContain('Affected');
    expect(html).toContain('not learned yet');
    expect(html).toContain('Called by');
    expect(html).toContain('affected · open');
  });
});

describe('bannerMessage', () => {
  const base = {
    topologyState: 'live',
    incidentsState: 'live',
    error: undefined,
    lastUpdatedMs: NOW - 90_000,
    nowMs: NOW,
    truncated: false,
  } as const;

  test('says nothing when everything is fine', () => {
    expect(bannerMessage(base)).toBeUndefined();
  });

  test('unreachable is an error and says how old the data on screen is', () => {
    const m = bannerMessage({ ...base, topologyState: 'unreachable', error: new ApiError(502, 'upstream data store unavailable') })!;
    expect(m.tone).toBe('error');
    expect(m.text).toContain('HTTP 502');
    expect(m.text).toContain('1 min ago');
  });

  test('stale warns, unavailable informs, truncation informs', () => {
    expect(bannerMessage({ ...base, incidentsState: 'stale' })!.tone).toBe('warn');
    expect(bannerMessage({ ...base, topologyState: 'unavailable' })!.text).toContain('not deployed');
    expect(bannerMessage({ ...base, truncated: true })!.text).toContain('busiest calls');
  });

  test('a network failure without a status does not print "HTTP undefined"', () => {
    const m = bannerMessage({ ...base, incidentsState: 'unreachable', error: new ApiError(undefined, 'the API is unreachable') })!;
    expect(m.text).not.toContain('undefined');
  });
});
