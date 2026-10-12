// Stage 10b checkpoint. Run after `npm run deploy:sagemaker`, and again with --after-destroy after
// `npm run destroy:sagemaker`. Uses only the AWS CLI and the local Python reference scorer
// (src/ml-engine/score_local.py). Invokes the endpoint (a few requests, cents). Exits non-zero on
// any failure.
//
//   npm run verify:sagemaker
//   npm run verify:sagemaker -- --after-destroy
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { aws, awsJson, Check, report } from './aws-cli';

const ROOT = path.resolve(__dirname, '..', '..');
const ML = path.join(ROOT, 'src', 'ml-engine');
const afterDestroy = process.argv.includes('--after-destroy');
const PARITY_TOLERANCE = 1e-4;

interface Node { name: string; total_calls_as_um: number; total_calls_as_dm: number; own_delta?: number }
interface Edge { um: string; dm: string }
interface Topology { nodes: Node[]; edges: Edge[] }
interface Scores {
  model_version: string;
  num_nodes: number;
  ranking: { rank: number; name: string; score: number }[];
  scores: Record<string, number>;
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

function stackOutputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

// --- teardown mode ----------------------------------------------------------------------------
if (afterDestroy) {
  const endpoints = awsJson<{ Endpoints: { EndpointName: string }[] }>(['sagemaker', 'list-endpoints']);
  const configs = awsJson<{ EndpointConfigs: { EndpointConfigName: string }[] }>(['sagemaker', 'list-endpoint-configs']);
  const models = awsJson<{ Models: { ModelName: string }[] }>(['sagemaker', 'list-models']);
  add({
    name: 'No endpoints left',
    ok: !!endpoints.value && endpoints.value.Endpoints.length === 0,
    detail: endpoints.error ?? `${endpoints.value?.Endpoints.map((e) => e.EndpointName).join(', ') || 'none'}`,
  });
  add({
    name: 'No endpoint configs left',
    ok: !!configs.value && configs.value.EndpointConfigs.length === 0,
    detail: configs.error ?? `${configs.value?.EndpointConfigs.length} found`,
  });
  add({
    name: 'No models left',
    ok: !!models.value && models.value.Models.length === 0,
    detail: models.error ?? `${models.value?.Models.length} found`,
  });
  process.exit(report(checks) ? 0 : 1);
}

// --- deployed mode ----------------------------------------------------------------------------
const out = stackOutputs('SagemakerStack');
const endpointName = out.EndpointName;
if (!endpointName) {
  console.log('FAIL  SagemakerStack: not deployed (no EndpointName output) -- run npm run deploy:sagemaker first');
  process.exit(1);
}

const described = awsJson<{
  EndpointStatus: string;
  FailureReason?: string;
  EndpointConfigName: string;
  ProductionVariants?: { CurrentServerlessConfig?: { MemorySizeInMB: number; MaxConcurrency: number } }[];
}>(['sagemaker', 'describe-endpoint', '--endpoint-name', endpointName]);
const ep = described.value;
add({
  name: 'Endpoint InService',
  ok: ep?.EndpointStatus === 'InService',
  detail: described.error ?? `${endpointName} is ${ep?.EndpointStatus}${ep?.FailureReason ? `: ${ep.FailureReason}` : ''}`,
});

const config = ep
  ? awsJson<{ ProductionVariants: { InstanceType?: string; InitialInstanceCount?: number; ServerlessConfig?: { MemorySizeInMB: number; MaxConcurrency: number } }[] }>([
      'sagemaker', 'describe-endpoint-config', '--endpoint-config-name', ep.EndpointConfigName,
    ])
  : undefined;
const variant = config?.value?.ProductionVariants?.[0];
add({
  name: 'Serverless config, no instance type',
  ok: !!variant?.ServerlessConfig && variant.InstanceType === undefined,
  detail: variant
    ? `serverless ${variant.ServerlessConfig?.MemorySizeInMB} MB x ${variant.ServerlessConfig?.MaxConcurrency}, instanceType=${variant.InstanceType ?? 'none'}`
    : (config?.error ?? 'no variant'),
});

function invoke(body: string): { ok: boolean; ms: number; json?: Scores; error?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-invoke-'));
  const input = path.join(dir, 'in.json');
  const output = path.join(dir, 'out.json');
  fs.writeFileSync(input, body);
  const t0 = Date.now();
  const r = aws([
    'sagemaker-runtime', 'invoke-endpoint', '--endpoint-name', endpointName, '--content-type', 'application/json',
    '--accept', 'application/json', '--cli-read-timeout', '120', '--body', `fileb://${input.replace(/\\/g, '/')}`, output,
  ]);
  const ms = Date.now() - t0;
  try {
    if (!r.ok) return { ok: false, ms, error: r.stderr };
    return { ok: true, ms, json: JSON.parse(fs.readFileSync(output, 'utf8')) as Scores };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A fault at paymentservice: its callers are slow too, in proportion to how much they depend on it.
const topology = JSON.parse(fs.readFileSync(path.join(ML, 'fixtures', 'boutique_topology.json'), 'utf8')) as Topology;
const FAULT: Record<string, number> = { paymentservice: 6.0, checkoutservice: 3.0, frontend: 1.0 };
const snapshot = JSON.stringify({
  nodes: topology.nodes.map((n) => ({ ...n, own_delta: FAULT[n.name] ?? 0.05 })),
  edges: topology.edges,
  top_k: 5,
});

const cold = invoke(snapshot);
const warm = invoke(snapshot);
add({
  name: 'Invocation succeeds (cold, then warm)',
  ok: cold.ok && warm.ok,
  detail: cold.ok && warm.ok ? `cold ${cold.ms} ms, warm ${warm.ms} ms (includes AWS CLI start-up)` : (cold.error ?? warm.error ?? 'failed'),
});

const response = warm.json ?? cold.json;
if (response) {
  const top3 = response.ranking.slice(0, 3).map((r) => r.name);
  add({
    name: 'Injected fault is in the top 3',
    ok: top3.includes('paymentservice'),
    detail: `top 3: ${top3.map((n, i) => `${n} (${response.ranking[i].score.toFixed(3)})`).join(', ')}; model ${response.model_version}`,
  });

  // The same snapshot through the same code, locally.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-ref-'));
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, snapshot);
  const ref = spawnSync('python', [path.join(ML, 'score_local.py'), '--in', file], { encoding: 'utf8', cwd: ML });
  fs.rmSync(dir, { recursive: true, force: true });
  if (ref.status !== 0) {
    add({ name: 'Parity with local reference', ok: false, detail: `local scorer failed: ${(ref.stderr || ref.error?.message || '').slice(0, 200)}` });
  } else {
    const local = JSON.parse(ref.stdout) as Scores;
    let worst = 0;
    let missing = 0;
    for (const [name, score] of Object.entries(local.scores)) {
      const got = response.scores[name];
      if (got === undefined) missing++;
      else worst = Math.max(worst, Math.abs(got - score));
    }
    add({
      name: 'Parity with local reference',
      ok: missing === 0 && worst <= PARITY_TOLERANCE,
      detail: `${Object.keys(local.scores).length} scores, max |endpoint - local| = ${worst.toExponential(2)} (tolerance ${PARITY_TOLERANCE}), ${missing} missing`,
    });
  }
}

// A request the model cannot score must be a client error (400), not a server error.
const bad = invoke(JSON.stringify({ nodes: [], edges: [] }));
add({
  name: 'Malformed request is a 4xx',
  ok: !bad.ok && /client error \(4\d\d\)/i.test(bad.error ?? ''),
  detail: bad.ok ? 'request unexpectedly succeeded' : (bad.error ?? '').replace(/\s+/g, ' ').slice(0, 220),
});

process.exit(report(checks) ? 0 : 1);
