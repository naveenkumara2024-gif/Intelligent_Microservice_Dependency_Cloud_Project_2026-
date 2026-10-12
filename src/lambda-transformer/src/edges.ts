// Derives a service-to-service call from a single CLIENT span, statelessly: the caller is the
// reporting service, the callee comes from the span's peer attributes, and the latency is the
// span duration. Using only CLIENT spans means each Kafka record is self-contained (no
// parent/child join across records), and callees that emit no spans still become nodes.
import { ParsedSpan, SPAN_KIND_CLIENT } from './otlp';

export interface Call {
  caller: string;
  callee: string;
  latencyMs: number;
  endMs: number;
}

// Tried in order. Newer semantic conventions use `server.address`; older ones `net.peer.name`.
const CALLEE_ATTRS = ['peer.service', 'server.address', 'net.peer.name', 'net.sock.peer.name'];
const URL_ATTRS = ['url.full', 'http.url'];

// What the live Online Boutique (v0.10.7) actually emits, captured in Stage 8b: the callee of a
// service-to-service gRPC call is NOT a hostname. `server.address` is the callee's bare ClusterIP
// (e.g. 172.20.11.140), so the callee's identity is the gRPC service in the RPC attributes:
//   Go services  : rpc.method = "hipstershop.ProductCatalogService/GetProduct"   (no rpc.service)
//   Python       : rpc.service = "hipstershop.ProductCatalogService", rpc.method = "ListProducts"
// The deployment/service name is the lower-cased gRPC service name (productcatalogservice), which
// is a property of Online Boutique, not of gRPC in general; peer.service and a real hostname win
// when present.
//
// Infrastructure RPCs must not become edges: every service's exporter is itself instrumented
// (opentelemetry.proto.collector.trace.v1.TraceService/Export to the collector) and the kubelet
// health-checks every pod (grpc.health.v1.Health/Check).
const INFRA_RPC_PREFIXES = ['grpc.health.', 'grpc.reflection.', 'opentelemetry.proto.'];

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** "productcatalogservice:3550" -> "productcatalogservice"; k8s DNS names keep only the service label. */
export function normalizeHost(raw: string): string | undefined {
  let host = raw.trim();
  if (!host) return undefined;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme
  host = host.split('/')[0].split('?')[0]; // path / query
  host = host.replace(/:\d+$/, ''); // port
  if (!host || IPV4.test(host) || host.startsWith('[')) return undefined; // a bare IP is not a service name
  const svcIdx = host.indexOf('.svc');
  if (svcIdx > 0) host = host.slice(0, svcIdx).split('.')[0]; // name.namespace.svc.cluster.local -> name
  return host.toLowerCase();
}

/** "hipstershop.ProductCatalogService" (or a full method "pkg.Svc/Method") -> the gRPC service, qualified. */
export function grpcServiceOf(span: ParsedSpan): string | undefined {
  const service = span.attrs['rpc.service'];
  if (service) return service.replace(/^\//, '');
  const method = span.attrs['rpc.method'];
  if (method && method.includes('/')) return method.replace(/^\//, '').split('/')[0] || undefined;
  return undefined;
}

/** "hipstershop.ProductCatalogService" -> "productcatalogservice". */
function shortServiceName(qualified: string): string | undefined {
  const last = qualified.split('.').pop()?.trim();
  return last ? last.toLowerCase() : undefined;
}

export function calleeOf(span: ParsedSpan): string | undefined {
  const rpc = grpcServiceOf(span);
  if (rpc && INFRA_RPC_PREFIXES.some((prefix) => rpc.startsWith(prefix))) return undefined;

  for (const key of [...CALLEE_ATTRS, ...URL_ATTRS]) {
    const v = span.attrs[key];
    if (v) {
      const host = normalizeHost(v); // a bare IP is rejected here
      if (host) return host;
    }
  }
  return rpc ? shortServiceName(rpc) : undefined;
}

export function deriveCall(span: ParsedSpan): Call | undefined {
  if (span.kind !== SPAN_KIND_CLIENT) return undefined;
  const callee = calleeOf(span);
  if (!callee) return undefined;
  return { caller: span.service.toLowerCase(), callee, latencyMs: span.durationMs, endMs: span.endMs };
}
