import { calleeOf, deriveCall, normalizeHost } from '../src/edges';
import { ParsedSpan } from '../src/otlp';

const span = (over: Partial<ParsedSpan> = {}): ParsedSpan => ({
  service: 'frontend',
  kind: 3,
  durationMs: 5,
  endMs: 1000,
  attrs: { 'server.address': 'cartservice' },
  ...over,
});

describe('normalizeHost', () => {
  test.each([
    ['productcatalogservice:3550', 'productcatalogservice'],
    ['cartservice', 'cartservice'],
    ['CartService', 'cartservice'],
    ['http://paymentservice:50051/charge?x=1', 'paymentservice'],
    ['checkoutservice.default.svc.cluster.local', 'checkoutservice'],
    ['checkoutservice.default.svc.cluster.local:5050', 'checkoutservice'],
    ['  currencyservice  ', 'currencyservice'],
  ])('%p -> %p', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });

  test.each(['', '   ', '10.0.2.17', '10.0.2.17:3550', '[::1]:80', 'http://'])('rejects non-service %p', (input) => {
    expect(normalizeHost(input)).toBeUndefined();
  });
});

describe('calleeOf', () => {
  test('prefers peer.service, then server.address, then net.peer.name', () => {
    const attrs = { 'net.peer.name': 'c', 'server.address': 'b', 'peer.service': 'a' };
    expect(calleeOf(span({ attrs }))).toBe('a');
    expect(calleeOf(span({ attrs: { 'net.peer.name': 'c', 'server.address': 'b' } }))).toBe('b');
    expect(calleeOf(span({ attrs: { 'net.peer.name': 'c' } }))).toBe('c');
  });

  test('falls through an attribute that is only an IP to the next one', () => {
    expect(calleeOf(span({ attrs: { 'server.address': '10.0.2.5', 'net.peer.name': 'cartservice' } }))).toBe('cartservice');
  });

  test('falls back to the host of a URL attribute', () => {
    expect(calleeOf(span({ attrs: { 'http.url': 'http://shippingservice:50051/quote' } }))).toBe('shippingservice');
  });

  test('is undefined when no usable attribute exists', () => {
    expect(calleeOf(span({ attrs: {} }))).toBeUndefined();
    // Stage 8b: this used to be asserted undefined. Live Boutique (Python services) sends exactly
    // rpc.service + a bare rpc.method, and that IS the callee; see boutique-live.test.ts.
    expect(calleeOf(span({ attrs: { 'rpc.method': 'GetCart' } }))).toBeUndefined();
    expect(calleeOf(span({ attrs: { 'rpc.system': 'grpc' } }))).toBeUndefined();
  });
});

describe('deriveCall', () => {
  test('CLIENT span -> caller, callee, latency, end time', () => {
    expect(deriveCall(span({ durationMs: 7.5, endMs: 4242 }))).toEqual({
      caller: 'frontend',
      callee: 'cartservice',
      latencyMs: 7.5,
      endMs: 4242,
    });
  });

  test.each([0, 1, 2, 4, 5])('ignores span kind %p (only CLIENT spans define an edge)', (kind) => {
    expect(deriveCall(span({ kind }))).toBeUndefined();
  });

  test('ignores a CLIENT span with no resolvable callee', () => {
    expect(deriveCall(span({ attrs: {} }))).toBeUndefined();
  });

  test('lower-cases the caller so casing differences do not split a node', () => {
    expect(deriveCall(span({ service: 'FrontEnd' }))?.caller).toBe('frontend');
  });
});

describe('calleeOf: gRPC-aware derivation (Stage 8b, from live Boutique spans)', () => {
  const grpc = (attrs: Record<string, string>) => span({ attrs });

  test('an IP in server.address falls through to the gRPC service', () => {
    expect(calleeOf(grpc({ 'server.address': '172.20.11.140', 'rpc.method': 'hipstershop.CartService/GetCart' }))).toBe(
      'cartservice',
    );
  });

  test('rpc.service wins over a bare method name', () => {
    expect(calleeOf(grpc({ 'rpc.service': 'hipstershop.AdService', 'rpc.method': 'GetAds' }))).toBe('adservice');
  });

  test('a real hostname still wins over the RPC (more specific than the convention)', () => {
    expect(calleeOf(grpc({ 'server.address': 'legacy-billing', 'rpc.method': 'hipstershop.CartService/GetCart' }))).toBe(
      'legacy-billing',
    );
  });

  test('peer.service wins over everything', () => {
    expect(
      calleeOf(grpc({ 'peer.service': 'ledger', 'server.address': 'x', 'rpc.method': 'hipstershop.CartService/GetCart' })),
    ).toBe('ledger');
  });

  test.each([
    ['grpc.health.v1.Health/Check'],
    ['opentelemetry.proto.collector.trace.v1.TraceService/Export'],
    ['grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo'],
  ])('infrastructure RPC %p is never a dependency, even with a hostname address', (method) => {
    expect(calleeOf(grpc({ 'rpc.method': method, 'server.address': 'otel-collector.observability.svc' }))).toBeUndefined();
  });

  test('infrastructure RPC is detected from rpc.service too (the Python shape)', () => {
    expect(calleeOf(grpc({ 'rpc.service': 'grpc.health.v1.Health', 'rpc.method': 'Check' }))).toBeUndefined();
  });

  test('a bare method name with no service and no address yields nothing, not a guess', () => {
    expect(calleeOf(grpc({ 'rpc.method': 'ListProducts' }))).toBeUndefined();
  });
});
