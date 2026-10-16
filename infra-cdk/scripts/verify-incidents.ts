// Stage 11b-ii checkpoint: the whole loop, live. Needs VpcStack, EksStack (+ workloads), MskStack,
// NeptuneStack, TransformerStack (-c graphBackend=neptune), SagemakerStack, DynamodbStack and
// ScorerStack deployed, with Online Boutique running. It:
//
//   1. checks the scorer is wired (config, schedule, endpoint InService),
//   2. waits for baselines to warm up on real traffic, then soaks: a healthy system must produce
//      ZERO incidents (the false-positive risk this stage cares about most),
//   3. injects a synthetic slow-down at one service (probe `degrade`: extra calls through the
//      production counters), and waits for one incident to open, then validates the persisted item,
//   4. stops, and waits for the incident to resolve, with no duplicates,
//   5. reads CloudWatch for errors and the scorer's latency.
//
// It proves the pipeline (graph -> windows -> baseline -> endpoint -> lifecycle -> DynamoDB). It
// does NOT show the model finds real faults: the slow-down is synthetic (real faults: Stage 14).
//
//   npm run verify:incidents
//   npm run verify:incidents -- --soak=10 --warm=20 --inject=10
import { awsJson, Check, report } from './aws-cli';
import { getIncident, queryIncidents, readScorerState, sleepMs } from './ddb-cli';
import {
  CycleLog,
  parseScorerLog,
  pickTarget,
  planDegrade,
  ratesPerService,
  validateIncident,
} from './incidents-live';
import { makeProbeInvoker } from './probe-client';
import { GSI_BY_SERVICE, GSI_BY_STATUS } from '../../src/lambda-transformer/src/scorer/schema';

const arg = (name: string, fallback: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) || fallback : fallback;
};
const SOAK_MINUTES = arg('soak', 8);
const WARM_MINUTES = arg('warm', 15);
const INJECT_MINUTES = arg('inject', 8);
const RECOVER_MINUTES = arg('recover', 8);

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);
const finish = (): never => process.exit(report(checks) ? 0 : 1);
const log = (m: string) => console.log(`  .. ${m}`);

function outputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

// --- 1. wiring -------------------------------------------------------------------------------
const scorer = outputs('ScorerStack');
const neptune = outputs('NeptuneStack');
if (!scorer.FunctionName || !scorer.LogGroupName || !neptune.ProbeFunctionName) {
  console.log('FAIL  ScorerStack and NeptuneStack must both be deployed (deploy:neptune, deploy:scorer)');
  process.exit(1);
}

const cfg = awsJson<{ FunctionArn: string; Environment?: { Variables?: Record<string, string> } }>([
  'lambda', 'get-function-configuration', '--function-name', scorer.FunctionName,
]);
const env = cfg.value?.Environment?.Variables ?? {};
add({
  name: 'Scorer is configured for Neptune (IAM), the endpoint and both tables',
  ok: env.NEPTUNE_IAM_AUTH === 'true' && !!env.GREMLIN_URL && !!env.ENDPOINT_NAME && !!env.INCIDENTS_TABLE && !!env.STATE_TABLE,
  detail: cfg.error ?? `endpoint=${env.ENDPOINT_NAME}, incidents=${env.INCIDENTS_TABLE}, state=${env.STATE_TABLE}`,
});

const ruleNames = awsJson<{ RuleNames: string[] }>(['events', 'list-rule-names-by-target', '--target-arn', cfg.value?.FunctionArn ?? 'none']);
const rule = ruleNames.value?.RuleNames?.[0]
  ? awsJson<{ State: string; ScheduleExpression: string }>(['events', 'describe-rule', '--name', ruleNames.value.RuleNames[0]])
  : undefined;
add({
  name: 'Schedule is enabled',
  ok: rule?.value?.State === 'ENABLED',
  detail: ruleNames.error ?? rule?.error ?? `${rule?.value?.ScheduleExpression} ${rule?.value?.State}`,
});

const endpoint = awsJson<{ EndpointStatus: string }>(['sagemaker', 'describe-endpoint', '--endpoint-name', env.ENDPOINT_NAME ?? 'rca-root-cause']);
add({
  name: 'SageMaker endpoint is InService',
  ok: endpoint.value?.EndpointStatus === 'InService',
  detail: endpoint.error ?? String(endpoint.value?.EndpointStatus),
});
if (!checks.every((c) => c.ok)) finish();

const probe = makeProbeInvoker(neptune.ProbeFunctionName);
const nowSeconds = () => Math.floor(Date.now() / 1000);
const openIncidents = () => queryIncidents(GSI_BY_STATUS, 'OPEN', nowSeconds());

