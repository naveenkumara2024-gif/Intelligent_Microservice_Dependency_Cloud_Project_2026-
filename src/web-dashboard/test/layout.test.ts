import { describe, expect, test } from 'vitest';
import { layeredPositions } from '../src/layout';
import { topologyGolden } from './fixtures';

const call = (source: string, target: string) => ({ source, target });
const nodes = (...ids: string[]) => ids.map((id) => ({ id }));

describe('layeredPositions on the golden topology', () => {
  const pos = layeredPositions(topologyGolden);
  const row = (id: string) => pos[id].y;

  test('every node gets a distinct position', () => {
    expect(Object.keys(pos).sort()).toEqual(topologyGolden.nodes.map((n) => n.id).sort());
    expect(new Set(Object.values(pos).map((p) => `${p.x},${p.y}`)).size).toBe(topologyGolden.nodes.length);
  });

  test('every call goes downward: a caller is always above its callee', () => {
    for (const e of topologyGolden.edges) expect(row(e.source)).toBeLessThan(row(e.target));
  });

  test('longest-path layering: the catalog sits below checkout, which sits below the frontend', () => {
    expect(row('frontend')).toBe(0);
    expect(row('checkoutservice')).toBe(row('recommendationservice'));
    expect(row('productcatalogservice')).toBeGreaterThan(row('checkoutservice'));
    expect(row('currencyservice')).toBe(row('productcatalogservice'));
  });

  test('no edge passes through a third node (the defect that made the first screenshot misleading)', () => {
    for (const e of topologyGolden.edges) {
      const a = pos[e.source];
      const b = pos[e.target];
      for (const [id, p] of Object.entries(pos)) {
        if (id === e.source || id === e.target) continue;
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        const within =
          p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
        expect(Math.abs(cross) < 1e-6 && within, `${e.source}->${e.target} passes through ${id}`).toBe(false);
      }
    }
  });

  test('deterministic: the same input always yields the same layout', () => {
    expect(layeredPositions(topologyGolden)).toEqual(layeredPositions(structuredClone(topologyGolden)));
  });
});

describe('layeredPositions edge cases', () => {
  test('a cycle, a self-loop, a duplicate and an unknown endpoint do not break it', () => {
    const p = layeredPositions({
      nodes: nodes('a', 'b', 'c'),
      edges: [call('a', 'b'), call('b', 'c'), call('c', 'a'), call('b', 'b'), call('a', 'b'), call('a', 'ghost')],
    });
    expect(Object.keys(p).sort()).toEqual(['a', 'b', 'c']);
    expect(p.a.y).toBeLessThan(p.b.y);
    expect(p.b.y).toBeLessThan(p.c.y);
  });

  test('disconnected nodes share the top row; an empty graph is an empty layout', () => {
    const p = layeredPositions({ nodes: nodes('x', 'y', 'z'), edges: [] });
    expect(new Set(Object.values(p).map((v) => v.y))).toEqual(new Set([0]));
    expect(layeredPositions({ nodes: [], edges: [] })).toEqual({});
  });

  test('a diamond puts both middle nodes on one row and the sink below them', () => {
    const p = layeredPositions({
      nodes: nodes('top', 'l', 'r', 'sink'),
      edges: [call('top', 'l'), call('top', 'r'), call('l', 'sink'), call('r', 'sink')],
    });
    expect(p.l.y).toBe(p.r.y);
    expect(p.sink.y).toBeGreaterThan(p.l.y);
    expect(p.top.y).toBeLessThan(p.l.y);
  });
});
