// POSTs a JSON body to a webhook-style endpoint.
//
// Error messages deliberately never contain the URL: a Slack webhook URL is the credential, and
// Lambda logs are not the place for it. They carry the status and the start of the response body.
import { HTTP_TIMEOUT_MS } from './config';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export class WebhookError extends Error {
  constructor(
    readonly channel: string,
    readonly status: number | undefined,
    detail: string,
  ) {
    super(`${channel} request failed${status !== undefined ? ` with HTTP ${status}` : ''}: ${detail}`);
    this.name = 'WebhookError';
  }
}

export interface PostOptions {
  channel: string;
  /** Statuses that mean "delivered". Slack answers 200, PagerDuty 202. */
  okStatuses: number[];
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export async function postJson(url: string, body: unknown, options: PostOptions): Promise<number> {
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
  let res: { status: number; text(): Promise<string> };
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? HTTP_TIMEOUT_MS),
    });
  } catch (err) {
    // Network errors from undici can embed the URL in the message; report only the error class.
    const kind = (err as Error)?.name === 'TimeoutError' ? 'timeout' : ((err as Error)?.name ?? 'error');
    throw new WebhookError(options.channel, undefined, kind);
  }
  if (!options.okStatuses.includes(res.status)) {
    let detail = '';
    try {
      detail = (await res.text()).replace(/\s+/g, ' ').slice(0, 200);
    } catch {
      /* the status is the useful part */
    }
    throw new WebhookError(options.channel, res.status, detail || 'no response body');
  }
  return res.status;
}
