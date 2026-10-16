// Stage 9b checkpoint. Run after `npm run deploy:neptune`; uses only the AWS CLI (and, optionally,
// `docker exec` against the local Neo4j). Neptune has no public endpoint, so every query goes through
// the in-VPC probe Lambda. It WRITES to the graph (self-test vertices, then the Stage 2 subset);
// that is the point of this stage, and `clear` runs first. Exits non-zero on any failure.
//
//   npm run verify:neptune                  # top 2,000 edges
//   npm run verify:neptune -- --full        # all 16,115 edges
//   npm run verify:neptune -- --limit=500
//   npm run verify:neptune -- --skip-neo4j
import * as fs from 'node:fs';
import * as path from 'node:path';
import { awsJson, Check, report } from './aws-cli';
import { makeProbeInvoker, ProbeResult } from './probe-client';
import { neo4jBaseline } from './neo4j-baseline';
import {
  compareStats,
  CsvNode,
  expectedStats,
  GraphStats,
  parseEdgesCsv,
  parseNodesCsv,
  selectSubset,
} from './neptune-parity';

const ROOT = path.resolve(__dirname, '..', '..');
const PROCESSED = path.join(ROOT, 'Dataset', 'processed');
const NODE_BATCH = 500;
const EDGE_BATCH = 250;

const args = process.argv.slice(2);
const full = args.includes('--full');
const skipNeo4j = args.includes('--skip-neo4j');
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = full ? undefined : limitArg ? Number(limitArg.split('=')[1]) : 2000;
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
  console.log(`FAIL  invalid --limit: ${limitArg}`);
  process.exit(1);
}

function stackOutputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

