// Stage 15: read-only sweep proving nothing billable from this project is left in us-east-1.
// Run by `npm run down` at the end, or on its own: `npm run verify:teardown`.
// Exits non-zero if anything is left or could not be checked. KMS keys in PendingDeletion and small
// orphan log groups are expected after a teardown and are not checked.
import { aws, report } from './aws-cli';
import { Finding, isProjectLambda, isProjectTable, judgeTeardown, TeardownSnapshot } from './session-plan';

/** Runs one read-only query; a failed call or an unexpected response is a failed check, never a pass. */
function find(args: string[], pick: (v: Record<string, unknown>) => string[]): Finding {
  const r = aws(args);
  if (!r.ok) return { error: r.stderr || 'aws CLI call failed' };
  try {
    // `cloudfront list-distributions` prints nothing at all when there are no distributions.
    return { items: pick(r.stdout.trim() === '' ? {} : (JSON.parse(r.stdout) as Record<string, unknown>)) };
  } catch (e) {
    return { error: `unexpected output from aws ${args.slice(0, 2).join(' ')}: ${(e as Error).message}` };
  }
}

/** The list a response must contain; missing means the response is not what we think it is. */
function list<T>(v: Record<string, unknown>, key: string): T[] {
  const value = v[key];
  if (!Array.isArray(value)) throw new Error(`no ${key} in the response`);
  return value as T[];
}

const snapshot: TeardownSnapshot = {
  stacks: find(['cloudformation', 'list-stacks'], (v) =>
    list<{ StackName: string; StackStatus: string }>(v, 'StackSummaries')
      .filter((s) => s.StackStatus !== 'DELETE_COMPLETE')
      .map((s) => `${s.StackName} (${s.StackStatus})`),
  ),
  eksClusters: find(['eks', 'list-clusters'], (v) => list<string>(v, 'clusters')),
  mskClusters: find(['kafka', 'list-clusters-v2'], (v) => list<{ ClusterName: string }>(v, 'ClusterInfoList').map((c) => c.ClusterName)),
  neptuneClusters: find(['neptune', 'describe-db-clusters', '--filters', 'Name=engine,Values=neptune'], (v) =>
    list<{ DBClusterIdentifier: string }>(v, 'DBClusters').map((c) => c.DBClusterIdentifier),
  ),
  sagemakerEndpoints: find(['sagemaker', 'list-endpoints'], (v) => list<{ EndpointName: string }>(v, 'Endpoints').map((e) => e.EndpointName)),
  dynamodbTables: find(['dynamodb', 'list-tables'], (v) => list<string>(v, 'TableNames').filter(isProjectTable)),
  cloudfrontDistributions: find(['cloudfront', 'list-distributions'], (v) => {
    if (v.DistributionList === undefined) return []; // the empty-output case above
    const items = (v.DistributionList as { Items?: { Id: string; Comment: string }[] }).Items ?? [];
    return items.filter((d) => d.Comment === 'RCA dashboard').map((d) => d.Id);
  }),
  projectVpcs: find(['ec2', 'describe-vpcs', '--filters', 'Name=tag:aws:cloudformation:stack-name,Values=VpcStack'], (v) =>
    list<{ VpcId: string }>(v, 'Vpcs').map((x) => x.VpcId),
  ),
  natGateways: find(['ec2', 'describe-nat-gateways', '--filter', 'Name=state,Values=pending,available'], (v) =>
    list<{ NatGatewayId: string }>(v, 'NatGateways').map((n) => n.NatGatewayId),
  ),
  elasticIps: find(['ec2', 'describe-addresses'], (v) => list<{ PublicIp: string }>(v, 'Addresses').map((a) => a.PublicIp)),
  loadBalancers: (() => {
    const v2 = find(['elbv2', 'describe-load-balancers'], (v) =>
      list<{ LoadBalancerName: string }>(v, 'LoadBalancers').map((l) => l.LoadBalancerName),
    );
    const classic = find(['elb', 'describe-load-balancers'], (v) =>
      list<{ LoadBalancerName: string }>(v, 'LoadBalancerDescriptions').map((l) => `${l.LoadBalancerName} (classic)`),
    );
    return v2.items && classic.items ? { items: [...v2.items, ...classic.items] } : { error: v2.error ?? classic.error };
  })(),
  ec2Instances: find(['ec2', 'describe-instances', '--filters', 'Name=instance-state-name,Values=pending,running,stopping,stopped'], (v) =>
    list<{ Instances: { InstanceId: string }[] }>(v, 'Reservations').flatMap((r) => r.Instances.map((i) => i.InstanceId)),
  ),
  lambdaFunctions: find(['lambda', 'list-functions'], (v) =>
    list<{ FunctionName: string }>(v, 'Functions')
      .map((f) => f.FunctionName)
      .filter(isProjectLambda),
  ),
};

const ok = report(judgeTeardown(snapshot));
console.log(ok ? '\nTeardown verified: nothing billable from this project is left.' : '\nSomething is left (see FAIL lines).');
process.exit(ok ? 0 : 1);
