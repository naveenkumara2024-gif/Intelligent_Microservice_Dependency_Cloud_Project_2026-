// Stage 6b checkpoint: confirms nodes, Online Boutique pods, the collector
// DaemonSet, and that spans from several services reach the collector.
// Read-only. Exits non-zero if any check fails.
import { Check, kubectl, kubectlJson, pinEksContext, report } from './aws-cli';

interface Node {
  metadata: { labels?: Record<string, string> };
  status: { conditions: { type: string; status: string }[] };
}
interface Pod {
  metadata: { name: string };
  status: { phase: string; containerStatuses?: { ready: boolean }[] };
}
interface DaemonSet {
  status: { desiredNumberScheduled: number; numberReady: number };
}

// The only services upstream Online Boutique v0.10.7 instruments with OpenTelemetry.
const TRACING_SERVICES = [
  'frontend', 'checkoutservice', 'currencyservice', 'emailservice',
  'paymentservice', 'productcatalogservice', 'recommendationservice',
];
const MIN_SERVICES_SEEN = 4;

const cluster = pinEksContext();
if (!cluster.name) {
  console.log(`FAIL  EKS cluster: ${cluster.error}`);
  process.exit(1);
}

const checks: Check[] = [];

const nodes = kubectlJson<{ items: Node[] }>(['get', 'nodes']);
const items = nodes.value?.items ?? [];
const ready = items.filter((n) => n.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'));
const zones = new Set(items.map((n) => n.metadata.labels?.['topology.kubernetes.io/zone']));
checks.push({
  name: 'Nodes',
  ok: ready.length >= 2 && zones.size === 2,
  detail: nodes.error ?? `${ready.length}/${items.length} Ready across zones ${[...zones].join(', ')}`,
});

const pods = kubectlJson<{ items: Pod[] }>(['get', 'pods', '-n', 'default']);
const podItems = pods.value?.items ?? [];
const notReady = podItems.filter(
  (p) => p.status.phase !== 'Running' || !(p.status.containerStatuses ?? []).every((c) => c.ready),
);
checks.push({
  name: 'Online Boutique pods',
  ok: podItems.length >= 12 && notReady.length === 0,
  detail: pods.error ??
    (notReady.length === 0
      ? `${podItems.length} pods Running and Ready`
      : `not ready: ${notReady.map((p) => p.metadata.name).join(', ')}`),
});

const ds = kubectlJson<DaemonSet>(['get', 'daemonset', 'otel-collector', '-n', 'observability']);
const s = ds.value?.status;
checks.push({
  name: 'OTel Collector DaemonSet',
  ok: !!s && s.desiredNumberScheduled >= 2 && s.numberReady === s.desiredNumberScheduled,
  detail: ds.error ?? `${s?.numberReady}/${s?.desiredNumberScheduled} pods ready`,
});

// The debug exporter prints `service.name: Str(<name>)` per sampled resource.
const logs = kubectl([
  'logs', '-n', 'observability', '-l', 'app=otel-collector', '--tail=5000', '--max-log-requests=10',
]);
const seen = new Set([...logs.stdout.matchAll(/service\.name: Str\(([^)]+)\)/g)].map((m) => m[1]));
const missing = TRACING_SERVICES.filter((svc) => !seen.has(svc));
checks.push({
  name: 'Spans reaching the collector',
  ok: logs.ok && TRACING_SERVICES.filter((svc) => seen.has(svc)).length >= MIN_SERVICES_SEEN,
  detail: logs.ok
    ? `seen: ${[...seen].sort().join(', ') || '(none)'}${missing.length ? ` | not yet seen: ${missing.join(', ')}` : ''}`
    : logs.stderr,
});

process.exit(report(checks) ? 0 : 1);
