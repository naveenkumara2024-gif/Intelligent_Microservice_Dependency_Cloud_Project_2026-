// Makes the Online Boutique storefront reachable from the internet (an internet-facing Classic ELB
// in the public subnets), or private again with --off. Uses a Classic ELB because this AWS account
// refuses Network Load Balancers (NLBs) with OperationNotPermitted.
//
//   npm run expose:storefront                        # open to everyone, plain HTTP
//   npm run expose:storefront -- --allow=203.0.113.7/32,198.51.100.0/24
//   npm run expose:storefront -- --off               # back to ClusterIP; the Classic ELB is deleted
//
// Always run `--off` (or scripts/pre-destroy.ts) before `cdk destroy`: a Kubernetes-created load
// balancer is not tracked by CloudFormation and its network interfaces block VPC deletion.
import * as path from 'node:path';
import { aws, kubectl, kubectlArgs, kubectlJson, pinEksContext } from './aws-cli';
import { isWorldOpen, parseArgs } from './storefront';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const SERVICE = 'frontend-external';
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const options = parseArgs(process.argv.slice(2));
if ('error' in options) {
  console.error(options.error);
  process.exit(2);
}

const cluster = pinEksContext();
if (!cluster.name) {
  console.error(`EksStack is not deployed: ${cluster.error}`);
  process.exit(1);
}
const update = aws(['eks', 'update-kubeconfig', '--name', cluster.name]);
if (!update.ok) {
  console.error(update.stderr);
  process.exit(1);
}

interface Svc {
  spec: { type: string; loadBalancerSourceRanges?: string[] };
  status?: { loadBalancer?: { ingress?: { hostname?: string; ip?: string }[] } };
}
const current = () => kubectlJson<Svc>(['get', 'service', SERVICE]);

// --- off ------------------------------------------------------------------------------------
if (options.off) {
  const before = current();
  if (!before.value) {
    console.error(`Cannot read service ${SERVICE}: ${before.error}`);
    process.exit(1);
  }
  if (before.value.spec.type !== 'LoadBalancer') {
    console.log(`${SERVICE} is already ${before.value.spec.type}: nothing to do.`);
    process.exit(0);
  }
  const patched = kubectl([
    'patch', 'service', SERVICE, '--type', 'merge', '-p',
    JSON.stringify({ spec: { type: 'ClusterIP', loadBalancerSourceRanges: null } }),
  ]);
  if (!patched.ok) {
    console.error(patched.stderr);
    process.exit(1);
  }
  console.log(`${SERVICE} is private again (ClusterIP). If a load balancer had been created, AWS is deleting it.`);
  process.exit(0);
}

// --- on -------------------------------------------------------------------------------------
if (options.allow.length === 0) {
  console.log('WARNING: no --allow given, so the storefront will be open to the whole internet over plain HTTP.');
} else if (options.allow.some(isWorldOpen)) {
  console.log('WARNING: --allow includes 0.0.0.0/0, which is the whole internet.');
}

const applied = spawnSync(
  'kubectl',
  kubectlArgs(['apply', '-k', path.join(repoRoot, 'k8s', 'online-boutique-public')]),
  { encoding: 'utf8' },
);
if (applied.status !== 0) {
  console.error(applied.stderr || applied.stdout);
  process.exit(1);
}
if (options.allow.length > 0) {
  const ranges = kubectl([
    'patch', 'service', SERVICE, '--type', 'merge', '-p',
    JSON.stringify({ spec: { loadBalancerSourceRanges: options.allow } }),
  ]);
  if (!ranges.ok) {
    console.error(ranges.stderr);
    process.exit(1);
  }
}

console.log('Waiting for AWS to provision the load balancer (usually 1-3 minutes)...');
let hostname: string | undefined;
for (let i = 0; i < 40 && !hostname; i++) {
  const svc = current();
  hostname = svc.value?.status?.loadBalancer?.ingress?.[0]?.hostname;
  if (!hostname) {
    const events = kubectl(['get', 'events', '--field-selector', `involvedObject.name=${SERVICE},type=Warning`, '-o', 'jsonpath={.items[-1:].message}']);
    if (events.ok && /error|unable|denied|not permitted|limit/i.test(events.stdout)) {
      console.error(`The load balancer could not be created: ${events.stdout.trim().slice(0, 400)}`);
      process.exit(1);
    }
    sleep(8000);
  }
}
if (!hostname) {
  console.error('No load balancer hostname after ~5 minutes. Check: kubectl describe service frontend-external');
  process.exit(1);
}
const url = `http://${hostname}/`;
console.log(`Load balancer: ${hostname}`);

// DNS and target health lag the hostname by a few minutes.
console.log('Waiting for it to serve traffic...');
let status = 0;
let served = false;
for (let i = 0; i < 40 && !served; i++) {
  const probe = spawnSync(process.execPath, [
    '-e',
    `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(8000)}).then(async r=>{const t=await r.text();console.log(r.status+' '+(/Online Boutique/i.test(t)?'storefront':'other'))}).catch(e=>console.log('ERR '+(e.cause&&e.cause.code||e.message)))`,
  ], { encoding: 'utf8' });
  const out = probe.stdout.trim();
  status = Number(out.split(' ')[0]) || 0;
  served = out === '200 storefront';
  if (!served) {
    process.stdout.write(`  not yet (${out || 'no answer'})\n`);
    sleep(10000);
  }
}
if (!served) {
  console.error(`The load balancer exists but ${url} is not serving yet (last status ${status}). It can take a few more minutes; retry the URL.`);
  process.exit(1);
}
console.log(`\nPublic storefront: ${url}`);
console.log(options.allow.length ? `Restricted to: ${options.allow.join(', ')}` : 'Open to everyone (plain HTTP, no authentication).');
console.log('Undo with: npm run expose:storefront -- --off   (and always before cdk destroy)');
