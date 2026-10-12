import { handler, readConfig, validateLoad } from '../src/probe';

describe('readConfig', () => {
  test('derives the HTTPS status URL from the Gremlin URL', () => {
    expect(readConfig({ GREMLIN_URL: 'wss://n.example:8182/gremlin', AWS_REGION: 'us-east-1' } as any)).toEqual({
      gremlinUrl: 'wss://n.example:8182/gremlin',
      statusUrl: 'https://n.example:8182/status',
      region: 'us-east-1',
    });
  });

  test('refuses to run without a database URL', () => {
    expect(() => readConfig({} as any)).toThrow(/GREMLIN_URL/);
  });
});

describe('validateLoad', () => {
  const node = { name: 'svc-a', total_calls_as_um: 3, total_calls_as_dm: 4 };
  const edge = { um: 'svc-a', dm: 'svc-b', call_count: 10, avg_latency_ms: 1.5, p95_latency_ms: 4, rpctype: 'rpc' };

  test('accepts well-formed Stage 2 rows', () => {
    expect(validateLoad({ nodes: [node], edges: [edge] })).toEqual({ nodes: [node], edges: [edge] });
  });

  test('an empty payload is valid and does nothing', () => {
    expect(validateLoad({})).toEqual({ nodes: [], edges: [] });
  });

  test.each([
    ['empty name', { nodes: [{ ...node, name: '' }] }],
    ['non-numeric counter', { nodes: [{ ...node, total_calls_as_um: 'x' }] }],
    ['NaN latency', { edges: [{ ...edge, avg_latency_ms: NaN }] }],
    ['missing rpctype', { edges: [{ ...edge, rpctype: undefined }] }],
    ['missing callee', { edges: [{ ...edge, dm: '' }] }],
    ['not arrays', { nodes: 'nope' }],
  ])('rejects %s', (_label, payload) => {
    expect(() => validateLoad(payload as any)).toThrow();
  });
});

describe('handler', () => {
  test('rejects an unknown action', async () => {
    process.env.GREMLIN_URL = 'wss://n.example:8182/gremlin';
    await expect(handler({ action: 'drop-everything' } as any)).rejects.toThrow(/Unknown probe action/);
  });
});
