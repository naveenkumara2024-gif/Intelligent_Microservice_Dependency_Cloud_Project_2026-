// Stage 12b checkpoint: the alert delivery chain, from the incidents table onward. Run after
// `npm run deploy:dynamodb` and `npm run deploy:alerts`. Needs neither EKS, MSK, Neptune nor SageMaker.
//
// It writes SYNTHETIC incidents (id prefix `verify-`, the production record shape) straight into
// rca-incidents and watches the real chain react: DynamoDB stream -> dispatcher -> SNS -> Slack and
// PagerDuty notifiers. The asserts read CloudWatch Logs (and the queue), not status strings. The
// synthetic items are deleted at the end (and carry a 1 h TTL if the script dies first).
//
//   npm run verify:alerts
//   npm run verify:alerts -- --wait=180       seconds allowed for each leg (default 120)
//   npm run verify:alerts -- --after-destroy  after `npm run destroy:alerts` (+ destroy:dynamodb)
//
// What it can and cannot prove: with the SSM parameters unset the notifiers log `alert.skipped`
// with the rendered payload, so the chain is proven up to (not including) the HTTP call; the HTTP
// call itself is covered by the unit tests against a local server. With real values set, the same
// run reports `alert.sent` and you should see the Slack message / PagerDuty trigger + resolve.
import { INCIDENTS_TABLE, INCIDENT_KEY } from '../../src/lambda-transformer/src/scorer/schema';
import {
  PAGERDUTY_ROUTING_KEY_PARAM,
  SLACK_WEBHOOK_PARAM,
} from '../../src/lambda-transformer/src/alerts/names';
import {
  AlertLogLine,
  eventsFor,
  incidentIdOf,
  incidentItem,
  Lifecycle,
  parseAlertLog,
  tally,
} from './alerts-live';
import { aws, awsJson, Check, report } from './aws-cli';
import { ddb, sleepMs } from './ddb-cli';
import { AttributeValue, marshallItem } from './incidents-live';

const afterDestroy = process.argv.includes('--after-destroy');
const waitArg = process.argv.find((a) => a.startsWith('--wait='));
const WAIT_SECONDS = waitArg ? Number(waitArg.split('=')[1]) : 120;
const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

const stackOutputs = (stack: string) => {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return {
    out: Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue])),
    error: r.error,
  };
};

// --- teardown mode ----------------------------------------------------------------------------
if (afterDestroy) {
  for (const stack of ['AlertingStack']) {
    const r = aws(['cloudformation', 'describe-stacks', '--stack-name', stack]);
    add({
      name: `${stack} is gone`,
      ok: !r.ok && /does not exist/i.test(r.stderr),
      detail: r.ok ? 'stack still exists' : r.stderr.split('\n')[0],
    });
  }
  const topics = awsJson<{ Topics: { TopicArn: string }[] }>(['sns', 'list-topics']);
  const left = (topics.value?.Topics ?? []).filter((t) => t.TopicArn.endsWith(':rca-alerts'));
  add({ name: 'No rca-alerts topic left', ok: !topics.error && left.length === 0, detail: topics.error ?? (left.length ? left[0].TopicArn : 'none') });
  const queues = awsJson<{ QueueUrls?: string[] }>(['sqs', 'list-queues', '--queue-name-prefix', 'rca-alerts']);
  add({ name: 'No rca-alerts-dlq left', ok: !queues.error && (queues.value?.QueueUrls ?? []).length === 0, detail: queues.error ?? 'none' });
  const params = awsJson<{ Parameters: { Name: string }[] }>(['ssm', 'describe-parameters', '--parameter-filters', 'Key=Name,Option=BeginsWith,Values=/rca/alerts/']);
  add({
    name: 'Channel parameters (kept on purpose; delete with `aws ssm delete-parameter`)',
    ok: true,
    warn: (params.value?.Parameters ?? []).length > 0 ? true : false,
    detail: (params.value?.Parameters ?? []).map((p) => p.Name).join(', ') || 'none',
  });
  process.exit(report(checks) ? 0 : 1);
}

