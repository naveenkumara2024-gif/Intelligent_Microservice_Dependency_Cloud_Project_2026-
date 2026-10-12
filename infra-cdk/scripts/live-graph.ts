// Pure logic for the Stage 9c live check: are real Online Boutique spans becoming the graph?
// No AWS here; unit-tested in test/live-graph.test.ts. The verify script feeds it probe output.
import type { Check } from './aws-cli';
import type { LiveEdge } from './probe-client';

export interface TopologyEdge {
  um: string;
  dm: string;
}

/** The services that emit OTel spans in the vendored Online Boutique (Stage 6 finding): only they
 * report outgoing calls, so only edges FROM these services can ever appear. */
export const SPAN_EMITTING_SERVICES = [
  'frontend',
  'checkoutservice',
  'currencyservice',
  'emailservice',
  'paymentservice',
  'productcatalogservice',
  'recommendationservice',
];

const key = (um: string, dm: string) => `${um}\u0000${dm}`;

export interface LiveSummary {
  total: number;
  /** Observed edges that are in the manifest-derived topology. */
  matched: LiveEdge[];
  /** Observed edges the manifest does not configure (naming differences, or traffic we did not expect). */
  unexpected: LiveEdge[];
  /** Configured edges whose caller emits spans but that were not observed (yet). */
  missingFromEmitters: TopologyEdge[];
  /** Observed edges whose caller is NOT a span-emitting service: should be impossible. */
  fromNonEmitters: LiveEdge[];
}

export function summarize(observed: LiveEdge[], configured: TopologyEdge[]): LiveSummary {
  const want = new Set(configured.map((e) => key(e.um, e.dm)));
  const seen = new Set(observed.map((e) => key(e.um, e.dm)));
  const emitters = new Set(SPAN_EMITTING_SERVICES);
  return {
    total: observed.length,
    matched: observed.filter((e) => want.has(key(e.um, e.dm))),
    unexpected: observed.filter((e) => !want.has(key(e.um, e.dm))),
    missingFromEmitters: configured.filter((e) => emitters.has(e.um) && !seen.has(key(e.um, e.dm))),
    fromNonEmitters: observed.filter((e) => !emitters.has(e.um)),
  };
}

export interface Growth {
  callsBefore: number;
  callsAfter: number;
  edgesBefore: number;
  edgesAfter: number;
  newestBefore: number;
  newestAfter: number;
}

export function growth(before: LiveEdge[], after: LiveEdge[]): Growth {
  const sum = (edges: LiveEdge[]) => edges.reduce((s, e) => s + e.call_count, 0);
  const newest = (edges: LiveEdge[]) => edges.reduce((m, e) => Math.max(m, e.last_seen_ms), 0);
  return {
    callsBefore: sum(before),
    callsAfter: sum(after),
    edgesBefore: before.length,
    edgesAfter: after.length,
    newestBefore: newest(before),
    newestAfter: newest(after),
  };
}

/** Maximum plausible age of the newest span timestamp, to catch stale data that is not "live". */
export const MAX_STALENESS_MS = 10 * 60 * 1000;
/**
 * Span timestamps come from the cluster's clocks and "now" from this workstation's, so the newest
 * span can legitimately look a few seconds in the FUTURE (Stage 9c read "-4 s old" on live data).
 */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

export function liveChecks(
  summary: LiveSummary,
  g: Growth,
  now: number,
  minMatched = 3,
): Check[] {
  const checks: Check[] = [];
  checks.push({
    name: 'Graph has edges from live spans',
    ok: summary.total >= minMatched,
    detail: `${summary.total} edges in Neptune`,
  });
  checks.push({
    name: 'Edges match the manifest-derived Boutique topology',
    ok: summary.matched.length >= minMatched,
    detail: `${summary.matched.length} of the configured edges observed (need >= ${minMatched}); e.g. ${
      summary.matched.slice(0, 4).map((e) => `${e.um}->${e.dm}`).join(', ') || 'none'
    }`,
  });
  checks.push({
    name: 'Only span-emitting services appear as callers',
    ok: summary.fromNonEmitters.length === 0,
    detail: summary.fromNonEmitters.length === 0
      ? 'cart/shipping/ad/redis/loadgen have no outgoing edges, as expected'
      : `unexpected callers: ${[...new Set(summary.fromNonEmitters.map((e) => e.um))].join(', ')}`,
  });
  if (summary.unexpected.length > 0) {
    checks.push({
      name: 'Edges not in the configured topology',
      ok: false,
      warn: true,
      detail: `${summary.unexpected.length}, e.g. ${summary.unexpected.slice(0, 4).map((e) => `${e.um}->${e.dm}`).join(', ')} (naming or an unmodelled dependency)`,
    });
  }
  checks.push({
    name: 'Counters are growing (ingestion is live)',
    ok: g.callsAfter > g.callsBefore,
    detail: `total call_count ${g.callsBefore} -> ${g.callsAfter}, edges ${g.edgesBefore} -> ${g.edgesAfter}`,
  });
  const age = now - g.newestAfter;
  checks.push({
    name: 'Newest span is recent',
    ok: g.newestAfter > 0 && age >= -MAX_CLOCK_SKEW_MS && age <= MAX_STALENESS_MS,
    detail:
      g.newestAfter > 0
        ? `${Math.round(age / 1000)} s old${age < 0 ? ' (workstation clock is behind the cluster; within tolerance)' : ''}`
        : 'no last_seen_ms recorded',
  });
  return checks;
}
