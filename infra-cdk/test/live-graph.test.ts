import { growth, liveChecks, MAX_STALENESS_MS, SPAN_EMITTING_SERVICES, summarize } from '../scripts/live-graph';
import type { LiveEdge } from '../scripts/probe-client';

const edge = (um: string, dm: string, call_count = 10, last_seen_ms = 1_000_000): LiveEdge => ({
  um,
  dm,
  call_count,
  latency_sum_ms: call_count * 5,
  last_seen_ms,
});
const configured = [
  { um: 'frontend', dm: 'productcatalogservice' },
  { um: 'frontend', dm: 'cartservice' },
  { um: 'checkoutservice', dm: 'paymentservice' },
  { um: 'cartservice', dm: 'redis-cart' },
  { um: 'recommendationservice', dm: 'productcatalogservice' },
];
const NOW = 1_000_000 + 30_000;

describe('summarize', () => {
  test('splits observed edges into matched and unexpected, and finds what is missing', () => {
    const s = summarize(
      [edge('frontend', 'productcatalogservice'), edge('frontend', 'cartservice'), edge('frontend', 'ghost')],
      configured,
    );
    expect(s.matched.map((e) => e.dm).sort()).toEqual(['cartservice', 'productcatalogservice']);
    expect(s.unexpected.map((e) => e.dm)).toEqual(['ghost']);
    // checkout->payment and recommendation->productcatalog come from span-emitting callers and are absent
    expect(s.missingFromEmitters.map((e) => `${e.um}>${e.dm}`).sort()).toEqual([
      'checkoutservice>paymentservice',
      'recommendationservice>productcatalogservice',
    ]);
  });

  test('cartservice and redis are not span emitters, so their edges are never "missing"', () => {
    const s = summarize([], configured);
    expect(s.missingFromEmitters.some((e) => e.um === 'cartservice')).toBe(false);
    expect(SPAN_EMITTING_SERVICES).not.toContain('cartservice');
  });

  test('an edge from a non-emitting service is flagged as impossible', () => {
    const s = summarize([edge('cartservice', 'redis-cart')], configured);
    expect(s.fromNonEmitters).toHaveLength(1);
  });
});

describe('growth', () => {
  test('sums calls and takes the newest timestamp', () => {
    const g = growth([edge('a', 'b', 3, 100)], [edge('a', 'b', 8, 250), edge('a', 'c', 2, 400)]);
    expect(g).toEqual({ callsBefore: 3, callsAfter: 10, edgesBefore: 1, edgesAfter: 2, newestBefore: 100, newestAfter: 400 });
  });
});

describe('liveChecks', () => {
  const live = [
    edge('frontend', 'productcatalogservice', 50),
    edge('frontend', 'cartservice', 40),
    edge('checkoutservice', 'paymentservice', 30),
  ];
  const before = live.map((e) => ({ ...e, call_count: e.call_count - 5, last_seen_ms: e.last_seen_ms - 5000 }));

  test('a healthy live graph passes everything', () => {
    const checks = liveChecks(summarize(live, configured), growth(before, live), NOW);
    expect(checks.filter((c) => !c.ok && !c.warn)).toEqual([]);
  });

  test('no growth between samples is a failure (data is stale, not live)', () => {
    const checks = liveChecks(summarize(live, configured), growth(live, live), NOW);
    expect(checks.find((c) => c.name.startsWith('Counters are growing'))!.ok).toBe(false);
  });

  test('an old newest-timestamp fails the recency check', () => {
    const old = live.map((e) => ({ ...e, last_seen_ms: NOW - MAX_STALENESS_MS - 1 }));
    const checks = liveChecks(summarize(old, configured), growth(before, old), NOW);
    expect(checks.find((c) => c.name === 'Newest span is recent')!.ok).toBe(false);
  });

  test('a newest span a few seconds in the future (clock skew) is fine; far in the future is not', () => {
    const skewed = live.map((e) => ({ ...e, last_seen_ms: NOW + 4000 }));
    const ok = liveChecks(summarize(skewed, configured), growth(before, skewed), NOW);
    expect(ok.find((c) => c.name === 'Newest span is recent')!.ok).toBe(true);
    const wrong = live.map((e) => ({ ...e, last_seen_ms: NOW + 10 * 60 * 1000 }));
    const bad = liveChecks(summarize(wrong, configured), growth(before, wrong), NOW);
    expect(bad.find((c) => c.name === 'Newest span is recent')!.ok).toBe(false);
  });

  test('too few matched edges fails; unexpected names are a warning, not a failure', () => {
    const odd = [edge('frontend', 'productcatalogservice'), edge('frontend', 'x1'), edge('frontend', 'x2')];
    const checks = liveChecks(summarize(odd, configured), growth([], odd), NOW);
    expect(checks.find((c) => c.name.startsWith('Edges match'))!.ok).toBe(false);
    const warn = checks.find((c) => c.name === 'Edges not in the configured topology')!;
    expect(warn.warn).toBe(true);
  });

  test('an empty graph fails cleanly', () => {
    const checks = liveChecks(summarize([], configured), growth([], []), NOW);
    expect(checks.every((c) => !c.ok || c.name === 'Only span-emitting services appear as callers')).toBe(true);
  });
});
