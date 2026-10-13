// HTTP plumbing for the dashboard API: response helpers, the origin-secret check, error mapping.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ORIGIN_HEADER } from './names';
import { HttpApiEvent, HttpApiResult } from './types';

export { ORIGIN_HEADER };

const BASE_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

export function json(statusCode: number, body: unknown, options: { cacheSeconds?: number } = {}): HttpApiResult {
  const cacheable = statusCode === 200 && (options.cacheSeconds ?? 0) > 0;
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      // Errors and uncached data must never be stored by CloudFront or the browser.
      'cache-control': cacheable ? `public, max-age=${options.cacheSeconds}` : 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export const errorBody = (status: number, message: string): HttpApiResult => json(status, { error: message });

/**
 * Constant-time check of the origin header against the deploy-time secret. Fails closed: with no
 * secret configured nothing is allowed (a missing env var must not become an open API).
 * Both sides are hashed first so the comparison is always over equal-length buffers.
 */
export function originAllowed(headers: HttpApiEvent['headers'], secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = headers?.[ORIGIN_HEADER] ?? headers?.[ORIGIN_HEADER.toUpperCase()];
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(presented), digest(secret));
}

/** HTTP API lower-cases header names; this keeps a hand-built test event honest too. */
export function lowerCaseHeaders(headers: HttpApiEvent['headers']): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

export function methodOf(event: HttpApiEvent): string {
  return (event.requestContext?.http?.method ?? 'GET').toUpperCase();
}

/** Logs the detail, answers with something safe: a stack or an ARN never leaves the Lambda. */
export function internalError(where: string, err: unknown): HttpApiResult {
  const message = String((err as Error)?.message ?? err).split('\n')[0].slice(0, 300);
  console.error(`api.error ${JSON.stringify({ where, error: message })}`);
  return errorBody(502, 'upstream data store unavailable');
}
