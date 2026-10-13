// Table layout shared by the scorer (runtime) and DynamodbStack (infrastructure). This file is
// constants only and imports nothing, so the CDK app can import it without pulling in the AWS SDK
// or the Gremlin driver; the stack test then pins what the code actually reads and writes.

export const INCIDENTS_TABLE = 'rca-incidents';
export const STATE_TABLE = 'rca-scorer-state';

/** Incidents: partition key, GSIs, TTL attribute. */
export const INCIDENT_KEY = 'incident_id';
export const GSI_BY_STATUS = 'by-status';
export const GSI_BY_SERVICE = 'by-service';
export const STATUS_ATTR = 'status';
export const ROOT_CAUSE_ATTR = 'root_cause';
export const OPENED_AT_ATTR = 'opened_at_ms';
export const TTL_ATTR = 'expires_at';

/** Scorer state: a single item. */
export const STATE_KEY = 'pk';
export const STATE_KEY_VALUE = 'scorer';
export const STATE_VERSION_ATTR = 'version';
export const STATE_JSON_ATTR = 'state_json';

export const SCHEMA_VERSION = 1;
