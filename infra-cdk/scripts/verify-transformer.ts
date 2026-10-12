// Stage 8b checkpoint: confirms the Lambda exists, the MSK trigger is enabled, and that it has
// processed real spans into edges (read from CloudWatch Logs, since GRAPH_BACKEND=log until
// Stage 9). Read-only. Exits non-zero on any failure.
import { awsJson, Check, report } from './aws-cli';

const WINDOW_MINUTES = 15;

function stackOutputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

const out = stackOutputs('TransformerStack');
const functionName = out.FunctionName;
const logGroup = out.LogGroupName;
if (!functionName || !logGroup) {
  console.log('FAIL  TransformerStack: not deployed (no FunctionName output) -- run npm run deploy:transformer first');
  process.exit(1);
}

const checks: Check[] = [];

const fn = awsJson<{ State?: string; Runtime?: string }>(['lambda', 'get-function-configuration', '--function-name', functionName]);
checks.push({
  name: 'Lambda function',
  ok: fn.value?.State === 'Active',
  detail: fn.error ?? `${functionName} (${fn.value?.Runtime}) state ${fn.value?.State}`,
});

const esm = awsJson<{ EventSourceMappings: { State: string; Topics?: string[]; LastProcessingResult?: string }[] }>([
  'lambda', 'list-event-source-mappings', '--function-name', functionName,
]);
const mapping = esm.value?.EventSourceMappings?.[0];
checks.push({
  name: 'MSK event source mapping',
  ok: mapping?.State === 'Enabled' && mapping.Topics?.includes('otel.traces') === true,
  detail: esm.error ?? `${mapping?.State}, topics ${mapping?.Topics?.join(',')}, last result: ${mapping?.LastProcessingResult ?? 'n/a'}`,
});

const since = String(Date.now() - WINDOW_MINUTES * 60 * 1000);
function events(pattern: string): string[] {
  const r = awsJson<{ events: { message: string }[] }>([
    'logs', 'filter-log-events', '--log-group-name', logGroup, '--start-time', since, '--filter-pattern', pattern,
  ]);
  return (r.value?.events ?? []).map((e) => e.message.trim());
}

const summaries = events('"transformer"')
  .map((m) => {
    try {
      return (JSON.parse(m) as { transformer?: Record<string, number> }).transformer;
    } catch {
      return undefined;
    }
  })
  .filter((s): s is Record<string, number> => !!s);
const total = (key: string) => summaries.reduce((n, s) => n + (s[key] ?? 0), 0);
checks.push({
  name: `Invocations with spans (last ${WINDOW_MINUTES} min)`,
  ok: total('records') > 0 && total('calls') > 0,
  detail: `${summaries.length} invocations: ${total('records')} records, ${total('spans')} spans, ${total('calls')} calls, ${total('skippedSpans')} skipped spans`,
});

const edgeNames = new Set(
  events('"edge"').flatMap((m) => {
    try {
      const e = (JSON.parse(m) as { edge?: string }).edge;
      return e ? [e] : [];
    } catch {
      return [];
    }
  }),
);
checks.push({
  name: 'Edges derived from live spans',
  ok: edgeNames.size >= 3,
  detail: edgeNames.size ? [...edgeNames].sort().slice(0, 8).join(' | ') : '(none)',
});

const errors = events('?ERROR ?"Task timed out" ?errorMessage');
checks.push({
  name: 'Errors',
  ok: errors.length === 0,
  detail: errors.length === 0 ? 'none in the window' : errors[0].slice(0, 200),
});

process.exit(report(checks) ? 0 : 1);
