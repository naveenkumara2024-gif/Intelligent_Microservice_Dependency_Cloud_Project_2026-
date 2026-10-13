// DynamoDB persistence: the scorer's state item, incident records, and the reader the dashboard
// (Stage 13) and the verification scripts use.
//
// State and incident writes go in one transaction guarded by the state item's version, so two
// overlapping runs cannot both commit (no duplicate incident), and an incident is never recorded
// without the state that says it exists (or the reverse).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { ScorerStore } from './run';
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
  STATE_VERSION_ATTR,
  STATUS_ATTR,
  TTL_ATTR,
} from './schema';
import { IncidentRecord, ScorerState } from './types';

export interface TableNames {
  incidents: string;
  state: string;
}

export const DEFAULT_TABLES: TableNames = { incidents: INCIDENTS_TABLE, state: STATE_TABLE };

/** Marshalling options both the writer and readers must agree on. */
export const MARSHALL_OPTIONS = { removeUndefinedValues: true };

export function documentClient(client: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, { marshallOptions: MARSHALL_OPTIONS });
}

export class DynamoScorerStore implements ScorerStore {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tables: TableNames = DEFAULT_TABLES,
  ) {}

  async load(): Promise<ScorerState | undefined> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.state,
        Key: { [STATE_KEY]: STATE_KEY_VALUE },
        ConsistentRead: true,
      }),
    );
    if (!res.Item) return undefined;
    const state = JSON.parse(String(res.Item[STATE_JSON_ATTR])) as ScorerState;
    return { ...state, version: Number(res.Item[STATE_VERSION_ATTR]) };
  }

  async commit(state: ScorerState, incidents: IncidentRecord[]): Promise<boolean> {
    const version = state.version + 1;
    const item = {
      [STATE_KEY]: STATE_KEY_VALUE,
      [STATE_VERSION_ATTR]: version,
      [STATE_JSON_ATTR]: JSON.stringify({ ...state, version }),
    };
    const condition =
      state.version === 0
        ? { ConditionExpression: `attribute_not_exists(${STATE_KEY})` }
        : {
            ConditionExpression: '#v = :expected',
            ExpressionAttributeNames: { '#v': STATE_VERSION_ATTR },
            ExpressionAttributeValues: { ':expected': state.version },
          };

    try {
      if (incidents.length === 0) {
        await this.doc.send(new PutCommand({ TableName: this.tables.state, Item: item, ...condition }));
      } else {
        await this.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { Put: { TableName: this.tables.state, Item: item, ...condition } },
              ...incidents.map((incident) => ({ Put: { TableName: this.tables.incidents, Item: incident } })),
            ],
          }),
        );
      }
      return true;
    } catch (err) {
      const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
      if (e.name === 'ConditionalCheckFailedException') return false;
      // The state put is the first item; its failed condition is the only "lost the race" signal.
      if (e.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') {
        return false;
      }
      throw err;
    }
  }
}

export interface ListOptions {
  status?: 'OPEN' | 'RESOLVED';
  rootCause?: string;
  limit?: number;
  /** Injectable clock (ms). */
  nowMs?: number;
}

/**
 * Incidents newest first, from the status or service index. DynamoDB deletes expired items lazily
 * (up to 48 hours after expires_at), so expired-but-present items are filtered out here, and every
 * reader must do the same.
 */
export async function listIncidents(
  doc: DynamoDBDocumentClient,
  options: ListOptions = {},
  tables: TableNames = DEFAULT_TABLES,
): Promise<IncidentRecord[]> {
  if (!options.status && !options.rootCause) throw new Error('listIncidents needs a status or a rootCause');
  const byStatus = options.status !== undefined;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const res = await doc.send(
    new QueryCommand({
      TableName: tables.incidents,
      IndexName: byStatus ? GSI_BY_STATUS : GSI_BY_SERVICE,
      KeyConditionExpression: '#k = :v',
      FilterExpression: `${TTL_ATTR} > :now`,
      ExpressionAttributeNames: { '#k': byStatus ? STATUS_ATTR : ROOT_CAUSE_ATTR },
      ExpressionAttributeValues: { ':v': byStatus ? options.status : options.rootCause, ':now': nowSeconds },
      ScanIndexForward: false,
      Limit: options.limit ?? 50,
    }),
  );
  return (res.Items ?? []) as IncidentRecord[];
}

export async function getIncident(
  doc: DynamoDBDocumentClient,
  incidentId: string,
  tables: TableNames = DEFAULT_TABLES,
): Promise<IncidentRecord | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: tables.incidents, Key: { [INCIDENT_KEY]: incidentId }, ConsistentRead: true }),
  );
  return res.Item as IncidentRecord | undefined;
}
