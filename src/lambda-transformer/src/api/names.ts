// Names shared by the dashboard API Lambdas (runtime) and FrontendStack (infrastructure). Constants
// only, no imports, so the CDK app can import this without the AWS SDK (same pattern as
// scorer/schema.ts and alerts/names.ts).

/** The header CloudFront injects on its `/api/*` origin; the Lambdas refuse requests without it. */
export const ORIGIN_HEADER = 'x-rca-origin';

/** Bundle `dist/api.js` exports these two handlers. */
export const API_BUNDLE = 'api.js';
export const HANDLER_INCIDENTS = 'api.incidents';
export const HANDLER_TOPOLOGY = 'api.topology';

/** HTTP API throttling: the account's Lambda concurrency limit is 10 and the scorer already uses it. */
export const API_RATE_LIMIT = 5;
export const API_BURST_LIMIT = 10;

/** How long CloudFront (and browsers) may reuse a topology response. */
export const TOPOLOGY_CACHE_SECONDS = 5;
