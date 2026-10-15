// Stage 15: runs the commands behind `npm run up` / `npm run down`. Everything is started with this
// Node binary and the CLI's JavaScript entry point, never through a shell, so arguments such as
// `alertEmail=a@x.com,b@y.com` reach the CLI untouched on Windows (cmd.exe would split on commas).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { awsJson } from './aws-cli';
import { formatDuration, Phase, StackState } from './session-plan';

export const INFRA_DIR = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(INFRA_DIR, '..');
const CDK_CLI = path.join(INFRA_DIR, 'node_modules', 'aws-cdk', 'bin', 'cdk');
const TSX_CLI = path.join(INFRA_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runNode(args: string[], cwd = INFRA_DIR): boolean {
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd });
  if (r.error) console.error(r.error.message);
  return r.status === 0;
}

/** Prints and runs `cdk <args>`; output streams to the terminal. */
export function runCdk(args: string[]): boolean {
  console.log(`> npx cdk ${args.join(' ')}`);
  return runNode([CDK_CLI, ...args]);
}

/** Runs `cdk <args>` and captures stdout (for `cdk list --json`); stderr still streams. */
export function captureCdk(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync(process.execPath, [CDK_CLI, ...args], {
    cwd: INFRA_DIR,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, stdout: r.stdout ?? '' };
}

/** Runs one of this folder's scripts (scripts/<file>) with tsx, as `npm run <x>` would. */
export function runScript(file: string, args: string[] = []): boolean {
  console.log(`> tsx scripts/${file}${args.length ? ' ' + args.join(' ') : ''}`);
  return runNode([TSX_CLI, path.join(INFRA_DIR, 'scripts', file), ...args]);
}

/** `npm --prefix <dir> run <script>`, through the npm that launched us (npm_execpath). */
export function runNpm(prefixDir: string, script: string): boolean {
  const npmCli = process.env.npm_execpath;
  console.log(`> npm --prefix ${path.relative(INFRA_DIR, prefixDir) || '.'} run ${script}`);
  if (!npmCli || !fs.existsSync(npmCli)) {
    console.error('npm_execpath is not set: start this through `npm run up` / `npm run down`.');
    return false;
  }
  const args = ['--prefix', prefixDir, 'run', script];
  if (/\.(c|m)?js$/.test(npmCli)) return runNode([npmCli, ...args]);
  const r = spawnSync(npmCli, args, { stdio: 'inherit', cwd: INFRA_DIR });
  return r.status === 0;
}

/** Every CloudFormation stack in the region that is not DELETE_COMPLETE. */
export function liveStackStates(): { states?: StackState[]; error?: string } {
  const r = awsJson<{ StackSummaries: { StackName: string; StackStatus: string }[] }>(['cloudformation', 'list-stacks']);
  if (!r.value) return { error: r.error };
  return {
    states: r.value.StackSummaries.filter((s) => s.StackStatus !== 'DELETE_COMPLETE').map((s) => ({
      name: s.StackName,
      status: s.StackStatus,
    })),
  };
}

/** One output value of a deployed stack, or undefined. */
export function stackOutput(stack: string, key: string): string | undefined {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return r.value?.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === key)?.OutputValue;
}

/** Times named phases and prints how long each took. */
export class PhaseClock {
  readonly phases: Phase[] = [];

  run(name: string, fn: () => boolean): boolean {
    console.log(`\n=== ${name}`);
    const start = Date.now();
    const ok = fn();
    const ms = Date.now() - start;
    this.phases.push({ name, ms, ok });
    console.log(`=== ${name}: ${ok ? 'done' : 'FAILED'} in ${formatDuration(ms)}`);
    return ok;
  }
}
