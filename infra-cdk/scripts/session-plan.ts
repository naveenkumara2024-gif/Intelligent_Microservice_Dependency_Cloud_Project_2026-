// Stage 15: what `npm run up` / `npm run down` do, as pure functions (unit-tested in
// test/session-plan.test.ts). Running commands and calling AWS happens in up.ts, down.ts,
// verify-teardown.ts and session-run.ts; nothing here has side effects.
import { parseAlertEmails } from '../lib/alerting-stack';
import type { Check } from './aws-cli';

/** Every stack in bin/app.ts. CDK orders them by dependency; this order is only for display. */
export const APP_STACKS = [
  'VpcStack',
  'EksStack',
  'MskStack',
  'NeptuneStack',
  'SagemakerStack',
  'DynamodbStack',
  'TransformerStack',
  'ScorerStack',
  'AlertingStack',
  'ApiStack',
  'FrontendStack',
] as const;

/** Skipped by `up -- --no-dashboard`. */
export const DASHBOARD_STACKS: readonly string[] = ['ApiStack', 'FrontendStack'];

/**
 * The full feature set, passed by BOTH up and down. Cross-stack references are weak
 * (`Fn::GetStackOutput`, no export locks), so CloudFormation does not stop a stack from being
 * deleted while another still reads it: delete order comes only from CDK's dependency graph, and
 * these flags add edges to it (topology=neptune makes ApiStack depend on VpcStack/NeptuneStack).
 * More edges only add ordering, so passing them on destroy is safe whatever was deployed.
 */
export const SESSION_CONTEXT: Readonly<Record<string, string>> = { graphBackend: 'neptune', topology: 'neptune' };

/** Above the widest level of the dependency graph, so CDK's ordering is the only limit. */
export const CONCURRENCY = 10;

/**
 * Edges `down` insists on before destroying anything (dependent -> dependency). If bin/app.ts ever
 * loses one, CDK could delete, say, the VPC while the API's in-VPC Lambda still exists.
 */
export const REQUIRED_DEPENDENCIES: readonly (readonly [string, string])[] = [
  ['EksStack', 'VpcStack'],
  ['MskStack', 'VpcStack'],
  ['NeptuneStack', 'VpcStack'],
  ['TransformerStack', 'MskStack'],
  ['TransformerStack', 'NeptuneStack'],
  ['TransformerStack', 'VpcStack'],
  ['ScorerStack', 'NeptuneStack'],
  ['ScorerStack', 'VpcStack'],
  ['ScorerStack', 'DynamodbStack'],
  ['AlertingStack', 'DynamodbStack'],
  ['ApiStack', 'DynamodbStack'],
  ['ApiStack', 'NeptuneStack'],
  ['ApiStack', 'VpcStack'],
  ['FrontendStack', 'ApiStack'],
];

export function contextArgs(context: Readonly<Record<string, string>>): string[] {
  return Object.entries(context).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
}

// ---------------------------------------------------------------------------------------------
// up

export interface UpOptions {
  email?: string;
  noEmail: boolean;
  dashboard: boolean;
  dryRun: boolean;
}

export function parseUpArgs(argv: readonly string[]): UpOptions | { error: string } {
  const opts: UpOptions = { noEmail: false, dashboard: true, dryRun: false };
  for (const arg of argv) {
    if (arg.startsWith('--email=')) opts.email = arg.slice('--email='.length);
    else if (arg === '--no-email') opts.noEmail = true;
    else if (arg === '--no-dashboard') opts.dashboard = false;
    else if (arg === '--dry-run') opts.dryRun = true;
    else return { error: `Unknown option "${arg}". Usage: npm run up [-- --email=<addr>[,<addr>...] | --no-email] [--no-dashboard] [--dry-run]` };
  }
  if (opts.email !== undefined && opts.noEmail) return { error: '--email and --no-email contradict each other' };
  return opts;
}

export type EmailSource = '--email' | 'shell environment' | 'infra-cdk/.env' | '--no-email';

/**
 * Where the alert addresses come from: --email, else RCA_ALERT_EMAIL from the shell, else from
 * infra-cdk/.env; --no-email deploys without. With none of these `up` refuses, so a run can never
 * silently remove the email subscriptions (the Stage 12 gotcha).
 */
