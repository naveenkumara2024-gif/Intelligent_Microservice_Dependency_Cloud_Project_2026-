// Run before `cdk destroy EksStack` (wired into `npm run destroy:eks`).
// Load balancers created by Kubernetes Services are not tracked by CloudFormation; if one
// is left behind, its network interfaces block VpcStack deletion and it keeps billing.
// Deletes every LoadBalancer-type Service, then waits until the VPC has no load balancers.
import { aws, awsJson, kubectl, kubectlJson, pinEksContext } from './aws-cli';

interface Service {
  metadata: { name: string; namespace: string };
  spec: { type: string };
}

const cluster = pinEksContext();
if (!cluster.name) {
  console.log(`No deployed EksStack, nothing to clean up (${cluster.error}).`);
  process.exit(0);
}

const services = kubectlJson<{ items: Service[] }>(['get', 'services', '-A']);
if (!services.value) {
  console.error(`Cannot list services, so cannot confirm no load balancers exist: ${services.error}`);
  process.exit(1);
}

for (const svc of services.value.items.filter((s) => s.spec.type === 'LoadBalancer')) {
  console.log(`Deleting LoadBalancer service ${svc.metadata.namespace}/${svc.metadata.name}`);
  const r = kubectl(['delete', 'service', svc.metadata.name, '-n', svc.metadata.namespace, '--wait=true']);
  if (!r.ok) {
    console.error(r.stderr);
    process.exit(1);
  }
}

const vpc = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
  'cloudformation', 'describe-stacks', '--stack-name', 'VpcStack',
]);
const vpcId = vpc.value?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'VpcId')?.OutputValue;
if (!vpcId) {
  console.error(`Cannot find VpcId to confirm load balancers are gone: ${vpc.error}`);
  process.exit(1);
}

// AWS deletes the load balancer asynchronously after the Service is gone.
for (let attempt = 0; attempt < 30; attempt++) {
  const lbs = aws(['elbv2', 'describe-load-balancers', '--query', `LoadBalancers[?VpcId=='${vpcId}'].LoadBalancerArn`]);
  const remaining = lbs.ok ? (JSON.parse(lbs.stdout) as string[]) : null;
  if (remaining && remaining.length === 0) {
    console.log('No load balancers left in the VPC. Safe to destroy.');
    process.exit(0);
  }
  console.log(`Waiting for load balancer deletion (${remaining ? remaining.length : '?'} left)...`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
}
console.error('Load balancers still present after 5 minutes; do not destroy yet.');
process.exit(1);
