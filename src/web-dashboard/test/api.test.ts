import { describe, expect, test, vi } from 'vitest';
import { ApiError, freshness, getJson, loadIncidents, loadTopology, STALE_AFTER_INTERVALS, type FetchLike } from '../src/api';
import { incidentsGolden, topologyGolden } from './fixtures';

const reply = (status: number, body: unknown): FetchLike =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

describe('getJson', () => {
  test('returns the parsed body on success', async () => {
    expect(await getJson('/api/health', undefined, reply(200, { status: 'ok' }))).toEqual({ status: 'ok' });
  });

  test('turns an API error body into the message, keeping the status', async () => {
    const err = (await getJson('/api/topology', undefined, reply(503, { error: 'graph backend not configured' })).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.message).toBe('graph backend not configured');
  });

  test('a body that is not JSON is an error with the status, not a crash', async () => {
    const f: FetchLike = async () => ({ ok: false, status: 502, json: async () => Promise.reject(new SyntaxError('x')) });
    const err = (await getJson('/api/x', undefined, f).catch((e) => e)) as ApiError;
    expect(err.status).toBe(502);
    expect(err.message).toContain('unexpected response');
  });

  test('a network failure is an ApiError without a status', async () => {
    const f: FetchLike = async () => Promise.reject(new TypeError('Failed to fetch'));
    const err = (await getJson('/api/x', undefined, f).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBeUndefined();
    expect(err.message).toBe('the API is unreachable');
  });

  test('an abort is rethrown as-is so a cancelled poll is not shown as an outage', async () => {
    const f: FetchLike = async () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const err = (await getJson('/api/x', undefined, f).catch((e) => e)) as Error;
    expect(err).not.toBeInstanceOf(ApiError);
    expect(err.name).toBe('AbortError');
  });
});

describe('loaders', () => {
  test('topology accepts schema v1 and rejects another version', async () => {
    expect((await loadTopology(undefined, reply(200, topologyGolden))).nodes).toHaveLength(topologyGolden.nodes.length);
    const err = (await loadTopology(undefined, reply(200, { ...topologyGolden, schema_version: 2 })).catch((e) => e)) as ApiError;
    expect(err.message).toContain('unsupported topology schema_version 2');
  });

  test('incidents asks for the right status and limit', async () => {
    const f = reply(200, incidentsGolden);
    const list = await loadIncidents('OPEN', 25, undefined, f);
    expect(list).toHaveLength(incidentsGolden.incidents.length);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('/api/incidents?status=OPEN&limit=25');
  });
});

describe('freshness', () => {
  const INTERVAL = 10_000;
  const now = 1_000_000;

  test('no data yet is loading; fresh data is live', () => {
    expect(freshness({ hasData: false }, now, INTERVAL)).toBe('loading');
    expect(freshness({ hasData: true, updatedAtMs: now - 4000 }, now, INTERVAL)).toBe('live');
  });

  test('data older than a few intervals is stale', () => {
    expect(freshness({ hasData: true, updatedAtMs: now - STALE_AFTER_INTERVALS * INTERVAL - 1 }, now, INTERVAL)).toBe('stale');
    expect(freshness({ hasData: true, updatedAtMs: now - STALE_AFTER_INTERVALS * INTERVAL }, now, INTERVAL)).toBe('live');
  });

  test('503 means not deployed here; every other error means unreachable, with or without old data', () => {
    expect(freshness({ hasData: false, error: new ApiError(503, 'graph backend not configured') }, now, INTERVAL)).toBe('unavailable');
    expect(freshness({ hasData: true, updatedAtMs: now, error: new ApiError(502, 'x') }, now, INTERVAL)).toBe('unreachable');
    expect(freshness({ hasData: false, error: new ApiError(undefined, 'the API is unreachable') }, now, INTERVAL)).toBe('unreachable');
  });
});
