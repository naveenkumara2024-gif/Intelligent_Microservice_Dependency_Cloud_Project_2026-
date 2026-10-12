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
// The exact names Online Boutique emits are unverified until a live capture (Stage 7b/8b).
const CALLEE_ATTRS = ['peer.service', 'server.address', 'net.peer.name', 'net.sock.peer.name'];
const URL_ATTRS = ['url.full', 'http.url'];

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

export function calleeOf(span: ParsedSpan): string | undefined {
  for (const key of [...CALLEE_ATTRS, ...URL_ATTRS]) {
    const v = span.attrs[key];
    if (v) {
      const host = normalizeHost(v);
      if (host) return host;
    }
  }
  return undefined;
}

export function deriveCall(span: ParsedSpan): Call | undefined {
  if (span.kind !== SPAN_KIND_CLIENT) return undefined;
  const callee = calleeOf(span);
  if (!callee) return undefined;
  return { caller: span.service.toLowerCase(), callee, latencyMs: span.durationMs, endMs: span.endMs };
}
