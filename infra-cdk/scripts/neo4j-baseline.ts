// Reads the Stage 2 Neo4j prototype (docker container rca-neo4j) for the same deterministic subset
// the Neptune parity check loads, so Neptune can be compared with the independent Stage 2 result
// and not only with the CSV it was loaded from. Read-only.
import { spawnSync } from 'node:child_process';
import { CsvNode, expectedStats, GraphStats } from './neptune-parity';

export const NEO4J_CONTAINER = 'rca-neo4j';

/** Rows of `cypher-shell --format plain` output: a header line, then comma-separated values. */
export function plainRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(',').map((x) => x.trim().replace(/^"|"$/g, '')));
}

/** Same ORDER BY as selectSubset, so both sides pick the same edges when call_counts tie. */
export function rankedEdgesQuery(limit: number | undefined): string {
  const lim = limit === undefined ? '' : ` LIMIT ${limit}`;
  return `MATCH (a:Service)-[r:CALLS]->(b:Service) WITH a, b, r ORDER BY r.call_count DESC, a.name ASC, b.name ASC${lim}`;
}

export type Baseline = { stats: GraphStats } | { skipped: string };

export function neo4jBaseline(limit: number | undefined): Baseline {
  const running = spawnSync('docker', ['ps', '--filter', `name=^${NEO4J_CONTAINER}$`, '--format', '{{.Names}}'], {
    encoding: 'utf8',
  });
  if (running.status !== 0 || !running.stdout.trim()) {
    return { skipped: `Neo4j container ${NEO4J_CONTAINER} is not running (docker compose up -d neo4j)` };
  }
  const cypher = (query: string) =>
    spawnSync(
      'docker',
      ['exec', NEO4J_CONTAINER, 'cypher-shell', '-u', 'neo4j', '-p', process.env.NEO4J_PASSWORD ?? 'changeme123', '--format', 'plain', query],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  const ranked = rankedEdgesQuery(limit);
  const edgeRes = cypher(`${ranked} RETURN a.name AS um, b.name AS dm, r.call_count AS call_count`);
  const nodeRes = cypher(
    `${ranked} WITH collect(DISTINCT a) + collect(DISTINCT b) AS ns UNWIND ns AS n ` +
      'RETURN DISTINCT n.name AS name, n.total_calls_as_um AS um, n.total_calls_as_dm AS dm',
  );
  if (edgeRes.status !== 0 || nodeRes.status !== 0) {
    return { skipped: `cypher-shell failed: ${(edgeRes.stderr || nodeRes.stderr || '').trim().slice(0, 160)}` };
  }
  const edges = plainRows(edgeRes.stdout).map(([um, dm, n]) => ({ um, dm, call_count: Number(n) }));
  const nodes: CsvNode[] = plainRows(nodeRes.stdout).map(([name, um, dm]) => ({
    name,
    total_calls_as_um: Number(um),
    total_calls_as_dm: Number(dm),
  }));
  if (edges.length === 0) {
    return { skipped: 'Neo4j is running but holds no CALLS edges (run Dataset/load_to_neo4j.py)' };
  }
  return { stats: expectedStats(nodes, edges) };
}