// --- deployed mode ----------------------------------------------------------------------------
const alerting = stackOutputs('AlertingStack');
const dynamo = stackOutputs('DynamodbStack');
if (!alerting.out.TopicArn || !dynamo.out.IncidentsTableName) {
  console.log('FAIL  AlertingStack / DynamodbStack: not deployed -- run npm run deploy:dynamodb then npm run deploy:alerts first');
  process.exit(1);
}
const functions = {
  dispatcher: alerting.out.DispatcherFunctionName,
  slack: alerting.out.SlackFunctionName,
  pagerduty: alerting.out.PagerDutyFunctionName,
};

const logGroupOf = (fn: string): string => {
  const r = awsJson<{ LoggingConfig?: { LogGroup?: string } }>(['lambda', 'get-function-configuration', '--function-name', fn]);
  return r.value?.LoggingConfig?.LogGroup ?? `/aws/lambda/${fn}`;
};
const groups = {
  dispatcher: logGroupOf(functions.dispatcher),
  slack: logGroupOf(functions.slack),
  pagerduty: logGroupOf(functions.pagerduty),
};

// 1. Static wiring ----------------------------------------------------------------------------
const table = awsJson<{ Table: { StreamSpecification?: { StreamEnabled: boolean; StreamViewType: string } } }>([
  'dynamodb', 'describe-table', '--table-name', INCIDENTS_TABLE,
]);
const spec = table.value?.Table.StreamSpecification;
add({
  name: 'Incidents table streams both images',
  ok: spec?.StreamEnabled === true && spec.StreamViewType === 'NEW_AND_OLD_IMAGES',
  detail: table.error ?? JSON.stringify(spec),
});

/** The mapping must be Enabled before the first write: it starts at LATEST and would miss earlier records. */
function mappingState(): { state?: string; lastResult?: string; error?: string } {
  const r = awsJson<{ EventSourceMappings: { State: string; LastProcessingResult?: string }[] }>([
    'lambda', 'list-event-source-mappings', '--function-name', functions.dispatcher,
  ]);
  const m = r.value?.EventSourceMappings?.[0];
  return { state: m?.State, lastResult: m?.LastProcessingResult, error: r.error };
}
let mapping = mappingState();
// A mapping starts at LATEST: anything written before it is live is never delivered. The first live
// run (2026-10-13) wrote while the mapping was still starting and every record was missed, so wait
// here (up to 10 min) and refuse to write if it never becomes Enabled.
for (let i = 0; i < 120 && mapping.state !== 'Enabled'; i++) {
  if (i % 6 === 0) console.log(`... waiting for the stream mapping (state: ${mapping.state ?? 'unknown'})`);
  sleepMs(5000);
  mapping = mappingState();
}
add({ name: 'Dispatcher stream mapping is Enabled', ok: mapping.state === 'Enabled', detail: mapping.error ?? `${mapping.state} (${mapping.lastResult ?? 'no result yet'})` });
if (mapping.state !== 'Enabled') {
  console.log('The stream mapping is not Enabled, so any record written now would be missed. Not writing anything.');
  process.exit(report(checks) ? 0 : 1);
}
// Enabled means the poller exists, not that it has fetched its LATEST shard iterator. Give it a beat.
console.log('... mapping is Enabled; settling for 20 s before the first write');
sleepMs(20_000);

const subs = awsJson<{ Subscriptions: { Protocol: string; SubscriptionArn: string; Endpoint: string }[] }>([
  'sns', 'list-subscriptions-by-topic', '--topic-arn', alerting.out.TopicArn,
]);
const lambdaSubs = (subs.value?.Subscriptions ?? []).filter((s) => s.Protocol === 'lambda');
const emailSubs = (subs.value?.Subscriptions ?? []).filter((s) => s.Protocol === 'email');
add({ name: 'Slack and PagerDuty Lambdas are subscribed to the topic', ok: !subs.error && lambdaSubs.length === 2, detail: subs.error ?? `${lambdaSubs.length} lambda subscription(s)` });
const confirmedEmail = emailSubs.filter((s) => s.SubscriptionArn.startsWith('arn:'));
const pendingEmail = emailSubs.length - confirmedEmail.length;
// A PendingConfirmation subscription has no ARN, so it cannot be unsubscribed by API: a placeholder
// address from an earlier deploy lingers until SNS expires it (3 days). It is not a failure as long
// as the address you actually deployed with is confirmed, so only "none confirmed" warns.
add({
  name: 'Email subscription',
  ok: true,
  warn: confirmedEmail.length === 0,
  detail:
    emailSubs.length === 0
      ? 'none configured (deploy with -c alertEmail=<addr> for a real end-to-end delivery)'
      : confirmedEmail.length === 0
        ? `${pendingEmail} pending, none confirmed -- click the link in the confirmation email, then re-run`
        : `${confirmedEmail.length} confirmed${pendingEmail > 0 ? `, ${pendingEmail} pending (a stale placeholder from an earlier deploy expires on its own after 3 days)` : ''}`,
});

