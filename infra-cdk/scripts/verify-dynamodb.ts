// Stage 11b-i checkpoint: the incident and scorer-state tables, without Neptune, SageMaker or the
// scorer. Run after `npm run deploy:dynamodb`, and again with --after-destroy after
// `npm run destroy:dynamodb`. Uses only the AWS CLI. Writes a handful of items under a unique
// `verify-<timestamp>` prefix (never the scorer's own `pk = scorer` item) and removes them again.
// DynamoDB on-demand: this costs a few request units.
//
//   npm run verify:dynamodb
//   npm run verify:dynamodb -- --after-destroy
import {
  GSI_BY_SERVICE,
  GSI_BY_STATUS,
  INCIDENTS_TABLE,
  INCIDENT_KEY,
  STATE_KEY,
  STATE_TABLE,
  TTL_ATTR,
} from '../../src/lambda-transformer/src/scorer/schema';
import { aws, awsJson, Check, report } from './aws-cli';
import { ddb, queryUntil } from './ddb-cli';
import { AttributeValue, marshallItem } from './incidents-live';

const afterDestroy = process.argv.includes('--after-destroy');
const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

function outputs(stack: string): Record<string, string> {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
}

// --- teardown mode ----------------------------------------------------------------------------
if (afterDestroy) {
  const list = awsJson<{ TableNames: string[] }>(['dynamodb', 'list-tables']);
  const left = (list.value?.TableNames ?? []).filter((n) => [INCIDENTS_TABLE, STATE_TABLE].includes(n));
  add({ name: 'No Stage 11 tables left', ok: !list.error && left.length === 0, detail: list.error ?? (left.join(', ') || 'none') });

  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', 'DynamodbStack']);
  add({
    name: 'DynamodbStack is gone',
    ok: !stack.ok && /does not exist/i.test(stack.stderr),
    detail: stack.ok ? 'stack still exists' : stack.stderr.split('\n')[0],
  });
  process.exit(report(checks) ? 0 : 1);
}

// --- deployed mode ----------------------------------------------------------------------------
// Rehearsal: with AWS_ENDPOINT_URL_DYNAMODB pointing at DynamoDB Local (and the two tables created
// there under their real names) the behavioural checks run without an AWS account; the checks that
// need the real service (stack outputs, KMS) are skipped and said to be.
const local = !!process.env.AWS_ENDPOINT_URL_DYNAMODB;
const out = local ? { IncidentsTableName: INCIDENTS_TABLE, TableKeyArn: '' } : outputs('DynamodbStack');
if (!out.IncidentsTableName) {
  console.log('FAIL  DynamodbStack: not deployed (no IncidentsTableName output) -- run npm run deploy:dynamodb first');
  process.exit(1);
}

interface TableDescription {
  Table: {
    TableStatus: string;
    BillingModeSummary?: { BillingMode: string };
    SSEDescription?: { Status: string; SSEType: string; KMSMasterKeyArn?: string };
    KeySchema: { AttributeName: string; KeyType: string }[];
    GlobalSecondaryIndexes?: { IndexName: string; IndexStatus: string; KeySchema: { AttributeName: string; KeyType: string }[] }[];
  };
}
const describe = (name: string) => awsJson<TableDescription>(['dynamodb', 'describe-table', '--table-name', name]);

