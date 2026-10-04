// Stage 6b: point kubectl at the deployed cluster and apply the workloads.
// Creates Kubernetes resources (billable only via the cluster already running).
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { aws, kubectlArgs, pinEksContext, REGION } from './aws-cli';

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

// Collector first so the services' OTLP endpoint exists when they start.
kubectlRun(['apply', '-k', path.join(repoRoot, 'src', 'collector')]);
kubectlRun(['-n', 'observability', 'rollout', 'status', 'daemonset/otel-collector', '--timeout=300s']);
kubectlRun(['apply', '-k', path.join(repoRoot, 'k8s', 'online-boutique')]);
kubectlRun(['wait', '--for=condition=Available', 'deployment', '--all', '--timeout=600s']);
