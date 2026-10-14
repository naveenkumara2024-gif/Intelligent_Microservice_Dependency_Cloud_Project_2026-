import { describe, expect, test } from 'vitest';
import { incidentsGolden, topologyGolden } from './fixtures';

const STATUSES = ['healthy', 'root_cause', 'affected', 'at_risk'];

describe('API contract v1 (the golden files the Lambda tests write)', () => {
  test('topology has exactly the fields the dashboard reads', () => {
    expect(Object.keys(topologyGolden).sort()).toEqual([
      'edges',
      'generated_at_ms',
      'nodes',
      'open_incidents',
      'schema_version',
      'truncated',
    ]);
    expect(topologyGolden.schema_version).toBe(1);
    for (const n of topologyGolden.nodes) {
      expect(Object.keys(n).sort()).toEqual(['baseline_ms', 'calls_as_callee', 'calls_as_caller', 'id', 'incident_id', 'status']);
      expect(STATUSES).toContain(n.status);
      expect(n.baseline_ms === null || typeof n.baseline_ms === 'number').toBe(true);
    }
    for (const e of topologyGolden.edges) {
      expect(Object.keys(e).sort()).toEqual(['avg_latency_ms', 'call_count', 'p95_latency_ms', 'source', 'target']);
    }
  });

  test('every edge endpoint is a node, and every flagged node names an open incident', () => {
    const ids = new Set(topologyGolden.nodes.map((n) => n.id));
    for (const e of topologyGolden.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    for (const n of topologyGolden.nodes) {
      if (n.status === 'healthy') expect(n.incident_id).toBeNull();
      else expect(topologyGolden.open_incidents).toContain(n.incident_id);
    }
  });

  test('incident views carry the fields the panels render', () => {
    expect(incidentsGolden.count).toBe(incidentsGolden.incidents.length);
    for (const i of incidentsGolden.incidents) {
      expect(Object.keys(i).sort()).toEqual(
        [
          'at_risk',
          'blast_radius',
          'evidence',
          'incident_id',
          'last_seen_ms',
          'model_version',
          'opened_at_ms',
          'peak_score',
          'resolved_at_ms',
          'root_cause',
          'score',
          'severity',
          'status',
          'top_candidates',
          'windows',
        ].sort(),
      );
      expect(['OPEN', 'RESOLVED']).toContain(i.status);
      expect(['error', 'critical']).toContain(i.severity);
      if (i.status === 'RESOLVED') expect(typeof i.resolved_at_ms).toBe('number');
      else expect(i.resolved_at_ms).toBeNull();
    }
  });

  test('the open incident in the topology is the open incident in the list', () => {
    const open = incidentsGolden.incidents.filter((i) => i.status === 'OPEN').map((i) => i.incident_id);
    expect(topologyGolden.open_incidents).toEqual(open);
  });
});
