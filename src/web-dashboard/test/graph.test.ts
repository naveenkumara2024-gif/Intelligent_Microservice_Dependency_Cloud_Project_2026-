import { describe, expect, test } from 'vitest';
import {
  describeNode,
  edgeId,
  edgeWidth,
  incidentNodeIds,
  incidentsFor,
  layoutKey,
  edgeLabel,
  nodeClasses,
  roleIn,
  statusCounts,
  toElements,
} from '../src/graph';
import { incidentsGolden, topologyGolden } from './fixtures';

type Elements = ReturnType<typeof toElements>;
const nodes = (els: Elements) => els.filter((e) => e.group === 'nodes');
const edges = (els: Elements) => els.filter((e) => e.group === 'edges');

describe('toElements', () => {
  const els = toElements(topologyGolden);

  test('one element per node and per edge, ids stable', () => {
    expect(nodes(els)).toHaveLength(topologyGolden.nodes.length);
    expect(edges(els)).toHaveLength(topologyGolden.edges.length);
    expect(edges(els)[0].data.id).toBe(edgeId(topologyGolden.edges[0]));
  });

  test('status becomes the class, so styling can key on it', () => {
    const byId = Object.fromEntries(nodes(els).map((n) => [n.data.id, n.classes]));
    expect(byId.productcatalogservice).toBe('root_cause degraded');
    expect(byId.checkoutservice).toBe('affected');
    expect(byId.frontend).toBe('at_risk');
    expect(byId.paymentservice).toBe('healthy');
  });

  test('calls into a degraded service are the hot path', () => {
    const hot = edges(els)
      .filter((e) => e.classes === 'hot')
      .map((e) => e.data.target);
    expect(hot.length).toBeGreaterThan(0);
    expect(new Set(hot)).toEqual(new Set(['productcatalogservice', 'checkoutservice']));
  });

  test('edge width stays within bounds; the label is the RECENT latency, not the lifetime one', () => {
    for (const e of edges(els)) {
      expect(e.data.width).toBeGreaterThanOrEqual(1.5);
      expect(e.data.width).toBeLessThanOrEqual(5);
    }
    const slow = edges(els).find((e) => e.data.source === 'checkoutservice' && e.data.target === 'productcatalogservice')!;
    expect(slow.data.label).toBe('60.0 ms');
    expect(slow.data.avg_latency_ms).toBeCloseTo(26.67, 2);
  });

  test('before the scorer has a snapshot, labels fall back to the lifetime average', () => {
    const t = { ...topologyGolden, recent_window_ms: null };
    const slow = edges(toElements(t)).find((e) => e.data.source === 'checkoutservice' && e.data.target === 'productcatalogservice')!;
    expect(slow.data.label).toBe('26.7 ms');
  });

  test('a service slow right now is marked and its incoming calls are hot, even with no incident yet', () => {
    const t = {
      ...topologyGolden,
      open_incidents: [],
      nodes: topologyGolden.nodes.map((n) => ({ ...n, status: 'healthy' as const, incident_id: null })),
    };
    const els2 = toElements(t);
    const byId = Object.fromEntries(nodes(els2).map((n) => [n.data.id, n.classes]));
    expect(byId.productcatalogservice).toBe('healthy degraded');
    expect(byId.paymentservice).toBe('healthy');
    const hot = new Set(edges(els2).filter((e) => e.classes === 'hot').map((e) => e.data.target));
    expect(hot).toEqual(new Set(['productcatalogservice']));
  });

  test('an edge whose endpoint is not a node is dropped rather than crashing the layout', () => {
    const t = {
      ...topologyGolden,
      edges: [
        ...topologyGolden.edges,
        { source: 'a', target: 'ghost', call_count: 1, avg_latency_ms: 1, p95_latency_ms: null, recent_calls: 0, recent_avg_latency_ms: null },
      ],
    };
    expect(edges(toElements(t))).toHaveLength(topologyGolden.edges.length);
  });
});

