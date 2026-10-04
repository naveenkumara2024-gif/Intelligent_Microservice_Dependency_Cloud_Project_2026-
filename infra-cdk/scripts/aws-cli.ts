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
