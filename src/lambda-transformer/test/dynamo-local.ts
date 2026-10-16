// Table setup for tests against DynamoDB Local. The key and index names come from the same
// schema.ts that DynamodbStack imports, so the tests and the real tables cannot disagree on them
// (infra-cdk/test/dynamodb-stack.test.ts asserts the stack side).
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import {
  GSI_BY_SERVICE,
  GSI_BY_STATUS,
  INCIDENT_KEY,
  OPENED_AT_ATTR,
  ROOT_CAUSE_ATTR,
  STATE_KEY,
  STATUS_ATTR,
} from '../src/scorer/schema';
import { TableNames } from '../src/scorer/store';

export const DYNAMODB_URL = process.env.DYNAMODB_URL ?? 'http://localhost:8000';

export function localClient(): DynamoDBClient {
  return new DynamoDBClient({
    endpoint: DYNAMODB_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
}

export function uniqueTables(): TableNames {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return { incidents: `rca-incidents-test-${suffix}`, state: `rca-scorer-state-test-${suffix}` };
}

export async function requireDynamoLocal(client: DynamoDBClient): Promise<void> {
  try {
    await client.send(new ListTablesCommand({}));
  } catch (err) {
    throw new Error(
      `Cannot reach DynamoDB Local at ${DYNAMODB_URL}. Start Docker Desktop, then:\n` +
        '  docker compose --profile dynamodb up -d dynamodb-local\n' +
        `(${(err as Error).message})`,
    );
  }
}

export async function createTables(client: DynamoDBClient, tables: TableNames): Promise<void> {
  const gsi = (name: string, hash: string) => ({
    IndexName: name,
    KeySchema: [
      { AttributeName: hash, KeyType: 'HASH' as const },
      { AttributeName: OPENED_AT_ATTR, KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  });
  await client.send(
    new CreateTableCommand({
      TableName: tables.incidents,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: INCIDENT_KEY, KeyType: 'HASH' }],
      AttributeDefinitions: [
        { AttributeName: INCIDENT_KEY, AttributeType: 'S' },
        { AttributeName: STATUS_ATTR, AttributeType: 'S' },
        { AttributeName: ROOT_CAUSE_ATTR, AttributeType: 'S' },
        { AttributeName: OPENED_AT_ATTR, AttributeType: 'N' },
      ],
      GlobalSecondaryIndexes: [gsi(GSI_BY_STATUS, STATUS_ATTR), gsi(GSI_BY_SERVICE, ROOT_CAUSE_ATTR)],
    }),
  );
  await client.send(
    new CreateTableCommand({
      TableName: tables.state,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: STATE_KEY, KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: STATE_KEY, AttributeType: 'S' }],
    }),
  );
  for (const name of [tables.incidents, tables.state]) {
    await waitUntilTableExists({ client, maxWaitTime: 60, minDelay: 1, maxDelay: 2 }, { TableName: name });
  }
}

export async function dropTables(client: DynamoDBClient, tables: TableNames): Promise<void> {
  for (const name of [tables.incidents, tables.state]) {
    await client.send(new DeleteTableCommand({ TableName: name })).catch(() => undefined);
  }
}