const stale = openIncidents();
add({
  name: 'No open incident before the test (tables are per session)',
  ok: !stale.error && stale.items.length === 0,
  detail: stale.error ?? (stale.items.map((i) => i.incident_id).join(', ') || 'none'),
});
if (!checks.every((c) => c.ok)) finish();

// --- 2. warm-up and healthy soak ---------------------------------------------------------------
console.log(`\nWaiting up to ${WARM_MINUTES} min for a service with a warm baseline and real traffic...`);
const warmDeadline = Date.now() + WARM_MINUTES * 60_000;
let target: ReturnType<typeof pickTarget>;
let rates: ReturnType<typeof ratesPerService> = [];
while (Date.now() < warmDeadline) {
  const a = probe({ action: 'edges', limit: 2000 });
  sleepMs(60_000);
  const b = probe({ action: 'edges', limit: 2000 });
  if (!a.value?.edges || !b.value?.edges) {
    add({ name: 'Read live edges from Neptune', ok: false, detail: a.error ?? b.error ?? 'no edges' });
    finish();
  }
  rates = ratesPerService(a.value!.edges!, b.value!.edges!, 60);
  const state = readScorerState();
  target = state ? pickTarget(state, rates) : undefined;
  log(`windows=${state?.windows ?? 0}; warm baselines: ${Object.entries(state?.baselines ?? {}).filter(([, v]) => v.n >= 5).length}; ` +
      `busiest: ${rates.sort((x, y) => y.callsPerMinute - x.callsPerMinute).slice(0, 3).map((r) => `${r.service} ${Math.round(r.callsPerMinute)}/min`).join(', ') || 'none'}`);
  if (target) break;
}
add({
  name: 'A service has a warm baseline and >= 20 calls/min of real traffic',
  ok: !!target,
  detail: target ? `${target.service}: baseline ${target.baselineMs.toFixed(2)} ms, ${Math.round(target.callsPerMinute)} calls/min over ${target.edgeCount} edge(s)` : `none within ${WARM_MINUTES} min; scorer state: ${JSON.stringify(readScorerState()?.baselines ?? {})}`,
});
if (!target) finish();
const chosen = target!;

const soakStart = Date.now();
console.log(`\nHealthy soak: ${SOAK_MINUTES} min with no injected fault...`);
sleepMs(SOAK_MINUTES * 60_000);
const soakCycles = cycleLogs(soakStart);
const soakIncidents = openIncidents();
const blips = soakCycles.filter((c) => c.anomalous.length > 0).length;
add({
  name: `Healthy soak (${SOAK_MINUTES} min): zero incidents`,
  ok: !soakIncidents.error && soakIncidents.items.length === 0 && soakCycles.every((c) => c.actions.length === 0),
  detail: soakIncidents.error ?? `${soakCycles.length} scorer runs, ${soakCycles.filter((c) => c.modelCalled).length} model calls, ${blips} window(s) with a deviating service, incidents: ${soakIncidents.items.length}`,
});
add({
  name: 'Scorer ran on schedule through the soak',
  ok: soakCycles.length >= Math.floor(SOAK_MINUTES * 0.7),
  detail: `${soakCycles.length} runs in ${SOAK_MINUTES} min (statuses: ${[...new Set(soakCycles.map((c) => c.status))].join(', ') || 'none'})`,
  warn: soakCycles.length > 0,
});
if (soakIncidents.items.length > 0) finish();

// --- 3. injected slow-down ---------------------------------------------------------------------
const plan = planDegrade(chosen);
console.log(`\nInjecting: ${plan.callsPerInjection} synthetic calls x ${plan.latencyMs} ms into each edge of ${plan.service}, ${plan.injectionsPerMinute}x/min ` +
  `(expected window average ${plan.expectedWindowAvgMs.toFixed(1)} ms, delta ~${plan.expectedDelta.toFixed(1)}).`);
const injectStart = Date.now();
const injectDeadline = injectStart + INJECT_MINUTES * 60_000;
let incident: Record<string, any> | undefined;
let injections = 0;
let confirmedWindows = 0;
while (Date.now() < injectDeadline) {
  const r = probe({ action: 'degrade', service: plan.service, calls: plan.callsPerInjection, latencyMs: plan.latencyMs });
  if (!r.value?.ok) {
    add({ name: 'Inject synthetic slow-down', ok: false, detail: r.error ?? JSON.stringify(r.value?.detail) });
    finish();
  }
  injections++;
  const open = openIncidents().items.filter((i) => Number(i.opened_at_ms) >= injectStart - 60_000);
  if (open.length > 0) {
    incident = open[0];
    confirmedWindows = Number(incident.windows);
    // Keep injecting until it has been UPDATED at least once (a third implicated window).
    if (confirmedWindows >= 3) break;
  }
  sleepMs(60_000 / plan.injectionsPerMinute);
}
const injectedFor = (Date.now() - injectStart) / 60_000;
add({
  name: 'An incident opens for the degraded system',
  ok: !!incident,
  detail: incident ? `${incident.incident_id} after ${injectedFor.toFixed(1)} min, ${injections} injections, windows=${incident.windows}` : `none within ${INJECT_MINUTES} min (${injections} injections)`,
});
if (!incident) finish();
const opened = incident!;

