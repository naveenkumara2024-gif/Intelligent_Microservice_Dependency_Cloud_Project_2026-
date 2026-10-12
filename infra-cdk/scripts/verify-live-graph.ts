// Stage 9c checkpoint: with TransformerStack deployed using `-c graphBackend=neptune`, are real
// Online Boutique spans (collector -> MSK -> Lambda) becoming edges in Neptune? Read-only: it only
// invokes the probe's `edges` action, and reads Lambda configuration and logs.
//
//   npm run verify:live
//   npm run verify:live -- --wait=90        # seconds between the two samples (default 60)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { awsJson, Check, report } from './aws-cli';
import { growth, liveChecks, summarize, TopologyEdge } from './live-graph';
import { makeProbeInvoker } from './probe-client';

const ROOT = path.resolve(__dirname, '..', '..');
const waitArg = process.argv.find((a) => a.startsWith('--wait='));
const waitSeconds = waitArg ? Number(waitArg.split('=')[1]) : 60;
// `--window=N` narrows the error look-back (minutes), e.g. right after a redeploy.
const windowArg = process.argv.find((a) => a.startsWith('--window='));
const windowMinutes = windowArg ? Number(windowArg.split('=')[1]) || 15 : 15;

function outputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

const neptune = outputs('NeptuneStack');
const transformer = outputs('TransformerStack');
if (!neptune.ProbeFunctionName || !transformer.FunctionName || !transformer.LogGroupName) {
  console.log('FAIL  NeptuneStack and TransformerStack must both be deployed (deploy:neptune, deploy:transformer)');
  process.exit(1);
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

// 1. The transformer really writes to Neptune (not the log backend).
const cfg = awsJson<{ State?: string; Environment?: { Variables?: Record<string, string> } }>([
  'lambda', 'get-function-configuration', '--function-name', transformer.FunctionName,
]);
const env = cfg.value?.Environment?.Variables ?? {};
add({
  name: 'Transformer writes to Neptune with IAM auth',
  ok: env.GRAPH_BACKEND === 'gremlin' && env.NEPTUNE_IAM_AUTH === 'true' && !!env.GREMLIN_URL,
  detail: cfg.error ?? `GRAPH_BACKEND=${env.GRAPH_BACKEND}, NEPTUNE_IAM_AUTH=${env.NEPTUNE_IAM_AUTH}`,
});

const esm = awsJson<{ EventSourceMappings: { State: string; LastProcessingResult?: string }[] }>([
  'lambda', 'list-event-source-mappings', '--function-name', transformer.FunctionName,
]);
const mapping = esm.value?.EventSourceMappings?.[0];
add({
  name: 'MSK trigger enabled',
  ok: mapping?.State === 'Enabled',
  detail: esm.error ?? `${mapping?.State}, last result: ${mapping?.LastProcessingResult ?? 'n/a'}`,
});

// 2. Two samples of the graph, a minute apart.
const invoke = makeProbeInvoker(neptune.ProbeFunctionName);
const first = invoke({ action: 'edges', limit: 1000 });
if (!first.value?.edges) {
  add({ name: 'Read edges from Neptune', ok: false, detail: first.error ?? 'no edges in the response' });
  process.exit(report(checks) ? 0 : 1);
}
console.log(`first sample: ${first.value.edges.length} edges; waiting ${waitSeconds}s for the second...`);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitSeconds * 1000);
const second = invoke({ action: 'edges', limit: 1000 });
if (!second.value?.edges) {
  add({ name: 'Read edges from Neptune (second sample)', ok: false, detail: second.error ?? 'no edges' });
  process.exit(report(checks) ? 0 : 1);
}

const topology = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'ml-engine', 'fixtures', 'boutique_topology.json'), 'utf8'),
) as { edges: TopologyEdge[] };
const summary = summarize(second.value.edges, topology.edges);
for (const c of liveChecks(summary, growth(first.value.edges, second.value.edges), Date.now())) add(c);

// 3. No Lambda errors recently.
const since = String(Date.now() - windowMinutes * 60 * 1000);
const errors = awsJson<{ events: { message: string }[] }>([
  'logs', 'filter-log-events', '--log-group-name', transformer.LogGroupName, '--start-time', since,
  '--filter-pattern', '?ERROR ?"Task timed out" ?errorMessage',
]);
const errorCount = errors.value?.events.length ?? 0;
add({
  name: `No transformer errors in the last ${windowMinutes} minutes`,
  ok: !errors.error && errorCount === 0,
  detail: errors.error ?? (errorCount === 0 ? 'none' : errors.value!.events[0].message.trim().slice(0, 220)),
});

const ok = report(checks);
console.log('\nBusiest live edges (avg latency = latency_sum_ms / call_count):');
for (const e of second.value.edges.slice(0, 10)) {
  const avg = e.call_count > 0 ? (e.latency_sum_ms / e.call_count).toFixed(1) : 'n/a';
  console.log(`  ${e.um} -> ${e.dm}  calls=${e.call_count}  avg=${avg} ms`);
}
if (summary.missingFromEmitters.length > 0) {
  console.log(`\nConfigured edges from span-emitting services not observed yet: ${summary.missingFromEmitters.map((e) => `${e.um}->${e.dm}`).join(', ')}`);
}
process.exit(ok ? 0 : 1);