export function resolveAlertEmails(input: {
  flag?: string;
  noEmail: boolean;
  shell?: string;
  file?: string;
}): { emails: string[]; source: EmailSource } | { error: string } {
  if (input.noEmail) return { emails: [], source: '--no-email' };
  const candidates: [string | undefined, EmailSource][] = [
    [input.flag, '--email'],
    [input.shell, 'shell environment'],
    [input.file, 'infra-cdk/.env'],
  ];
  for (const [raw, source] of candidates) {
    if (raw === undefined || (source !== '--email' && raw.trim() === '')) continue;
    try {
      const emails = parseAlertEmails(raw);
      if (emails.length === 0) return { error: `${source} gives no email address` };
      return { emails, source };
    } catch (e) {
      return { error: `${source}: ${(e as Error).message}` };
    }
  }
  return {
    error:
      'No alert email. Set RCA_ALERT_EMAIL in infra-cdk/.env (template: .env.example), ' +
      'or pass --email=<addr>[,<addr>...], or pass --no-email to deploy without email alerts.',
  };
}

export function upStacks(dashboard: boolean): string[] {
  return APP_STACKS.filter((s) => dashboard || !DASHBOARD_STACKS.includes(s));
}

/** The flags `up` synthesizes with (the dry run uses the same, so it shows what would deploy). */
export function upContext(emails: readonly string[]): Record<string, string> {
  return { ...SESSION_CONTEXT, ...(emails.length > 0 ? { alertEmail: emails.join(',') } : {}) };
}

/** Arguments after `cdk` for the single parallel deploy. */
export function upDeployArgs(stacks: readonly string[], emails: readonly string[]): string[] {
  return [
    'deploy', ...stacks, '--concurrency', String(CONCURRENCY), '--require-approval', 'never', ...contextArgs(upContext(emails)),
  ];
}

export interface StackState {
  name: string;
  status: string;
}

const STABLE_FOR_DEPLOY = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE']);

