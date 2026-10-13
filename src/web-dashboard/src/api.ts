// Typed access to the dashboard API (same-origin, relative URLs) and the polling state machine.
import type { Incident, IncidentList, TopologyResponse } from './types';

export class ApiError extends Error {
  constructor(
    /** HTTP status, or undefined for a network failure / unreadable response. */
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export async function getJson<T>(path: string, signal?: AbortSignal, fetchFn: FetchLike = fetch as FetchLike): Promise<T> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(path, { signal });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(undefined, 'the API is unreachable');
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ApiError(res.status, `unexpected response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const message = (body as { error?: unknown })?.error;
    throw new ApiError(res.status, typeof message === 'string' ? message : `request failed (HTTP ${res.status})`);
  }
  return body as T;
}

export async function loadTopology(signal?: AbortSignal, fetchFn?: FetchLike): Promise<TopologyResponse> {
  const t = await getJson<TopologyResponse>('/api/topology', signal, fetchFn);
  if (t.schema_version !== 1) throw new ApiError(undefined, `unsupported topology schema_version ${String(t.schema_version)}`);
  return t;
}

export async function loadIncidents(
  status: 'OPEN' | 'RESOLVED',
  limit: number,
  signal?: AbortSignal,
  fetchFn?: FetchLike,
): Promise<Incident[]> {
  const list = await getJson<IncidentList>(`/api/incidents?status=${status}&limit=${limit}`, signal, fetchFn);
  return list.incidents;
}

// --- what the connection chip and banner say ----------------------------------------------------

export type Freshness = 'loading' | 'live' | 'stale' | 'unavailable' | 'unreachable';

/** Data older than this many polling intervals is "stale" (a few missed polls, not one slow one). */
export const STALE_AFTER_INTERVALS = 3;

export interface FeedState {
  hasData: boolean;
  updatedAtMs?: number;
  error?: ApiError;
}

/**
 * 503 is the documented "this backend is not deployed" answer, not a failure of the dashboard;
 * anything else with an error is "unreachable". With data and no error, old data is "stale".
 */
export function freshness(feed: FeedState, nowMs: number, intervalMs: number): Freshness {
  if (feed.error) {
    if (feed.error.status === 503) return 'unavailable';
    return 'unreachable';
  }
  if (!feed.hasData || feed.updatedAtMs === undefined) return 'loading';
  return nowMs - feed.updatedAtMs > STALE_AFTER_INTERVALS * intervalMs ? 'stale' : 'live';
}
