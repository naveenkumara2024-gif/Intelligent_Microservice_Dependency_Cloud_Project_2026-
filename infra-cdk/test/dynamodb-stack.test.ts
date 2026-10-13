import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DynamodbStack } from '../lib/dynamodb-stack';
import {
  GSI_BY_SERVICE,
  GSI_BY_STATUS,
  INCIDENTS_TABLE,
  INCIDENT_KEY,
  STATE_KEY,
  STATE_TABLE,
  TTL_ATTR,
} from '../../src/lambda-transformer/src/scorer/schema';

const app = new cdk.App();
const stack = new DynamodbStack(app, 'TestDynamodbStack', { env: { region: 'us-east-1' } });
const template = Template.fromStack(stack);

const table = (name: string) =>
  Object.values(template.findResources('AWS::DynamoDB::Table')).find((t) => t.Properties.TableName === name)!;

describe('DynamodbStack', () => {
  test('two tables: incidents and scorer state', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 2);
    expect(table(INCIDENTS_TABLE)).toBeDefined();
    expect(table(STATE_TABLE)).toBeDefined();
  });

  test('the table names are the ones the scorer code reads and writes', () => {
    expect([INCIDENTS_TABLE, STATE_TABLE]).toEqual(['rca-incidents', 'rca-scorer-state']);
  });

  test('incidents: keyed by incident_id, TTL on expires_at, on-demand', () => {
    const props = table(INCIDENTS_TABLE).Properties;
    expect(props.KeySchema).toEqual([{ AttributeName: INCIDENT_KEY, KeyType: 'HASH' }]);
    expect(props.TimeToLiveSpecification).toEqual({ AttributeName: TTL_ATTR, Enabled: true });
    expect(props.BillingMode).toBe('PAY_PER_REQUEST');
    expect(TTL_ATTR).toBe('expires_at');
  });

  test('incidents: by-status and by-service indexes, newest first by opened_at_ms, full projection', () => {
    const indexes = table(INCIDENTS_TABLE).Properties.GlobalSecondaryIndexes as any[];
    expect(indexes.map((i) => i.IndexName).sort()).toEqual([GSI_BY_SERVICE, GSI_BY_STATUS].sort());
    const byStatus = indexes.find((i) => i.IndexName === GSI_BY_STATUS);
    expect(byStatus.KeySchema).toEqual([
      { AttributeName: 'status', KeyType: 'HASH' },
      { AttributeName: 'opened_at_ms', KeyType: 'RANGE' },
    ]);
    const byService = indexes.find((i) => i.IndexName === GSI_BY_SERVICE);
    expect(byService.KeySchema).toEqual([
      { AttributeName: 'root_cause', KeyType: 'HASH' },
      { AttributeName: 'opened_at_ms', KeyType: 'RANGE' },
    ]);
    for (const i of indexes) expect(i.Projection).toEqual({ ProjectionType: 'ALL' });
    // opened_at_ms is the range key of both, so it must be declared a number
    const defs = table(INCIDENTS_TABLE).Properties.AttributeDefinitions as { AttributeName: string; AttributeType: string }[];
    expect(defs.find((d) => d.AttributeName === 'opened_at_ms')?.AttributeType).toBe('N');
  });

  test('incidents: a stream with both images (Stage 12 alerts on the OPEN -> RESOLVED pair)', () => {
    expect(table(INCIDENTS_TABLE).Properties.StreamSpecification).toEqual({ StreamViewType: 'NEW_AND_OLD_IMAGES' });
    // The state table is never streamed: it is rewritten every minute and nobody consumes it.
    expect(table(STATE_TABLE).Properties.StreamSpecification).toBeUndefined();
    template.hasOutput('IncidentsStreamArn', {});
  });

  test('state: single-item table keyed by pk, no TTL (it must never expire under the scorer)', () => {
    const props = table(STATE_TABLE).Properties;
    expect(props.KeySchema).toEqual([{ AttributeName: STATE_KEY, KeyType: 'HASH' }]);
    expect(props.TimeToLiveSpecification).toBeUndefined();
    expect(props.BillingMode).toBe('PAY_PER_REQUEST');
  });

  test('both tables are encrypted with the customer-managed key, which rotates', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    for (const name of [INCIDENTS_TABLE, STATE_TABLE]) {
      const sse = table(name).Properties.SSESpecification;
      expect(sse.SSEEnabled).toBe(true);
      expect(sse.SSEType).toBe('KMS');
      expect(sse.KMSMasterKeyId).toBeDefined();
    }
  });

  test('teardown leaves nothing behind: tables and key are deleted with the stack, no PITR', () => {
    for (const t of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(t.DeletionPolicy).toBe('Delete');
      expect(t.Properties.PointInTimeRecoverySpecification).toBeUndefined();
      expect(t.Properties.DeletionProtectionEnabled).not.toBe(true);
    }
    for (const k of Object.values(template.findResources('AWS::KMS::Key'))) expect(k.DeletionPolicy).toBe('Delete');
  });

  test('outputs the names the verify scripts read', () => {
    template.hasOutput('IncidentsTableName', {});
    template.hasOutput('StateTableName', {});
  });
});