for (const name of [INCIDENTS_TABLE, STATE_TABLE]) {
  const d = describe(name);
  const t = d.value?.Table;
  add({ name: `${name} is ACTIVE and on-demand`, ok: t?.TableStatus === 'ACTIVE' && (t.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST') === 'PAY_PER_REQUEST', detail: d.error ?? `${t?.TableStatus}, ${t?.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST'}` });
  if (local) {
    add({ name: `${name} customer-managed key`, ok: true, warn: true, detail: 'skipped: DynamoDB Local has no KMS' });
  } else {
    add({
      name: `${name} is encrypted with the customer-managed key`,
      ok: t?.SSEDescription?.SSEType === 'KMS' && t.SSEDescription.Status === 'ENABLED' && t.SSEDescription.KMSMasterKeyArn === out.TableKeyArn,
      detail: d.error ?? `${t?.SSEDescription?.SSEType} ${t?.SSEDescription?.Status} ${t?.SSEDescription?.KMSMasterKeyArn ?? ''}`,
    });
  }
}

const incidents = describe(INCIDENTS_TABLE).value?.Table;
for (const [index, hash] of [[GSI_BY_STATUS, 'status'], [GSI_BY_SERVICE, 'root_cause']] as const) {
  const gsi = incidents?.GlobalSecondaryIndexes?.find((g) => g.IndexName === index);
  const keys = gsi?.KeySchema.map((k) => `${k.AttributeName}:${k.KeyType}`).join(',');
  add({
    name: `Index ${index} is ACTIVE, ${hash} + opened_at_ms`,
    ok: gsi?.IndexStatus === 'ACTIVE' && keys === `${hash}:HASH,opened_at_ms:RANGE`,
    detail: gsi ? `${gsi.IndexStatus} ${keys}` : 'missing',
  });
}

const ttl = awsJson<{ TimeToLiveDescription: { TimeToLiveStatus: string; AttributeName?: string } }>([
  'dynamodb', 'describe-time-to-live', '--table-name', INCIDENTS_TABLE,
]);
const ttlStatus = ttl.value?.TimeToLiveDescription;
add({
  name: `TTL enabled on ${TTL_ATTR}`,
  ok: (ttlStatus?.TimeToLiveStatus === 'ENABLED' || ttlStatus?.TimeToLiveStatus === 'ENABLING') && ttlStatus.AttributeName === TTL_ATTR,
  detail: ttl.error ?? `${ttlStatus?.TimeToLiveStatus} on ${ttlStatus?.AttributeName} (expiry itself is lazy, up to 48 h: configuration is what is verified)`,
});
const stateTtl = awsJson<{ TimeToLiveDescription: { TimeToLiveStatus: string } }>(['dynamodb', 'describe-time-to-live', '--table-name', STATE_TABLE]);
add({
  name: 'State table has no TTL (it must never expire under the scorer)',
  ok: stateTtl.value?.TimeToLiveDescription.TimeToLiveStatus === 'DISABLED',
  detail: stateTtl.error ?? stateTtl.value?.TimeToLiveDescription.TimeToLiveStatus ?? '',
});

// --- behaviour --------------------------------------------------------------------------------
const run = `verify-${Date.now()}`;
const nowSec = Math.floor(Date.now() / 1000);
const incident = (suffix: string, extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  [INCIDENT_KEY]: `${run}-${suffix}`,
  status: 'OPEN',
  root_cause: `${run}-svc`,
  opened_at_ms: Date.now(),
  last_seen_ms: Date.now(),
  score: 0.5,
  peak_score: 0.5,
  ranking: [{ name: 'x', score: 0.5 }],
  blast_radius: [],
  at_risk: [],
  evidence: {},
  windows: 2,
  model_version: 'verify',
  [TTL_ATTR]: nowSec + 3600,
  ...extra,
});
const incidentKey = (id: string): Record<string, AttributeValue> => ({ [INCIDENT_KEY]: { S: id } });
const created: string[] = [];
const createdState: string[] = [];

try {
  // write and read back through both indexes (indexes are eventually consistent: retry briefly)
  const live = incident('live');
  const expired = incident('expired', { [TTL_ATTR]: nowSec - 100, opened_at_ms: Date.now() - 1000 });
  for (const item of [live, expired]) {
    const put = ddb(['put-item', '--table-name', INCIDENTS_TABLE], { item: marshallItem(item) });
    created.push(item[INCIDENT_KEY] as string);
    if (!put.ok) add({ name: `Put ${item[INCIDENT_KEY]}`, ok: false, detail: put.stderr });
  }

  const hasLive = (items: Record<string, any>[]) => items.some((i) => i[INCIDENT_KEY] === live[INCIDENT_KEY]);
  const byStatus = queryUntil(GSI_BY_STATUS, 'OPEN', nowSec, hasLive);
  const statusIds = byStatus.items.map((i) => String(i[INCIDENT_KEY]));
  add({
    name: 'Query by status finds the live incident, and the filter drops the expired-but-present one',
    ok: !byStatus.error && statusIds.includes(live[INCIDENT_KEY] as string) && !statusIds.includes(expired[INCIDENT_KEY] as string),
    detail: byStatus.error ?? `${statusIds.filter((i) => i.startsWith(run)).join(', ') || 'none of ours'}`,
  });
  const byService = queryUntil(GSI_BY_SERVICE, `${run}-svc`, nowSec, hasLive);
  add({
    name: 'Query by service finds it too',
    ok: !byService.error && byService.items.some((i) => i[INCIDENT_KEY] === live[INCIDENT_KEY]),
    detail: byService.error ?? `${byService.items.length} item(s)`,
  });

  // optimistic versioning on the state item
  const stateKey = `${run}-state`;
  createdState.push(stateKey);
  const stateItem = (version: number) => marshallItem({ [STATE_KEY]: stateKey, version, state_json: '{}' });
  const putState = (version: number, condition: string, values?: Record<string, AttributeValue>) =>
    ddb(['put-item', '--table-name', STATE_TABLE, '--condition-expression', condition], {
      item: stateItem(version),
      ...(values ? { 'expression-attribute-values': values } : {}),
      ...(condition.includes('#v') ? { 'expression-attribute-names': { '#v': 'version' } } : {}),
    });
  const first = putState(1, `attribute_not_exists(${STATE_KEY})`);
  const second = putState(1, `attribute_not_exists(${STATE_KEY})`);
  add({
    name: 'First state commit is exclusive',
    ok: first.ok && !second.ok && /ConditionalCheckFailed/.test(second.stderr),
    detail: first.ok ? (second.ok ? 'second "first" commit also succeeded' : second.stderr.split('\n')[0]) : first.stderr,
  });
  const fresh = putState(2, '#v = :expected', { ':expected': { N: '1' } });
  const stale = putState(3, '#v = :expected', { ':expected': { N: '1' } });
  add({
    name: 'A stale version is rejected, the current one accepted',
    ok: fresh.ok && !stale.ok && /ConditionalCheckFailed/.test(stale.stderr),
    detail: fresh.ok ? (stale.ok ? 'stale write succeeded' : stale.stderr.split('\n')[0]) : fresh.stderr,
  });

  // the property the scorer relies on: a lost race writes NO incident
  const loser = incident('loser');
  const tx = ddb(['transact-write-items'], {
    'transact-items': [
      {
        Put: {
          TableName: STATE_TABLE,
          Item: stateItem(99),
          ConditionExpression: '#v = :expected',
          ExpressionAttributeNames: { '#v': 'version' },
          ExpressionAttributeValues: { ':expected': { N: '1' } }, // stale: the item is at version 2
        },
      },
      { Put: { TableName: INCIDENTS_TABLE, Item: marshallItem(loser) } },
    ],
  });
  created.push(loser[INCIDENT_KEY] as string);
  const read = ddb(['get-item', '--table-name', INCIDENTS_TABLE, '--consistent-read'], { key: incidentKey(loser[INCIDENT_KEY] as string) });
  const got = { value: read.ok && read.stdout.trim() ? (JSON.parse(read.stdout) as { Item?: unknown }) : undefined };
  add({
    name: 'A transaction that loses the version race writes no incident',
    ok: !tx.ok && /TransactionCanceled/.test(tx.stderr) && read.ok && !got.value?.Item,
    detail: tx.ok ? 'transaction succeeded despite a stale version' : (got.value?.Item ? 'incident was written anyway' : 'cancelled, incident absent'),
  });
} finally {
  for (const id of created) {
    ddb(['delete-item', '--table-name', INCIDENTS_TABLE], { key: incidentKey(id) });
  }
  for (const key of createdState) {
    ddb(['delete-item', '--table-name', STATE_TABLE], { key: { [STATE_KEY]: { S: key } } });
  }
}

process.exit(report(checks) ? 0 : 1);
