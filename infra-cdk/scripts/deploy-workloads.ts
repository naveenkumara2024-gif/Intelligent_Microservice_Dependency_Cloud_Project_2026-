// Stage 6b: point kubectl at the deployed cluster and apply the workloads.
// Creates Kubernetes resources (billable only via the cluster already running).
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { aws, ensureClusterAdmin, kubectl, kubectlArgs, pinEksContext, REGION } from './aws-cli';

const repoRoot = path.resolve(__dirname, '..', '..');

function kubectlRun(args: string[]): void {
  const full = kubectlArgs(args);
  console.log(`> kubectl ${full.join(' ')}`);
  const r = spawnSync('kubectl', full, { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`kubectl failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

const cluster = pinEksContext();
if (!cluster.name) {
  console.error(cluster.error);
  process.exit(1);
}

const kubeconfig = aws(['eks', 'update-kubeconfig', '--name', cluster.name]);
if (!kubeconfig.ok) {
  console.error(kubeconfig.stderr);
  process.exit(1);
}
console.log(`kubeconfig updated for ${cluster.name} (${REGION})`);

const admin = ensureClusterAdmin(cluster.name);
if (!admin.principal) {
  console.error(`Could not grant cluster-admin: ${admin.error}`);
  process.exit(1);
}
console.log(`cluster-admin access entry present for ${admin.principal}`);

// Access entries take a few seconds to propagate.
let allowed = false;
for (let attempt = 0; attempt < 12 && !allowed; attempt++) {
  allowed = kubectl(['auth', 'can-i', '*', '*']).stdout.trim() === 'yes';
  if (!allowed) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
}
if (!allowed) {
  console.error('kubectl is still not authorized after 60s; check the access entry in the EKS console.');
  process.exit(1);
}

// Collector first so the services' OTLP endpoint exists when they start.
kubectlRun(['apply', '-k', path.join(repoRoot, 'src', 'collector')]);
kubectlRun(['-n', 'observability', 'rollout', 'status', 'daemonset/otel-collector', '--timeout=300s']);
kubectlRun(['apply', '-k', path.join(repoRoot, 'k8s', 'online-boutique')]);
kubectlRun(['wait', '--for=condition=Available', 'deployment', '--all', '--timeout=600s']);