describe('helpers', () => {
  test('edgeLabel: recent latency, "idle" without recent calls, lifetime only without a window', () => {
    const e = { source: 'a', target: 'b', call_count: 9, avg_latency_ms: 46, p95_latency_ms: null, recent_calls: 30, recent_avg_latency_ms: 0.4 };
    expect(edgeLabel(e, true)).toBe('0.40 ms');
    expect(edgeLabel({ ...e, recent_calls: 0, recent_avg_latency_ms: null }, true)).toBe('idle');
    expect(edgeLabel(e, false)).toBe('46.0 ms');
  });

  test('nodeClasses adds degraded on top of the status', () => {
    const n = topologyGolden.nodes[0];
    expect(nodeClasses({ ...n, status: 'at_risk', degraded: false })).toBe('at_risk');
    expect(nodeClasses({ ...n, status: 'at_risk', degraded: true })).toBe('at_risk degraded');
  });

  test('edgeWidth is monotonic, square-root scaled and safe on zero', () => {
    expect(edgeWidth(0, 100)).toBe(1.5);
    expect(edgeWidth(5, 0)).toBe(1.5);
    expect(edgeWidth(100, 100)).toBeCloseTo(5, 5);
    expect(edgeWidth(25, 100)).toBeCloseTo(1.5 + 3.5 * 0.5, 5);
    expect(edgeWidth(10, 100)).toBeLessThan(edgeWidth(50, 100));
    expect(edgeWidth(500, 100)).toBeCloseTo(5, 5);
  });

  test('layoutKey ignores values but changes with structure', () => {
    const same = structuredClone(topologyGolden);
    same.edges[0].call_count += 999;
    same.generated_at_ms += 10_000;
    same.nodes[0].status = 'root_cause';
    expect(layoutKey(same)).toBe(layoutKey(topologyGolden));

    const added = structuredClone(topologyGolden);
    added.nodes.push({ ...added.nodes[0], id: 'new-service' });
    expect(layoutKey(added)).not.toBe(layoutKey(topologyGolden));
  });

  test('status counts add up to the node count', () => {
    const c = statusCounts(topologyGolden);
    expect(c).toEqual({ root_cause: 1, affected: 1, at_risk: 2, healthy: 3 });
    expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(topologyGolden.nodes.length);
  });

  test('an incident lights up its root cause, blast radius and callers at risk', () => {
    const open = incidentsGolden.incidents.find((i) => i.status === 'OPEN')!;
    expect(incidentNodeIds(open)).toEqual(new Set(['productcatalogservice', 'checkoutservice', 'frontend', 'recommendationservice']));
    expect(incidentNodeIds(undefined).size).toBe(0);
  });

  test('incidentsFor lists open before resolved, newest first, and roleIn names the role', () => {
    const open = incidentsGolden.incidents.find((i) => i.status === 'OPEN')!;
    const old = { ...open, incident_id: 'old', status: 'RESOLVED' as const, opened_at_ms: open.opened_at_ms - 1000 };
    const mid = { ...open, incident_id: 'mid', opened_at_ms: open.opened_at_ms - 500 };
    expect(incidentsFor('checkoutservice', [old, mid, open]).map((i) => i.incident_id)).toEqual([open.incident_id, 'mid', 'old']);
    expect(roleIn('productcatalogservice', open)).toBe('root cause');
    expect(roleIn('checkoutservice', open)).toBe('affected');
    expect(roleIn('frontend', open)).toBe('at risk');
    expect(roleIn('paymentservice', open)).toBeUndefined();
    expect(incidentsFor('paymentservice', [open])).toEqual([]);
  });

  test('describeNode summarizes volume and baseline', () => {
    const frontend = topologyGolden.nodes.find((n) => n.id === 'frontend')!;
    expect(describeNode(frontend)).toBe('0 calls received · 600 calls made · baseline 10.0 ms');
  });
});