const params = awsJson<{ InvalidParameters?: string[] }>(['ssm', 'get-parameters', '--names', SLACK_WEBHOOK_PARAM, PAGERDUTY_ROUTING_KEY_PARAM]);
const missing = new Set(params.value?.InvalidParameters ?? []);
const slackConfigured = !params.error && !missing.has(SLACK_WEBHOOK_PARAM);
const pagerdutyConfigured = !params.error && !missing.has(PAGERDUTY_ROUTING_KEY_PARAM);
add({ name: 'Slack webhook parameter', ok: slackConfigured, warn: !slackConfigured, detail: slackConfigured ? 'present (messages are really sent)' : `${SLACK_WEBHOOK_PARAM} not set: the notifier skips and logs the payload` });
add({ name: 'PagerDuty routing-key parameter', ok: pagerdutyConfigured, warn: !pagerdutyConfigured, detail: pagerdutyConfigured ? 'present (events are really sent)' : `${PAGERDUTY_ROUTING_KEY_PARAM} not set: the notifier skips and logs the payload` });

// 2. The chain ----------------------------------------------------------------------------------
const startMs = Date.now() - 30_000;
const runId = `verify-${Date.now()}`;
const openedAtMs = Date.now();
const keyOf = (id: string): Record<string, AttributeValue> => ({ [INCIDENT_KEY]: { S: id } });

function readLog(group: string): AlertLogLine[] {
  const r = awsJson<{ events?: { message: string }[] }>([
    'logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(startMs),
  ]);
  return (r.value?.events ?? []).flatMap((e) => parseAlertLog(e.message) ?? []);
}

/** Polls until `done` holds for the events logged under `names` for this incident, or the leg times out. */
function awaitEvents(group: string, names: string[], incidentId: string, done: (events: string[]) => boolean): string[] {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let events: string[] = [];
  for (;;) {
    events = eventsFor(readLog(group), names, incidentId);
    if (done(events) || Date.now() > deadline) return events;
    sleepMs(3000);
  }
}

function put(step: Lifecycle, nowMs: number): { id: string; ok: boolean; detail: string } {
  const item = incidentItem(runId, step, nowMs, openedAtMs);
  const r = ddb(['put-item', '--table-name', INCIDENTS_TABLE], { item: marshallItem(item) });
  return { id: incidentIdOf(item), ok: r.ok, detail: r.ok ? 'written' : r.stderr.split('\n')[0] };
}