/** Problems that stop `up` before it changes anything (one line each, with the fix). */
export function gateForUp(states: readonly StackState[]): string[] {
  const problems: string[] = [];
  for (const s of states) {
    if (!(APP_STACKS as readonly string[]).includes(s.name) || s.status === 'DELETE_COMPLETE') continue;
    if (s.status.endsWith('_IN_PROGRESS')) {
      problems.push(`${s.name} is ${s.status}: wait for it to finish, then run up again`);
    } else if (!STABLE_FOR_DEPLOY.has(s.status)) {
      problems.push(`${s.name} is ${s.status}: run \`npm run down\` (or \`npx cdk destroy ${s.name}\`) first`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// down

export interface DownOptions {
  yes: boolean;
  dryRun: boolean;
}

export function parseDownArgs(argv: readonly string[]): DownOptions | { error: string } {
  const opts: DownOptions = { yes: false, dryRun: false };
  for (const arg of argv) {
    if (arg === '--yes') opts.yes = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else return { error: `Unknown option "${arg}". Usage: npm run down [-- --yes] [--dry-run]` };
  }
  return opts;
}

/** Which of this app's stacks to destroy, and what blocks the teardown (an operation in flight). */
export function planDown(states: readonly StackState[]): { destroy: string[]; problems: string[] } {
  const present = states.filter(
    (s) => (APP_STACKS as readonly string[]).includes(s.name) && s.status !== 'DELETE_COMPLETE',
  );
  const problems = present
    .filter((s) => s.status.endsWith('_IN_PROGRESS'))
    .map((s) => `${s.name} is ${s.status}: wait for it to finish, then run down again`);
  // Keep APP_STACKS order so the printed list is stable.
  const names = new Set(present.map((s) => s.name));
  return { destroy: APP_STACKS.filter((s) => names.has(s)), problems };
}

/** Arguments after `cdk` for the single parallel destroy. Only ever this app's stacks. */
export function downDestroyArgs(stacks: readonly string[]): string[] {
  const foreign = stacks.filter((s) => !(APP_STACKS as readonly string[]).includes(s));
  if (foreign.length > 0) throw new Error(`refusing to destroy stacks outside this app: ${foreign.join(', ')}`);
  if (stacks.length === 0) throw new Error('no stacks to destroy');
  return ['destroy', ...stacks, '--force', '--concurrency', String(CONCURRENCY), ...contextArgs(SESSION_CONTEXT)];
}

/** Shape of `cdk list --show-dependencies --json`. */
export interface StackDependencies {
  id: string;
  dependencies: StackDependencies[];
}

/** Parses the CLI's stdout, which may carry a notice line before the JSON. */
export function parseCdkList(stdout: string): StackDependencies[] {
  const start = stdout.indexOf('[');
  if (start < 0) throw new Error('no JSON array in `cdk list` output');
  return JSON.parse(stdout.slice(start)) as StackDependencies[];
}

/** Every missing stack or dependency edge, as a message; empty means the guard passes. */
export function missingDependencies(list: readonly StackDependencies[]): string[] {
  const closure = new Map<string, Set<string>>();
  const collect = (deps: readonly StackDependencies[], into: Set<string>) => {
    for (const d of deps) {
      into.add(d.id);
      collect(d.dependencies, into);
    }
  };
  for (const s of list) {
    const all = new Set<string>();
    collect(s.dependencies, all);
    closure.set(s.id, all);
  }
  const problems: string[] = [];
  for (const s of APP_STACKS) {
    if (!closure.has(s)) problems.push(`${s} is missing from the CDK app`);
  }
  for (const [from, to] of REQUIRED_DEPENDENCIES) {
    if (closure.has(from) && !closure.get(from)!.has(to)) problems.push(`${from} does not depend on ${to}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// verify:teardown

/** One kind of leftover resource: the names found, or why the query failed. */
export interface Finding {
  items?: string[];
  error?: string;
}

export interface TeardownSnapshot {
  /** Every CloudFormation stack not in DELETE_COMPLETE. */
  stacks: Finding;
  eksClusters: Finding;
  mskClusters: Finding;
  neptuneClusters: Finding;
  sagemakerEndpoints: Finding;
  dynamodbTables: Finding;
  cloudfrontDistributions: Finding;
  projectVpcs: Finding;
  natGateways: Finding;
  elasticIps: Finding;
  loadBalancers: Finding;
  ec2Instances: Finding;
  lambdaFunctions: Finding;
}

const SNAPSHOT_LABELS: Record<keyof TeardownSnapshot, string> = {
  stacks: 'CloudFormation stacks (only CDKToolkit may remain)',
  eksClusters: 'EKS clusters',
  mskClusters: 'MSK clusters',
  neptuneClusters: 'Neptune clusters',
  sagemakerEndpoints: 'SageMaker endpoints',
  dynamodbTables: 'DynamoDB tables (rca-*)',
  cloudfrontDistributions: 'CloudFront distributions (RCA dashboard)',
  projectVpcs: 'Project VPC (VpcStack)',
  natGateways: 'NAT gateways',
  elasticIps: 'Elastic IPs',
  loadBalancers: 'Load balancers (ELBv2 + Classic)',
  ec2Instances: 'EC2 instances (not terminated)',
  lambdaFunctions: 'Lambda functions of this app',
};

export const KEPT_STACKS: readonly string[] = ['CDKToolkit'];

export function isProjectTable(name: string): boolean {
  return name.startsWith('rca-');
}

export function isProjectLambda(name: string): boolean {
  return name.startsWith('rca-') || APP_STACKS.some((s) => name.startsWith(`${s}-`));
}

export function judgeTeardown(snapshot: TeardownSnapshot): Check[] {
  return (Object.keys(SNAPSHOT_LABELS) as (keyof TeardownSnapshot)[]).map((key) => {
    const finding = snapshot[key];
    const items = key === 'stacks' ? finding.items?.filter((s) => !KEPT_STACKS.includes(s.split(' ')[0])) : finding.items;
    if (finding.error !== undefined || items === undefined) {
      return { name: SNAPSHOT_LABELS[key], ok: false, detail: `could not check: ${finding.error ?? 'no result'}` };
    }
    return { name: SNAPSHOT_LABELS[key], ok: items.length === 0, detail: items.length === 0 ? 'none' : items.join(', ') };
  });
}

// ---------------------------------------------------------------------------------------------
// timing

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

export interface Phase {
  name: string;
  ms: number;
  ok: boolean;
}

export function phaseSummary(phases: readonly Phase[]): string[] {
  const width = Math.max(...phases.map((p) => p.name.length), 5);
  const lines = phases.map((p) => `  ${p.name.padEnd(width)}  ${formatDuration(p.ms).padStart(8)}${p.ok ? '' : '  (FAILED)'}`);
  const total = phases.reduce((sum, p) => sum + p.ms, 0);
  lines.push(`  ${'total'.padEnd(width)}  ${formatDuration(total).padStart(8)}`);
  return lines;
}
