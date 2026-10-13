// Names shared by the alert Lambdas (runtime) and AlertingStack (infrastructure). Constants only,
// no imports, so the CDK app can import this without the AWS SDK; the stack test then pins what the
// code actually reads (same pattern as scorer/schema.ts).

export const ALERT_TOPIC_NAME = 'rca-alerts';
export const ALERT_DLQ_NAME = 'rca-alerts-dlq';

/**
 * SecureString parameters the operator creates by hand (CloudFormation cannot create a
 * SecureString). A missing parameter means "channel not configured": the notifier logs the
 * payload it would have sent and succeeds.
 */
export const SLACK_WEBHOOK_PARAM = '/rca/alerts/slack-webhook-url';
export const PAGERDUTY_ROUTING_KEY_PARAM = '/rca/alerts/pagerduty-routing-key';

/** Bundle `dist/alerts.js` exports these three handlers. */
export const ALERTS_BUNDLE = 'alerts.js';
export const HANDLER_DISPATCH = 'alerts.dispatch';
export const HANDLER_SLACK = 'alerts.slack';
export const HANDLER_PAGERDUTY = 'alerts.pagerduty';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';
