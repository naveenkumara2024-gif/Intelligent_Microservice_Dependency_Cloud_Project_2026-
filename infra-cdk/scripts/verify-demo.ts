// Stage 14b checkpoint: a REAL fault in a running Online Boutique service must come out as the
// right incident and alerts, through every tier, with nothing written by hand.
//
// Needs the full stack set: VpcStack, EksStack + workloads (Kafka collector), MskStack,
// NeptuneStack, TransformerStack (-c graphBackend=neptune), SagemakerStack (InService),
// DynamodbStack, ScorerStack, AlertingStack.
//
//   npm run verify:demo                                         latency fault, productcatalogservice, 300ms
//   npm run verify:demo -- --fault=latency --delay=100ms
//   npm run verify:demo -- --fault=cpu --service=currencyservice --limit=15m
//   options: --warm=20 --soak=8 --hold=8 --recover=8 (minutes)
//
// Steps: wiring -> warm-up -> healthy soak -> measure -> apply fault -> wait for the incident ->
// hold -> clear fault -> wait for resolution -> alerts, SNS, DLQ -> verdict (scripts/demo-live.ts).
// The fault is cleared on every exit path the script controls. If you kill it (Ctrl-C), run
// `npm run fault -- clear`: the applied fault is recorded in .fault-state.json for exactly that.
import { aws, awsJson, Check, pinEksContext, report } from './aws-cli';
import { getIncident, queryIncidents, readScorerState, sleepMs } from './ddb-cli';
import { parseAlertLog, eventsFor } from './alerts-live';
import { DemoIncident, DemoObservation, evaluateDemo, intoService, windowEdges } from './demo-live';
import { applyFault, clearFaults, liveFaultView, loadRecords } from './fault-k8s';
import { Command, parseFaultArgs } from './fault-plan';
import { CycleLog, parseScorerLog, WARMUP_WINDOWS } from './incidents-live';
import { LiveEdge, makeProbeInvoker } from './probe-client';
import { GSI_BY_STATUS } from '../../src/lambda-transformer/src/scorer/schema';

const arg = (name: string) => process.argv.find((x) => x.startsWith(`--${name}=`))?.split('=')[1];
const minutesArg = (name: string, fallback: number) => Number(arg(name)) || fallback;
const WARM_MINUTES = minutesArg('warm', 20);
const SOAK_MINUTES = minutesArg('soak', 8);
const HOLD_MINUTES = minutesArg('hold', 8);
const RECOVER_MINUTES = minutesArg('recover', 8);

const faultKind = arg('fault') ?? 'latency';
const faultArgv = [faultKind, ...process.argv.filter((a) => /^--(service|delay|limit)=/.test(a))];
const parsed = parseFaultArgs(faultArgv);
if ('error' in parsed || (parsed.kind !== 'latency' && parsed.kind !== 'cpu')) {
  console.error('error' in parsed ? parsed.error : '--fault must be latency or cpu');
  process.exit(2);
}
const fault = parsed as Extract<Command, { kind: 'latency' | 'cpu' }>;

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);
const log = (m: string) => console.log(`  .. ${new Date().toISOString().slice(11, 19)} ${m}`);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function outputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

function logGroupOf(functionName: string): string {
  const r = awsJson<{ LoggingConfig?: { LogGroup?: string } }>(['lambda', 'get-function-configuration', '--function-name', functionName]);
  return r.value?.LoggingConfig?.LogGroup ?? `/aws/lambda/${functionName}`;
}

function logMessages(group: string, sinceMs: number, pattern: string): string[] {
  const r = awsJson<{ events?: { message: string }[] }>([
    'logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(sinceMs), '--filter-pattern', pattern,
  ]);
  return (r.value?.events ?? []).map((e) => e.message);
}

function stop(): never {
  process.exit(report(checks) ? 0 : 1);
}

// --- 1. wiring ---------------------------------------------------------------------------------
const scorer = outputs('ScorerStack');
const neptune = outputs('NeptuneStack');
const alerting = outputs('AlertingStack');
const missing = [
  ['ScorerStack', scorer.LogGroupName],
  ['NeptuneStack', neptune.ProbeFunctionName],
  ['AlertingStack', alerting.TopicArn],
].filter(([, v]) => !v).map(([n]) => n);
if (missing.length > 0) {
  console.log(`FAIL  not deployed: ${missing.join(', ')} (see the stack list at the top of this file)`);
  process.exit(1);
}
const endpoint = awsJson<{ EndpointStatus: string }>(['sagemaker', 'describe-endpoint', '--endpoint-name', 'rca-root-cause']);
add({ name: 'SageMaker endpoint is InService', ok: endpoint.value?.EndpointStatus === 'InService', detail: endpoint.error ?? String(endpoint.value?.EndpointStatus) });

const cluster = pinEksContext();
const kubeconfig = cluster.name ? aws(['eks', 'update-kubeconfig', '--name', cluster.name]) : undefined;
add({ name: 'EKS cluster reachable for kubectl', ok: !!cluster.name && !!kubeconfig?.ok, detail: cluster.error ?? kubeconfig?.stderr ?? String(cluster.name) });

