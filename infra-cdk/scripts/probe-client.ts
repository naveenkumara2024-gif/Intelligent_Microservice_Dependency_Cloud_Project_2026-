// Invokes the in-VPC Neptune probe Lambda (src/lambda-transformer/src/probe.ts) through the AWS CLI.
// Neptune has no public endpoint, so every data-plane check goes through this function.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { aws } from './aws-cli';

export interface ProbeCheck {
  name: string;
  ok: boolean;
  detail: string;
  informational?: boolean;
}

export interface LiveEdge {
  um: string;
  dm: string;
  call_count: number;
  latency_sum_ms: number;
  last_seen_ms: number;
}

export interface ProbeResult {
  action: string;
  ok: boolean;
  checks?: ProbeCheck[];
  stats?: {
    nodes: number;
    edges: number;
    callCountSum: number;
    totalCallsAsUmSum: number;
    totalCallsAsDmSum: number;
    degrees: Record<string, [number, number]>;
    top10: { um: string; dm: string; call_count: number }[];
  };
  edges?: LiveEdge[];
  detail?: unknown;
}

export function makeProbeInvoker(functionName: string): (payload: unknown) => { value?: ProbeResult; error?: string } {
  return (payload) => {
    const file = path.join(os.tmpdir(), `neptune-probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(`${file}.in.json`, JSON.stringify(payload));
    try {
      const r = aws([
        'lambda', 'invoke', '--function-name', functionName, '--cli-binary-format', 'raw-in-base64-out',
        '--cli-read-timeout', '330', '--payload', `fileb://${`${file}.in.json`.replace(/\\/g, '/')}`,
        `${file}.out.json`,
      ]);
      if (!r.ok) return { error: r.stderr };
      const meta = JSON.parse(r.stdout) as { FunctionError?: string };
      const body = fs.readFileSync(`${file}.out.json`, 'utf8');
      if (meta.FunctionError) {
        const e = JSON.parse(body) as { errorMessage?: string };
        return { error: `Lambda ${meta.FunctionError}: ${e.errorMessage ?? body.slice(0, 300)}` };
      }
      return { value: JSON.parse(body) as ProbeResult };
    } finally {
      for (const f of [`${file}.in.json`, `${file}.out.json`]) fs.rmSync(f, { force: true });
    }
  };
}
