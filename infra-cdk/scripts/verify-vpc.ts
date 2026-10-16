// Stage 5b checkpoint: confirms the deployed VpcStack matches the design.
// Read-only. Exits non-zero if any check fails.
import { awsJson, Check, report } from './aws-cli';

interface Tag { Key: string; Value: string }
interface Subnet { SubnetId: string; AvailabilityZone: string; Tags?: Tag[] }
interface RouteTable {
  Routes: { DestinationCidrBlock?: string }[];
  Associations: { SubnetId?: string }[];
}
interface Endpoint { ServiceName: string; VpcEndpointType: string; State: string }

const tier = (s: Subnet) => s.Tags?.find((t) => t.Key === 'aws-cdk:subnet-name')?.Value;

const stack = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
  'cloudformation', 'describe-stacks', '--stack-name', 'VpcStack',
]);
const vpcId = stack.value?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'VpcId')?.OutputValue;
if (!vpcId) {
  console.log(`FAIL  VpcStack deployed: ${stack.error ?? 'no VpcId output'} -- deploy it first`);
  process.exit(1);
}

const filter = ['--filters', `Name=vpc-id,Values=${vpcId}`];
const checks: Check[] = [];

const vpc = awsJson<{ Vpcs: { CidrBlock: string }[] }>(['ec2', 'describe-vpcs', '--vpc-ids', vpcId]);
checks.push({
  name: 'VPC CIDR',
  ok: vpc.value?.Vpcs[0]?.CidrBlock === '10.0.0.0/16',
  detail: `${vpcId} ${vpc.value?.Vpcs[0]?.CidrBlock ?? vpc.error}`,
});

const subnets = awsJson<{ Subnets: Subnet[] }>(['ec2', 'describe-subnets', ...filter]).value?.Subnets ?? [];
const azs = new Set(subnets.map((s) => s.AvailabilityZone));
const perTier = (name: string) => subnets.filter((s) => tier(s) === name).length;
checks.push({
  name: 'Subnets',
  ok: subnets.length === 6 && azs.size === 2 &&
    ['public', 'private-app', 'private-data'].every((t) => perTier(t) === 2),
  detail: `${subnets.length} subnets in ${[...azs].join(', ')}; ` +
    `public=${perTier('public')} private-app=${perTier('private-app')} private-data=${perTier('private-data')}`,
});

// The key architectural property: the data tier has no internet route.
const dataSubnetIds = new Set(subnets.filter((s) => tier(s) === 'private-data').map((s) => s.SubnetId));
const tables = awsJson<{ RouteTables: RouteTable[] }>(['ec2', 'describe-route-tables', ...filter]).value?.RouteTables ?? [];
const dataTables = tables.filter((t) => t.Associations.some((a) => a.SubnetId && dataSubnetIds.has(a.SubnetId)));
const leaking = dataTables.filter((t) => t.Routes.some((r) => r.DestinationCidrBlock === '0.0.0.0/0'));
checks.push({
  name: 'private-data has no 0.0.0.0/0 route',
  ok: dataTables.length === 2 && leaking.length === 0,
  detail: `${dataTables.length} data route tables, ${leaking.length} with a default route`,
});

const endpoints = awsJson<{ VpcEndpoints: Endpoint[] }>(['ec2', 'describe-vpc-endpoints', ...filter]).value?.VpcEndpoints ?? [];
const expectedEndpoints = ['dynamodb', 's3', 'sagemaker.runtime', 'sns'];
const missing = expectedEndpoints.filter(
  (svc) => !endpoints.some((e) => e.ServiceName.endsWith(`.${svc}`) && e.State === 'available'),
);
checks.push({
  name: 'VPC endpoints available',
  ok: missing.length === 0,
  detail: missing.length === 0 ? expectedEndpoints.join(', ') : `missing or not available: ${missing.join(', ')}`,
});

process.exit(report(checks) ? 0 : 1);
