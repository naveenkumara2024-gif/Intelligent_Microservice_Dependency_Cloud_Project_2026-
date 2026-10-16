import { errorBody, internalError, json, lowerCaseHeaders, methodOf, ORIGIN_HEADER, originAllowed } from '../src/api/http';

describe('json', () => {
  test('a cacheable 200 carries a public max-age', () => {
    const res = json(200, { a: 1 }, { cacheSeconds: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=10');
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(JSON.parse(res.body)).toEqual({ a: 1 });
  });

  test('errors and uncached data are never cacheable, even if a ttl is passed', () => {
    expect(json(200, {}).headers['cache-control']).toBe('no-store');
    expect(json(503, {}, { cacheSeconds: 10 }).headers['cache-control']).toBe('no-store');
    expect(errorBody(403, 'forbidden').headers['cache-control']).toBe('no-store');
    expect(JSON.parse(errorBody(400, 'bad').body)).toEqual({ error: 'bad' });
  });
});

describe('originAllowed (the only thing keeping the raw API URL from being a second public door)', () => {
  const secret = 's3cr3t-value';

  test('accepts the exact value', () => {
    expect(originAllowed({ [ORIGIN_HEADER]: secret }, secret)).toBe(true);
  });

  test('rejects a missing, empty, wrong, or differently-sized value', () => {
    expect(originAllowed({}, secret)).toBe(false);
    expect(originAllowed(undefined, secret)).toBe(false);
    expect(originAllowed({ [ORIGIN_HEADER]: '' }, secret)).toBe(false);
    expect(originAllowed({ [ORIGIN_HEADER]: 's3cr3t-valuf' }, secret)).toBe(false);
    expect(originAllowed({ [ORIGIN_HEADER]: 'short' }, secret)).toBe(false);
    expect(originAllowed({ [ORIGIN_HEADER]: secret + 'x' }, secret)).toBe(false);
  });

  test('fails closed when no secret is configured, even for a request that sends nothing or something', () => {
    expect(originAllowed({ [ORIGIN_HEADER]: '' }, undefined)).toBe(false);
    expect(originAllowed({ [ORIGIN_HEADER]: 'anything' }, undefined)).toBe(false);
    expect(originAllowed({}, '')).toBe(false);
  });

  test('header names are matched case-insensitively once lower-cased', () => {
    expect(originAllowed(lowerCaseHeaders({ 'X-RCA-Origin': secret }), secret)).toBe(true);
  });
});

describe('request helpers', () => {
  test('method defaults to GET and is upper-cased', () => {
    expect(methodOf({})).toBe('GET');
    expect(methodOf({ requestContext: { http: { method: 'post' } } })).toBe('POST');
  });

  test('internal errors answer generically and log the detail once', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = internalError('x', new Error('AccessDenied: arn:aws:dynamodb:us-east-1:123456789012:table/rca-incidents\nstack...'));
    expect(res.statusCode).toBe(502);
    expect(res.body).toBe('{"error":"upstream data store unavailable"}');
    expect(res.body).not.toContain('arn:');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('AccessDenied');
    expect(String(spy.mock.calls[0][0])).not.toContain('stack...');
    spy.mockRestore();
  });
});