const recorded = loadRecords();
const live = liveFaultView(fault.service);
add({
  name: 'No fault is applied before the run',
  ok: recorded.length === 0 && !live.error && live.extraLatency === undefined && live.cpuLimit === '200m',
  detail: live.error ?? `recorded=${recorded.length}, EXTRA_LATENCY=${live.extraLatency ?? '-'}, cpu limit=${live.cpuLimit}`,
});
const preOpen = queryIncidents(GSI_BY_STATUS, 'OPEN', nowSeconds());
add({ name: 'No open incident before the run', ok: !preOpen.error && preOpen.items.length === 0, detail: preOpen.error ?? `${preOpen.items.length} open` });
if (!checks.every((c) => c.ok)) stop();

const probe = makeProbeInvoker(neptune.ProbeFunctionName);
const edges = (): LiveEdge[] => {
  const r = probe({ action: 'edges', limit: 2000 });
  if (!r.value?.edges) throw new Error(`probe edges failed: ${r.error ?? JSON.stringify(r.value?.detail)}`);
  return r.value.edges;
};
/** Latency into the target over one real minute, measured in Neptune. */
const measureMinute = () => {
  const a = edges();
  sleepMs(60_000);
  return intoService(windowEdges(a, edges()), fault.service);
};
const cycles = (sinceMs: number): CycleLog[] =>
  logMessages(scorer.LogGroupName, sinceMs, '"scorer {"').map(parseScorerLog).filter((c): c is CycleLog => !!c);

// --- 2. warm-up ----------------------------------------------------------------------------------
console.log(`\nWarm-up: waiting up to ${WARM_MINUTES} min for a warm baseline on ${fault.service}...`);
const warmDeadline = Date.now() + WARM_MINUTES * 60_000;
let warm = false;
while (Date.now() < warmDeadline) {
  const state = readScorerState();
  const b = state?.baselines?.[fault.service];
  log(`scorer windows=${state?.windows ?? 0}, ${fault.service} baseline=${b ? `${b.ms.toFixed(2)} ms over ${b.n} windows` : 'none yet'}`);
  if (b && b.n >= WARMUP_WINDOWS) {
    warm = true;
    break;
  }
  sleepMs(60_000);
}
add({ name: `${fault.service} has a warm baseline (>= ${WARMUP_WINDOWS} windows)`, ok: warm, detail: warm ? 'ready' : `not within ${WARM_MINUTES} min (too little traffic to it?)` });
if (!warm) stop();

// --- 3. healthy soak, and the "before" latency ------------------------------------------------------
console.log(`\nHealthy soak: ${SOAK_MINUTES} min, no fault...`);
const soakStart = Date.now();
sleepMs(Math.max(0, SOAK_MINUTES - 1) * 60_000);
const before = measureMinute();
const soakCycles = cycles(soakStart);
const soakOpened = queryIncidents(GSI_BY_STATUS, 'OPEN', nowSeconds()).items.length;
log(`soak: ${soakCycles.length} runs, ${soakCycles.filter((c) => c.modelCalled).length} model calls, ${soakOpened} open; ` +
  `into ${fault.service}: ${before ? `${before.avgMs.toFixed(2)} ms over ${before.calls} calls/min` : 'no calls'}`);

// --- 4. the fault ------------------------------------------------------------------------------------
const observation: Partial<DemoObservation> = {
  soak: { minutes: SOAK_MINUTES, incidentsOpened: soakOpened, modelCalls: soakCycles.filter((c) => c.modelCalled).length, scorerRuns: soakCycles.length },
};
let appliedAtMs: number | undefined;
let clearedAtMs: number | undefined;
let tracked: Record<string, any> | undefined;
let incidentsAfter: Record<string, any>[] = [];
let during: ReturnType<typeof intoService>;