const incidentId = incidentIdOf(incidentItem(runId, 'open', openedAtMs, openedAtMs));
try {
  console.log(`... writing synthetic incident ${incidentId} (OPEN)`);
  const opened = put('open', Date.now());
  add({ name: 'Synthetic incident written (OPEN)', ok: opened.ok, detail: `${opened.id}: ${opened.detail}` });

  console.log(`... waiting up to ${WAIT_SECONDS}s for the dispatcher to publish the opening`);
  const published = awaitEvents(groups.dispatcher, ['published'], incidentId, (e) => tally(e).opened >= 1);
  add({
    name: 'Opening alerts exactly once (stream -> dispatcher -> SNS)',
    ok: tally(published).opened === 1,
    detail: `${tally(published).opened} incident.opened published within ${WAIT_SECONDS}s`,
  });

  const seen = readLog(groups.dispatcher).find((l) => l.name === 'published' && l.fields.incident_id === incidentId);
  add({
    name: 'The alert carries the severity the blast radius implies',
    ok: seen?.fields.severity === 'critical',
    detail: seen ? `severity=${seen.fields.severity}, message_id=${seen.fields.message_id}` : 'no published line found',
  });

  for (const [channel, group, configured] of [
    ['Slack', groups.slack, slackConfigured],
    ['PagerDuty', groups.pagerduty, pagerdutyConfigured],
  ] as const) {
    const handled = awaitEvents(group, ['sent', 'skipped'], incidentId, (e) => tally(e).opened >= 1);
    const lines = readLog(group).filter((l) => l.fields.incident_id === incidentId && tally([String(l.fields.event)]).opened === 1);
    const outcome = lines.map((l) => l.name).join(',');
    add({
      name: `${channel} notifier handled the opening once`,
      ok: tally(handled).opened === 1 && outcome === (configured ? 'sent' : 'skipped'),
      detail: `${tally(handled).opened} handled, outcome: ${outcome || 'none'}${configured ? '' : ' (not configured: payload logged, no HTTP call)'}`,
    });
  }

  // The per-window rewrite (OPEN -> OPEN) must not alert. The stream is ordered per key, so by the
  // time the resolve below is delivered the rewrite has been processed.
  console.log('... rewriting OPEN -> OPEN, then resolving');
  const update = put('update', Date.now());
  add({ name: 'Synthetic incident rewritten (OPEN -> OPEN, as the scorer does every minute)', ok: update.ok, detail: update.detail });
  sleepMs(2000);

  const resolve = put('resolve', Date.now());
  add({ name: 'Synthetic incident resolved (RESOLVED)', ok: resolve.ok, detail: resolve.detail });

  const after = awaitEvents(groups.dispatcher, ['published'], incidentId, (e) => tally(e).resolved >= 1);
  add({
    name: 'Resolution alerts exactly once, and the rewrite alerted nothing',
    ok: tally(after).resolved === 1 && tally(after).opened === 1,
    detail: `published: ${tally(after).opened} opened, ${tally(after).resolved} resolved (want 1 and 1)`,
  });

  for (const [channel, group] of [['Slack', groups.slack], ['PagerDuty', groups.pagerduty]] as const) {
    const handled = awaitEvents(group, ['sent', 'skipped'], incidentId, (e) => tally(e).resolved >= 1);
    add({
      name: `${channel} notifier handled the resolution once`,
      ok: tally(handled).resolved === 1 && tally(handled).opened === 1,
      detail: `${tally(handled).opened} opened, ${tally(handled).resolved} resolved handled`,
    });
  }

  // 3. Health ---------------------------------------------------------------------------------
  const failures = Object.entries(groups).flatMap(([name, group]) => {
    const r = awsJson<{ events?: { message: string }[] }>([
      'logs', 'filter-log-events', '--log-group-name', group, '--start-time', String(startMs),
      '--filter-pattern', '?"Invoke Error" ?"Task timed out" ?"alert.publish_failed"',
    ]);
    return (r.value?.events ?? []).map((e) => `${name}: ${e.message.trim().slice(0, 160)}`);
  });
  add({ name: 'No invocation errors, timeouts or failed publishes', ok: failures.length === 0, detail: failures[0] ?? 'none in the run window' });

  const queue = awsJson<{ Attributes: Record<string, string> }>([
    'sqs', 'get-queue-attributes', '--queue-url', alerting.out.DeadLetterQueueUrl,
    '--attribute-names', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible',
  ]);
  const depth = Number(queue.value?.Attributes.ApproximateNumberOfMessages ?? NaN) + Number(queue.value?.Attributes.ApproximateNumberOfMessagesNotVisible ?? NaN);
  add({ name: 'Dead-letter queue is empty', ok: !queue.error && depth === 0, detail: queue.error ?? `${depth} message(s)` });
} finally {
  const gone = ddb(['delete-item', '--table-name', INCIDENTS_TABLE], { key: keyOf(incidentId) });
  add({ name: 'Synthetic incident removed', ok: gone.ok, warn: !gone.ok, detail: gone.ok ? incidentId : gone.stderr.split('\n')[0] });
}

console.log('\nIf an email address was subscribed and confirmed, expect two emails: "[RCA] Incident opened" and "[RCA] Incident resolved".');
process.exit(report(checks) ? 0 : 1);
