import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
// Key and index names are shared with the scorer's runtime code (constants only, no imports), so
// the tables the stack creates and the items the Lambda reads and writes cannot disagree.
import {
  GSI_BY_SERVICE,
  GSI_BY_STATUS,
  INCIDENTS_TABLE,
  INCIDENT_KEY,
  OPENED_AT_ATTR,
  ROOT_CAUSE_ATTR,
  STATE_KEY,
  STATE_TABLE,
  STATUS_ATTR,
  TTL_ATTR,
} from '../../src/lambda-transformer/src/scorer/schema';

/**
 * Stage 11: incident persistence.
 *
 * - `rca-incidents`: one item per incident (the dashboard's data). Partition key `incident_id`;
 *   `by-status` and `by-service` indexes sorted by `opened_at_ms`; TTL on `expires_at`.
 * - `rca-scorer-state`: a single item holding the scorer's counters, baselines and lifecycle
 *   trackers, guarded by an optimistic `version`.
 *
 * Both are on-demand, encrypted with a customer-managed key that lives in this stack (Stage 5
 * convention), and removed with it: an incident store that outlives its demo only costs money.
 * Point-in-time recovery is off on purpose (the same reasoning); it is one property to turn on.
 */
export class DynamodbStack extends cdk.Stack {
  public readonly incidentsTable: dynamodb.Table;
  public readonly stateTable: dynamodb.Table;
  public readonly key: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.key = new kms.Key(this, 'TableKey', {
      description: 'RCA incident and scorer-state tables',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const common = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    };

    this.incidentsTable = new dynamodb.Table(this, 'IncidentsTable', {
      ...common,
      tableName: INCIDENTS_TABLE,
      partitionKey: { name: INCIDENT_KEY, type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: TTL_ATTR,
    });
    // Newest first within a status ("open incidents", "recent resolved") or within one root cause.
    this.incidentsTable.addGlobalSecondaryIndex({
      indexName: GSI_BY_STATUS,
      partitionKey: { name: STATUS_ATTR, type: dynamodb.AttributeType.STRING },
      sortKey: { name: OPENED_AT_ATTR, type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.incidentsTable.addGlobalSecondaryIndex({
      indexName: GSI_BY_SERVICE,
      partitionKey: { name: ROOT_CAUSE_ATTR, type: dynamodb.AttributeType.STRING },
      sortKey: { name: OPENED_AT_ATTR, type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.stateTable = new dynamodb.Table(this, 'StateTable', {
      ...common,
      tableName: STATE_TABLE,
      partitionKey: { name: STATE_KEY, type: dynamodb.AttributeType.STRING },
    });

    new cdk.CfnOutput(this, 'IncidentsTableName', { value: this.incidentsTable.tableName });
    new cdk.CfnOutput(this, 'StateTableName', { value: this.stateTable.tableName });
    new cdk.CfnOutput(this, 'TableKeyArn', { value: this.key.keyArn });
  }
}
