// DynamoDB through the AWS CLI, for the Stage 11 verify scripts. Everything that needs a JSON
// argument goes through a temp file (inline JSON is fragile across Windows shells). Rehearsed
// against DynamoDB Local by setting AWS_ENDPOINT_URL_DYNAMODB (see verify-dynamodb.ts).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GSI_BY_SERVICE,
  GSI_BY_STATUS,
  INCIDENTS_TABLE,
  INCIDENT_KEY,
  ROOT_CAUSE_ATTR,
  STATE_JSON_ATTR,
  STATE_KEY,
  STATE_KEY_VALUE,
  STATE_TABLE,
  STATUS_ATTR,
  TTL_ATTR,
} from '../../src/lambda-transformer/src/scorer/schema';
import { aws, awsJson } from './aws-cli';
import { AttributeValue, unmarshallItem } from './incidents-live';

export const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function tempJson(value: unknown): string {
  const file = path.join(os.tmpdir(), `ddb-cli-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return `file://${file.replace(/\\/g, '/')}`;
}
export const removeTemp = (uri: string) => fs.rmSync(uri.replace(/^file:\/\//, ''), { force: true });

/** `aws dynamodb <subcommand>`; each entry of `json` becomes `--<flag> file://<temp>`. */
export function ddb(subcommand: string[], json: Record<string, unknown> = {}): { ok: boolean; stdout: string; stderr: string } {
  const files: string[] = [];
  const args = ['dynamodb', ...subcommand];
  for (const [flag, value] of Object.entries(json)) {
    const uri = tempJson(value);
    files.push(uri);
    args.push(`--${flag}`, uri);
  }
  try {
    return aws(args);
  } finally {
    files.forEach(removeTemp);
  }
}

export type Item = Record<string, any>;

/** Incidents from an index, newest first, with expired-but-not-yet-deleted items filtered out. */
export function queryIncidents(index: typeof GSI_BY_STATUS | typeof GSI_BY_SERVICE, value: string, nowSeconds: number): { items: Item[]; error?: string } {
  const attr = index === GSI_BY_STATUS ? STATUS_ATTR : ROOT_CAUSE_ATTR;
  const names = tempJson({ '#k': attr });
  const values = tempJson({ ':v': { S: value }, ':now': { N: String(nowSeconds) } });
  try {
    const r = awsJson<{ Items: Record<string, AttributeValue>[] }>([
      'dynamodb', 'query', '--table-name', INCIDENTS_TABLE, '--index-name', index, '--no-scan-index-forward',
      '--key-condition-expression', '#k = :v', '--filter-expression', `${TTL_ATTR} > :now`,
      '--expression-attribute-names', names, '--expression-attribute-values', values,
    ]);
    return { items: (r.value?.Items ?? []).map(unmarshallItem), error: r.error };
  } finally {
    removeTemp(names);
    removeTemp(values);
  }
}

/** Indexes are eventually consistent: retry until `want` holds or the attempts run out. */
export function queryUntil(
  index: typeof GSI_BY_STATUS | typeof GSI_BY_SERVICE,
  value: string,
  nowSeconds: number,
  want: (items: Item[]) => boolean,
  attempts = 20,
): { items: Item[]; error?: string } {
  let last: { items: Item[]; error?: string } = { items: [] };
  for (let i = 0; i < attempts; i++) {
    last = queryIncidents(index, value, nowSeconds);
    if (!last.error && want(last.items)) break;
    sleepMs(1000);
  }
  return last;
}

export function getIncident(id: string): Item | undefined {
  const r = ddb(['get-item', '--table-name', INCIDENTS_TABLE, '--consistent-read'], { key: { [INCIDENT_KEY]: { S: id } } });
  if (!r.ok || !r.stdout.trim()) return undefined;
  const item = (JSON.parse(r.stdout) as { Item?: Record<string, AttributeValue> }).Item;
  return item ? unmarshallItem(item) : undefined;
}

export interface ScorerStateView {
  version: number;
  windows: number;
  baselines: Record<string, { ms: number; n: number }>;
  trackers: Record<string, { hits: number; misses: number; incident?: Item }>;
  counters: { um: string; dm: string; calls: number }[];
}

/** The scorer's own state item, or undefined before its first run. */
export function readScorerState(): ScorerStateView | undefined {
  const r = ddb(['get-item', '--table-name', STATE_TABLE, '--consistent-read'], { key: { [STATE_KEY]: { S: STATE_KEY_VALUE } } });
  if (!r.ok || !r.stdout.trim()) return undefined;
  const item = (JSON.parse(r.stdout) as { Item?: Record<string, AttributeValue> }).Item;
  if (!item) return undefined;
  return JSON.parse(String(unmarshallItem(item)[STATE_JSON_ATTR])) as ScorerStateView;
}
