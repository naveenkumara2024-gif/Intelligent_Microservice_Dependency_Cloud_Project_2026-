import { spawnSync } from 'node:child_process';

// Shared by the Stage 5b scripts. Uses the AWS CLI rather than the AWS SDK so
// no extra dependency is needed; credentials come from the CLI's normal chain.
export const REGION = 'us-east-1';

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function aws(args: string[]): CliResult {
  const r = spawnSync('aws', [...args, '--region', REGION, '--output', 'json'], {
    encoding: 'utf8',
  });
  if (r.error) {
    return { ok: false, stdout: '', stderr: r.error.message };
  }
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

export function awsJson<T>(args: string[]): { value?: T; error?: string } {
  const r = aws(args);
  if (!r.ok) {
    return { error: r.stderr || 'aws CLI call failed' };
  }
  return { value: JSON.parse(r.stdout) as T };
}

// Every kubectl call is pinned to the EKS cluster's context so a script can never
// act on whichever cluster happens to be current in ~/.kube/config (e.g. a local one).
let kubeContext: string | undefined;

export function setKubeContext(context: string): void {
  kubeContext = context;
}

export function kubectlArgs(args: string[]): string[] {
  if (!kubeContext) {
    throw new Error('kube context not set; call setKubeContext() first');
  }
  return ['--context', kubeContext, ...args];
}

/** Resolves the cluster and pins kubectl to its context (the form `aws eks update-kubeconfig` writes). */
export function pinEksContext(): { name?: string; error?: string } {
  const cluster = eksClusterName();
  if (!cluster.name) {
    return cluster;
  }
  const identity = awsJson<{ Account: string }>(['sts', 'get-caller-identity']);
  if (!identity.value) {
    return { error: identity.error };
  }
  setKubeContext(`arn:aws:eks:${REGION}:${identity.value.Account}:cluster/${cluster.name}`);
  return cluster;
}

export function kubectl(args: string[]): CliResult {
  const r = spawnSync('kubectl', kubectlArgs(args), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    return { ok: false, stdout: '', stderr: r.error.message };
  }
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim() };
}

export function kubectlJson<T>(args: string[]): { value?: T; error?: string } {
  const r = kubectl([...args, '-o', 'json']);
  if (!r.ok) {
    return { error: r.stderr || 'kubectl call failed' };
  }
  return { value: JSON.parse(r.stdout) as T };
}

/** Name of the EKS cluster, read from the deployed EksStack's ClusterName output. */
export function eksClusterName(): { name?: string; error?: string } {
  const stack = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', 'EksStack',
  ]);
  const name = stack.value?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === 'ClusterName')?.OutputValue;
  return name ? { name } : { error: stack.error ?? 'EksStack has no ClusterName output -- deploy it first' };
}

const CLUSTER_ADMIN_POLICY = 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy';

/**
 * Gives the caller cluster-admin via an EKS access entry (idempotent). Needed because the
 * cluster's built-in creator admin is CloudFormation's execution role under CDK bootstrap,
 * not the IAM identity running these scripts.
 */
export function ensureClusterAdmin(clusterName: string): { principal?: string; error?: string } {
  const identity = awsJson<{ Arn: string; Account: string }>(['sts', 'get-caller-identity']);
  if (!identity.value) {
    return { error: identity.error };
  }
  // assumed-role session ARNs are not valid principals; use the underlying role ARN.
  const principal = identity.value.Arn.replace(
    /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\/.*$/,
    'arn:aws:iam::$1:role/$2',
  );

  const entries = awsJson<{ accessEntries: string[] }>(['eks', 'list-access-entries', '--cluster-name', clusterName]);
  if (!entries.value) {
    return { error: entries.error };
  }
  if (!entries.value.accessEntries.includes(principal)) {
    const created = aws(['eks', 'create-access-entry', '--cluster-name', clusterName, '--principal-arn', principal]);
    if (!created.ok) {
      return { error: created.stderr };
    }
  }
  const associated = aws([
    'eks', 'associate-access-policy', '--cluster-name', clusterName, '--principal-arn', principal,
    '--policy-arn', CLUSTER_ADMIN_POLICY, '--access-scope', 'type=cluster',
  ]);
  return associated.ok ? { principal } : { error: associated.stderr };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function report(checks: Check[]): boolean {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  }
  return checks.every((c) => c.ok);
}
