// Fakes for the dashboard API tests: an in-memory DynamoDB document client that answers the two
// commands the readers send (index Query, consistent Get) the way the real service filters them,
// plus builders for HTTP API events.
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ApiDeps } from '../src/api/handler';
import { ORIGIN_HEADER } from '../src/api/http';
import { HttpApiEvent } from '../src/api/types';
import { IncidentRecord, ScorerState } from '../src/scorer/types';
import { T0 } from './alert-helpers';

export const SECRET = 'test-origin-secret-4f9c';

export class FakeDoc {
  items: IncidentRecord[] = [];
  sent: { name: string; input: any }[] = [];
  failWith?: Error;

  async send(command: any): Promise<any> {
    const name = command.constructor.name as string;
    const input = command.input;
    this.sent.push({ name, input });
    if (this.failWith) throw this.failWith;

    if (name === 'QueryCommand') {
      const byStatus = input.IndexName === 'by-status';
      const value = input.ExpressionAttributeValues[':v'];
      const now = input.ExpressionAttributeValues[':now'];
      const rows = this.items
        .filter((i) => (byStatus ? i.status : i.root_cause) === value && i.expires_at > now)
        .sort((a, b) => b.opened_at_ms - a.opened_at_ms)
        .slice(0, input.Limit);
      return { Items: structuredClone(rows) };
    }
    if (name === 'GetCommand') {
      const item = this.items.find((i) => i.incident_id === input.Key.incident_id);
      return { Item: item ? structuredClone(item) : undefined };
    }
    throw new Error(`FakeDoc does not implement ${name}`);
  }
}

export function event(path: string, options: Partial<HttpApiEvent> & { method?: string; secret?: string | null } = {}): HttpApiEvent {
  const { method = 'GET', secret = SECRET, ...rest } = options;
  return {
    rawPath: path,
    headers: secret === null ? {} : { [ORIGIN_HEADER]: secret },
    requestContext: { http: { method } },
    ...rest,
  };
}

type Overrides = Omit<Partial<ApiDeps>, 'doc' | 'state'> & { doc?: FakeDoc; state?: ScorerState };

/** Dependencies with in-memory fakes; `doc` is typed as the fake so tests can read `doc.sent`. */
export function apiDeps(overrides: Overrides = {}): ApiDeps & { doc: DynamoDBDocumentClient & FakeDoc } {
  const { state, doc, ...rest } = overrides;
  return {
    originSecret: SECRET,
    doc: (doc ?? new FakeDoc()) as unknown as DynamoDBDocumentClient & FakeDoc,
    tables: { incidents: 'rca-incidents', state: 'rca-scorer-state' },
    graph: undefined,
    state: { load: async () => state },
    now: () => T0 + 2 * 60_000,
    topologyCacheSeconds: 10,
    ...rest,
  };
}
