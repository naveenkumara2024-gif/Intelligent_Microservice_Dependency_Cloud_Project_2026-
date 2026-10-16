// Client for the Stage 10 SageMaker serverless endpoint (contract: src/ml-engine/inference.py).
import { InvokeEndpointCommand, SageMakerRuntimeClient } from '@aws-sdk/client-sagemaker-runtime';
import { ScoreClient } from './run';
import { ScoreRequest, ScoreResponse } from './types';

/** A cold serverless start measured 13.7 s; leave room for it, and for the graph read, inside 60 s. */
const DEFAULT_TIMEOUT_MS = 30_000;

export class SageMakerScoreClient implements ScoreClient {
  constructor(
    private readonly client: SageMakerRuntimeClient,
    private readonly endpointName: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async score(request: ScoreRequest): Promise<ScoreResponse> {
    let body: Uint8Array | undefined;
    try {
      const res = await this.client.send(
        new InvokeEndpointCommand({
          EndpointName: this.endpointName,
          ContentType: 'application/json',
          Accept: 'application/json',
          Body: JSON.stringify(request),
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
      body = res.Body;
    } catch (err) {
      // The toolkit appends a Python traceback with container paths to a 4xx body (Stage 10 note):
      // keep the first line for the log and drop the rest.
      const message = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300);
      throw new Error(`endpoint ${this.endpointName} invocation failed: ${message}`);
    }
    if (!body) throw new Error(`endpoint ${this.endpointName} returned an empty body`);

    const parsed = JSON.parse(Buffer.from(body).toString('utf8')) as ScoreResponse;
    if (!Array.isArray(parsed.ranking) || typeof parsed.model_version !== 'string') {
      throw new Error(`endpoint ${this.endpointName} returned an unexpected shape`);
    }
    return parsed;
  }
}