add({
  name: `Root cause is the degraded service (${plan.service})`,
  ok: opened.root_cause === plan.service,
  warn: opened.root_cause !== plan.service,
  detail: opened.root_cause === plan.service
    ? `top-1 ${opened.root_cause} at score ${Number(opened.score).toFixed(3)}`
    : `model named ${opened.root_cause}; ${plan.service} is #${(opened.ranking as { name: string }[]).findIndex((r) => r.name === plan.service) + 1 || 'not in the top 5'}. A finding about the model (65% top-1 on synthetic scenarios), not the pipeline.`,
});
for (const c of validateIncident(opened, plan.service, nowSeconds())) add(c);

const byService = queryIncidents(GSI_BY_SERVICE, String(opened.root_cause), nowSeconds());
const duringTest = byService.items.filter((i) => Number(i.opened_at_ms) >= injectStart - 60_000);
add({
  name: 'Exactly one incident for this root cause (updated in place, not duplicated)',
  ok: !byService.error && duringTest.length === 1,
  detail: byService.error ?? `${duringTest.length} incident(s): ${duringTest.map((i) => i.incident_id).join(', ')}`,
});

// --- 4. recovery -------------------------------------------------------------------------------
console.log(`\nSlow-down stopped. Waiting up to ${RECOVER_MINUTES} min for the incident to resolve (3 clean windows)...`);
const stopped = Date.now();
let resolved: Record<string, any> | undefined;
while (Date.now() < stopped + RECOVER_MINUTES * 60_000) {
  sleepMs(20_000);
  const current = getIncident(String(opened.incident_id));
  if (current?.status === 'RESOLVED') {
    resolved = current;
    break;
  }
}
add({
  name: 'Incident resolves after the fault stops',
  ok: !!resolved && Number(resolved.resolved_at_ms) > 0,
  detail: resolved ? `resolved after ${((Date.now() - stopped) / 60_000).toFixed(1)} min, windows=${resolved.windows}, peak score ${Number(resolved.peak_score).toFixed(3)}` : `still OPEN after ${RECOVER_MINUTES} min`,
});
const afterOpen = openIncidents();
add({ name: 'No open incidents remain', ok: !afterOpen.error && afterOpen.items.length === 0, detail: afterOpen.error ?? `${afterOpen.items.length} open` });

// --- 5. the scorer's own health ----------------------------------------------------------------
const sinceStart = soakStart - 60_000;
const errors = awsJson<{ events: { message: string }[] }>([
  'logs', 'filter-log-events', '--log-group-name', scorer.LogGroupName, '--start-time', String(sinceStart),
  '--filter-pattern', '?ERROR ?"Task timed out" ?errorMessage',
]);
add({
  name: 'No scorer errors during the whole run',
  ok: !errors.error && (errors.value?.events.length ?? 0) === 0,
  detail: errors.error ?? ((errors.value?.events.length ?? 0) === 0 ? 'none' : errors.value!.events[0].message.trim().slice(0, 240)),
});
const reports = awsJson<{ events: { message: string }[] }>([
  'logs', 'filter-log-events', '--log-group-name', scorer.LogGroupName, '--start-time', String(sinceStart), '--filter-pattern', '"REPORT RequestId"',
]);
const durations = (reports.value?.events ?? [])
  .map((e) => Number(/Duration: ([\d.]+) ms/.exec(e.message)?.[1]))
  .filter((d) => Number.isFinite(d));
if (durations.length > 0) {
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  add({ name: 'Scorer duration (informational)', ok: true, warn: true, detail: `${durations.length} runs, avg ${avg.toFixed(0)} ms, max ${Math.max(...durations).toFixed(0)} ms (the model call dominates when it happens)` });
}

console.log('\nPersisted incident:');
console.log(JSON.stringify(resolved ?? opened, null, 2));
finish();

/** Scorer cycle summaries logged since `sinceMs`. */
function cycleLogs(sinceMs: number): CycleLog[] {
  const r = awsJson<{ events: { message: string }[] }>([
    'logs', 'filter-log-events', '--log-group-name', scorer.LogGroupName, '--start-time', String(sinceMs), '--filter-pattern', '"scorer {"',
  ]);
  return (r.value?.events ?? []).map((e) => parseScorerLog(e.message)).filter((c): c is CycleLog => !!c);
}
