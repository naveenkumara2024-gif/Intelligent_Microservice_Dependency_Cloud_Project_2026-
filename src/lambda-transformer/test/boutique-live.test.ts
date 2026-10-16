// Edge derivation against spans captured VERBATIM from the live Online Boutique (v0.10.7) on
// 2026-10-12 (test/fixtures/boutique-live-spans.json). The synthetic fixtures used before Stage 8b
// assumed hostnames in `server.address`; the real services put the callee's ClusterIP there and
// carry the callee in the gRPC method, which is why every real span was silently dropped
// (`"spans":443,"calls":0` in production logs).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { aggregate } from '../src/aggregate';
import { deriveCall } from '../src/edges';
import { parseTraces } from '../src/otlp';

interface CapturedSpan {
  label: string;
  service: string;
  span: Record<string, unknown>;
}

const captured: CapturedSpan[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'boutique-live-spans.json'), 'utf8'),
).spans;

const callFor = (label: string) => {
  const c = captured.find((s) => s.label === label);
  if (!c) throw new Error(`fixture is missing ${label}`);
  // exactly what the collector's kafka exporter writes: one ExportTraceServiceRequest per record
  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: c.service } }] },
        scopeSpans: [{ spans: [{ traceId: 'a', spanId: 'b', ...c.span }] }],
      },
    ],
  });
  const parsed = parseTraces(body);
  expect(parsed.spans).toHaveLength(1);
  return deriveCall(parsed.spans[0]);
};

describe('live Online Boutique spans', () => {
  test('the fixture really contains the shapes this test is about', () => {
    expect(captured.map((c) => c.label).sort()).toEqual([
      'client-otlp-export',
      'go-client-charge',
      'go-client-convert',
      'go-client-getproduct',
      'python-client-listproducts',
      'server-health-check',
    ]);
  });

  test('Go client: the callee is the gRPC service in rpc.method, NOT the ClusterIP in server.address', () => {
    const c = captured.find((s) => s.label === 'go-client-getproduct')!;
    const attrs = JSON.stringify(c.span.attributes);
    expect(attrs).toMatch(/172\.20\.\d+\.\d+/); // the address really is a bare ClusterIP
    expect(callFor('go-client-getproduct')).toMatchObject({ caller: 'frontend', callee: 'productcatalogservice' });
  });

  test('Go client: a second service and method', () => {
    expect(callFor('go-client-charge')).toMatchObject({ caller: 'checkoutservice', callee: 'paymentservice' });
    expect(callFor('go-client-convert')).toMatchObject({ caller: 'frontend', callee: 'currencyservice' });
  });

  test('Python client: the callee comes from rpc.service, with rpc.method a bare method name', () => {
    expect(callFor('python-client-listproducts')).toMatchObject({
      caller: 'recommendationservice',
      callee: 'productcatalogservice',
    });
  });

  test("a service's own telemetry export is infrastructure, not a dependency", () => {
    expect(callFor('client-otlp-export')).toBeUndefined();
  });

  test('kubelet health checks are SERVER spans and never become edges', () => {
    expect(callFor('server-health-check')).toBeUndefined();
  });

  test('aggregating the captured business spans yields the real call graph', () => {
    const calls = ['go-client-getproduct', 'go-client-charge', 'go-client-convert', 'python-client-listproducts']
      .map(callFor)
      .filter((c): c is NonNullable<typeof c> => !!c);
    const agg = aggregate(calls);
    expect(agg.edges.map((e) => `${e.caller}>${e.callee}`).sort()).toEqual([
      'checkoutservice>paymentservice',
      'frontend>currencyservice',
      'frontend>productcatalogservice',
      'recommendationservice>productcatalogservice',
    ]);
    // every callee became a node even though paymentservice etc. report nothing themselves
    expect(agg.nodes.map((n) => n.name)).toEqual(
      expect.arrayContaining(['paymentservice', 'currencyservice', 'productcatalogservice']),
    );
  });
});
