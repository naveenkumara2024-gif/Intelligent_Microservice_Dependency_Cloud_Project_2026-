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
    expect(calleeOf(span({ attrs: { 'rpc.service': 'hipstershop.CartService' } }))).toBeUndefined();
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
