import { parseTraces } from '../src/otlp';
import { clientCall, traceMessage } from './fixtures';

describe('parseTraces', () => {
  test('extracts service, kind, duration, end time and attributes', () => {
    const { spans, skipped } = parseTraces(
      traceMessage('frontend', [{ kind: 3, durationMs: 12.5, endMs: 1_700_000_000_123, attrs: { 'server.address': 'cartservice:7070', 'rpc.system': 'grpc' } }]),
    );
    expect(skipped).toBe(0);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ service: 'frontend', kind: 3, endMs: 1_700_000_000_123 });
    expect(spans[0].durationMs).toBeCloseTo(12.5, 3);
    expect(spans[0].attrs).toEqual({ 'server.address': 'cartservice:7070', 'rpc.system': 'grpc' });
  });

  test('keeps nanosecond precision beyond 2^53 (BigInt)', () => {
    const { spans } = parseTraces(traceMessage('frontend', [{ durationMs: 0.25, endMs: 1_700_000_000_999 }]));
    expect(spans[0].durationMs).toBeCloseTo(0.25, 3);
    expect(spans[0].endMs).toBe(1_700_000_000_999);
  });

  test('accepts the kind as an integer or as a SPAN_KIND_* name', () => {
    const msg = traceMessage('a', [{ kind: 3 }, { kind: 'SPAN_KIND_CLIENT' }, { kind: 'SPAN_KIND_SERVER' }, { kind: 2 }]);
    expect(parseTraces(msg).spans.map((s) => s.kind)).toEqual([3, 3, 2, 2]);
  });

  test('reads integer attribute values as strings', () => {
    const { spans } = parseTraces(traceMessage('a', [{ attrs: { 'server.port': 3550 } }]));
    expect(spans[0].attrs['server.port']).toBe('3550');
  });

  test('skips spans from a resource without service.name', () => {
    const { spans, skipped } = parseTraces(traceMessage(undefined, [clientCall('cartservice'), clientCall('x')]));
    expect(spans).toHaveLength(0);
    expect(skipped).toBe(2);
  });

  test('skips spans with missing, non-numeric or inverted timestamps, and keeps the good ones', () => {
    const good = JSON.parse(traceMessage('frontend', [clientCall('cartservice')]));
    const spans = good.resourceSpans[0].scopeSpans[0].spans;
    spans.push({ ...spans[0], startTimeUnixNano: undefined });
    spans.push({ ...spans[0], endTimeUnixNano: 'abc' });
    spans.push({ ...spans[0], startTimeUnixNano: '200', endTimeUnixNano: '100' });
    const result = parseTraces(JSON.stringify(good));
    expect(result.spans).toHaveLength(1);
    expect(result.skipped).toBe(3);
  });

  test.each(['', 'not json', '{', 'null', '[]', '{"resourceSpans": "nope"}', '{"resourceSpans":[{}]}'])(
    'never throws on malformed input %p',
    (input) => {
      expect(() => parseTraces(input)).not.toThrow();
      expect(parseTraces(input).spans).toEqual([]);
    },
  );
});