const out = stackOutputs('NeptuneStack');
const clusterId = out.ClusterIdentifier;
const probeName = out.ProbeFunctionName;
if (!clusterId || !probeName) {
  console.log('FAIL  NeptuneStack: not deployed (no ClusterIdentifier/ProbeFunctionName output) -- run npm run deploy:neptune first');
  process.exit(1);
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

// --- 1. Control plane: what CloudFormation actually built --------------------------------------
const cluster = awsJson<{
  DBClusters: {
    Status: string;
    EngineVersion: string;
    StorageEncrypted: boolean;
    KmsKeyId?: string;
    IAMDatabaseAuthenticationEnabled: boolean;
    DeletionProtection: boolean;
    DBSubnetGroup: string;
  }[];
}>(['neptune', 'describe-db-clusters', '--db-cluster-identifier', clusterId]);
const c = cluster.value?.DBClusters?.[0];
add({
  name: 'Cluster available',
  ok: c?.Status === 'available',
  detail: cluster.error ?? `${clusterId} is ${c?.Status}, engine ${c?.EngineVersion}`,
});
add({
  name: 'Cluster encryption and IAM auth',
  ok: !!c && c.StorageEncrypted && !!c.KmsKeyId && c.IAMDatabaseAuthenticationEnabled && !c.DeletionProtection,
  detail: c
    ? `encrypted=${c.StorageEncrypted}, kms=${c.KmsKeyId ? 'customer-managed key' : 'none'}, iamAuth=${c.IAMDatabaseAuthenticationEnabled}, deletionProtection=${c.DeletionProtection}`
    : 'cluster not found',
});

const instances = awsJson<{ DBInstances: { DBInstanceIdentifier: string; DBInstanceStatus: string; PubliclyAccessible: boolean; AvailabilityZone: string; DBInstanceClass: string }[] }>([
  'neptune', 'describe-db-instances', '--filters', `Name=db-cluster-id,Values=${clusterId}`,
]);
const members = instances.value?.DBInstances ?? [];
add({
  name: 'Instances available and private',
  ok: members.length > 0 && members.every((i) => i.DBInstanceStatus === 'available' && !i.PubliclyAccessible),
  detail: instances.error ?? (members.map((i) => `${i.DBInstanceClass}@${i.AvailabilityZone}:${i.DBInstanceStatus}`).join(', ') || 'none'),
});

if (c) {
  const sg = awsJson<{ DBSubnetGroups: { Subnets: { SubnetIdentifier: string }[] }[] }>([
    'neptune', 'describe-db-subnet-groups', '--db-subnet-group-name', c.DBSubnetGroup,
  ]);
  const ids = sg.value?.DBSubnetGroups?.[0]?.Subnets?.map((s) => s.SubnetIdentifier) ?? [];
  const subnets = ids.length
    ? awsJson<{ Subnets: { Tags?: { Key: string; Value: string }[] }[] }>(['ec2', 'describe-subnets', '--subnet-ids', ...ids])
    : { value: undefined, error: sg.error ?? 'no subnets in the subnet group' };
  const tiers = (subnets.value?.Subnets ?? []).map((s) => s.Tags?.find((t) => t.Key === 'aws-cdk:subnet-name')?.Value);
  add({
    name: 'Subnet group is private-data only',
    ok: tiers.length >= 2 && tiers.every((t) => t === 'private-data'),
    detail: subnets.error ?? `tiers: ${tiers.join(', ')}`,
  });
}

// --- 2. Data plane, through the probe ---------------------------------------------------------
const invoke = makeProbeInvoker(probeName);

function runProbe(label: string, payload: unknown): ProbeResult | undefined {
  const r = invoke(payload);
  if (!r.value) {
    add({ name: label, ok: false, detail: r.error ?? 'no result' });
    return undefined;
  }
  for (const pc of r.value.checks ?? []) {
    add({ name: `${label}: ${pc.name}`, ok: pc.ok, warn: !pc.ok && pc.informational, detail: pc.detail });
  }
  return r.value;
}

const status = runProbe('Signed access', { action: 'status' });
runProbe('IAM enforcement', { action: 'unsigned' });

if (status?.ok) {
  runProbe('Writer smoke test', { action: 'smoke' });
  runProbe('Concurrency', { action: 'concurrency', writers: 8 });
} else {
  add({ name: 'Writer smoke test / concurrency', ok: false, detail: 'skipped: signed access to Neptune did not work' });
}

// --- 3. Parity with Stage 2 -------------------------------------------------------------------
if (status?.ok) {
  let nodes: CsvNode[];
  let subset: ReturnType<typeof selectSubset>;
  try {
    nodes = parseNodesCsv(fs.readFileSync(path.join(PROCESSED, 'nodes.csv'), 'utf8'));
    subset = selectSubset(parseEdgesCsv(fs.readFileSync(path.join(PROCESSED, 'edges.csv'), 'utf8')), nodes, limit);
  } catch (err) {
    add({ name: 'Read Stage 2 CSVs', ok: false, detail: `${(err as Error).message} (regenerate with Dataset/preprocess_traces.py)` });
    process.exit(report(checks) ? 0 : 1);
  }
  const scope = limit === undefined ? 'full graph' : `top ${limit} edges`;
  console.log(`Parity subset (${scope}): ${subset.nodes.length} nodes, ${subset.edges.length} edges`);

  const cleared = runProbe('Reset graph before parity load', { action: 'clear' });
  let loaded = !!cleared;
  for (let i = 0; loaded && i < subset.nodes.length; i += NODE_BATCH) {
    loaded = !!runProbe('Load nodes', { action: 'load', nodes: subset.nodes.slice(i, i + NODE_BATCH) });
  }
  for (let i = 0; loaded && i < subset.edges.length; i += EDGE_BATCH) {
    loaded = !!runProbe('Load edges', { action: 'load', edges: subset.edges.slice(i, i + EDGE_BATCH) });
  }

  add({
    name: 'Parity load',
    ok: loaded,
    detail: loaded ? `${subset.nodes.length} nodes and ${subset.edges.length} edges written` : 'a load step failed (see above)',
  });

  if (loaded) {
    const stats = runProbe('Read statistics', { action: 'stats' })?.stats;
    if (stats) {
      const fromCsv = expectedStats(subset.nodes, subset.edges);
      for (const check of compareStats('Neptune vs Stage 2 CSV', fromCsv, stats)) add(check);

      // Independent baseline: what the Stage 2 Neo4j holds for the same subset.
      const neo = skipNeo4j ? { skipped: 'skipped (--skip-neo4j)' } : neo4jBaseline(limit);
      if ('stats' in neo) {
        for (const check of compareStats('Neptune vs Stage 2 Neo4j', neo.stats, stats)) add(check);
        for (const check of compareStats('Neo4j vs CSV (Stage 2 load)', fromCsv, neo.stats)) add(check);
      } else {
        // Not a failure of Neptune: the CSV comparison above is then the only baseline.
        add({ name: 'Neo4j baseline', ok: false, warn: true, detail: `${neo.skipped}; Neptune was compared against the CSV only` });
      }
    }
  }
}

process.exit(report(checks) ? 0 : 1);