try {
  console.log(`\nApplying: ${faultArgv.join(' ')}`);
  const applied = applyFault(fault);
  if (!applied.record || applied.error) {
    add({ name: 'Fault applied and rolled out', ok: false, detail: applied.error ?? 'no record' });
    throw new Error('fault not applied');
  }
  appliedAtMs = applied.record.appliedAtMs;
  add({ name: 'Fault applied and rolled out', ok: true, detail: `${applied.record.service}: ${applied.record.applied}` });

  sleepMs(60_000); // let the slow pods take traffic for a full minute first
  during = measureMinute();
  log(`into ${fault.service} while faulted: ${during ? `${during.avgMs.toFixed(2)} ms over ${during.calls} calls/min` : 'no calls (fault too strong for the load?)'}`);

  // --- 5. wait for the incident, then hold so it is updated in place ------------------------------
  console.log(`\nHolding the fault up to ${HOLD_MINUTES} min (open, then at least one in-place update)...`);
  const holdDeadline = appliedAtMs + HOLD_MINUTES * 60_000;
  while (Date.now() < holdDeadline) {
    incidentsAfter = queryIncidents(GSI_BY_STATUS, 'OPEN', nowSeconds()).items.filter((i) => Number(i.opened_at_ms) >= appliedAtMs! - 60_000);
    tracked = incidentsAfter.sort((a, b) => Number(a.opened_at_ms) - Number(b.opened_at_ms))[0];
    log(tracked ? `incident ${tracked.incident_id}: root cause ${tracked.root_cause}, windows=${tracked.windows}` : 'no incident yet');
    if (tracked && Number(tracked.windows) >= 3) break;
    sleepMs(30_000);
  }
} catch (err) {
  log(`stopped early: ${(err as Error).message}`);
} finally {
  // Always undo the fault, whatever happened above.
  const cleared = clearFaults();
  clearedAtMs = cleared.cleared.length > 0 ? Date.now() : undefined;
  for (const e of cleared.errors) log(`CLEAR FAILED: ${e} -- run npm run fault -- clear`);
  if (cleared.cleared.length > 0) log(`fault cleared: ${cleared.cleared.map((c) => `${c.service} (${c.applied})`).join(', ')}`);
}

// --- 6. recovery ---------------------------------------------------------------------------------------
if (tracked && clearedAtMs !== undefined) {
  console.log(`\nWaiting up to ${RECOVER_MINUTES} min for the incident to resolve...`);
  const deadline = clearedAtMs + RECOVER_MINUTES * 60_000;
  while (Date.now() < deadline) {
    const current = getIncident(String(tracked.incident_id));
    if (current) tracked = current;
    if (current?.status === 'RESOLVED') break;
    sleepMs(20_000);
  }
  log(`incident ${tracked.incident_id} is ${tracked.status}`);
  // The resolved alert goes out on the stream; give the dispatcher and SNS a moment.
  sleepMs(30_000);
}

// --- 7. alerts and delivery ------------------------------------------------------------------------------
const since = appliedAtMs ?? soakStart;
const dispatcherLines = logMessages(logGroupOf(alerting.DispatcherFunctionName), since - 60_000, '"alert.published"')
  .map(parseAlertLog)
  .filter((l): l is NonNullable<typeof l> => !!l);
const published = tracked ? eventsFor(dispatcherLines, ['published'], String(tracked.incident_id)) : [];

const metric = (name: string) => {
  const r = awsJson<{ Datapoints: { Sum: number }[] }>([
    'cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/SNS', '--metric-name', name,
    '--dimensions', 'Name=TopicName,Value=rca-alerts', '--start-time', new Date(since - 60_000).toISOString(),
    '--end-time', new Date().toISOString(), '--period', '60', '--statistics', 'Sum',
  ]);
  return (r.value?.Datapoints ?? []).reduce((a, d) => a + d.Sum, 0);
};
const queue = awsJson<{ Attributes: Record<string, string> }>([
  'sqs', 'get-queue-attributes', '--queue-url', alerting.DeadLetterQueueUrl,
  '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
]);
const deadLetters =
  Number(queue.value?.Attributes.ApproximateNumberOfMessages ?? 0) + Number(queue.value?.Attributes.ApproximateNumberOfMessagesNotVisible ?? 0);

const after = liveFaultView(fault.service);
const toDemoIncident = (i: Record<string, any>): DemoIncident => ({
  incident_id: String(i.incident_id),
  status: String(i.status),
  root_cause: String(i.root_cause),
  opened_at_ms: Number(i.opened_at_ms),
  resolved_at_ms: i.resolved_at_ms === undefined ? undefined : Number(i.resolved_at_ms),
  windows: Number(i.windows),
  score: Number(i.score),
  ranking: (i.ranking ?? []) as DemoIncident['ranking'],
  blast_radius: (i.blast_radius ?? []) as string[],
  at_risk: (i.at_risk ?? []) as string[],
});

const result: DemoObservation = {
  fault: { service: fault.service, description: faultArgv.join(' '), appliedAtMs: appliedAtMs ?? 0, clearedAtMs },
  soak: observation.soak!,
  latency: { before, during },
  incidents: incidentsAfter.map(toDemoIncident),
  final: tracked ? toDemoIncident(tracked) : undefined,
  alertsPublished: published,
  sns: { delivered: metric('NumberOfNotificationsDelivered'), failed: metric('NumberOfNotificationsFailed') },
  deadLetters,
  faultRemoved: !after.error && after.extraLatency === undefined && after.cpuLimit === '200m' && loadRecords().length === 0,
};
for (const c of evaluateDemo(result)) add(c);

const errors = logMessages(scorer.LogGroupName, soakStart, '?ERROR ?"Task timed out" ?errorMessage');
add({ name: 'No scorer errors during the run', ok: errors.length === 0, detail: errors[0]?.trim().slice(0, 200) ?? 'none' });

if (tracked) {
  console.log('\nPersisted incident:');
  console.log(JSON.stringify(tracked, null, 2));
}
stop();
