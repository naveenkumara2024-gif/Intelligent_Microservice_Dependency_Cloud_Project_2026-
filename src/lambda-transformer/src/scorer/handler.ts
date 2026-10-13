// Stage 11 scorer Lambda: invoked once a minute by EventBridge, in the VPC. Bundled to
// dist/scorer.js (handler `scorer.handler`), next to the transformer's index.js and probe.js.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import { GremlinWriter } from '../writers/gremlin';
import { SageMakerScoreClient } from './endpoint';
import { GremlinGraphSource } from './graph';
import { CycleDeps, CycleSummary, runCycle } from './run';
import { DEFAULT_TABLES, documentClient, DynamoScorerStore } from './store';

export interface ScorerEnv {
  GREMLIN_URL?: string;
  NEPTUNE_IAM_AUTH?: string;
  ENDPOINT_NAME?: string;
  INCIDENTS_TABLE?: string;
  STATE_TABLE?: string;
}

let cached: CycleDeps | undefined;

/** Built once per execution environment: the Neptune connection and SDK clients are reused. */
export function buildDeps(env: ScorerEnv = process.env as ScorerEnv): CycleDeps {
  if (cached) return cached;
  if (!env.GREMLIN_URL) throw new Error('GREMLIN_URL is not set');
  if (!env.ENDPOINT_NAME) throw new Error('ENDPOINT_NAME is not set');

  const writer = new GremlinWriter({ url: env.GREMLIN_URL, iamAuth: env.NEPTUNE_IAM_AUTH !== 'false' });
  cached = {
    graph: new GremlinGraphSource(writer),
    scorer: new SageMakerScoreClient(new SageMakerRuntimeClient({}), env.ENDPOINT_NAME),
    store: new DynamoScorerStore(documentClient(new DynamoDBClient({})), {
      incidents: env.INCIDENTS_TABLE ?? DEFAULT_TABLES.incidents,
      state: env.STATE_TABLE ?? DEFAULT_TABLES.state,
    }),
    now: Date.now,
  };
  return cached;
}

/** Replaces the cached dependencies (tests). */
export function setDeps(deps: CycleDeps | undefined): void {
  cached = deps;
}

export async function handler(): Promise<CycleSummary> {
  const summary = await runCycle(buildDeps());
  // One compact line per run; CloudWatch Logs Insights can parse the JSON after the message.
  console.log(`scorer ${JSON.stringify(summary)}`);
  return summary;
}
