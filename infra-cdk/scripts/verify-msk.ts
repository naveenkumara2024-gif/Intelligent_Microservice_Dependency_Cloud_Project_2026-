// Stage 7b checkpoint: confirms MSK is up, the topics exist, the collector exports to it, and
// real span messages with several service names are readable from otel.traces.
// Creates only a short-lived consumer pod (deleted on exit). Exits non-zero on any failure.
import { spawnSync } from 'node:child_process';
import { awsJson, Check, kubectl, kubectlArgs, kubectlJson, mskInfo, pinEksContext, report } from './aws-cli';

// Same list as verify-eks: the only Online Boutique services instrumented upstream.
const TRACING_SERVICES = [
  'frontend', 'checkoutservice', 'currencyservice', 'emailservice',
  'paymentservice', 'productcatalogservice', 'recommendationservice',
];
const MIN_SERVICES_SEEN = 4;
const EXPECTED_TOPICS = ['otel.traces', 'otel.metrics', 'svc.events'];

const cluster = pinEksContext();
if (!cluster.name) {
  console.log(`FAIL  EKS cluster: ${cluster.error}`);
  process.exit(1);
}
const msk = mskInfo();
if (!msk.deployed || !msk.bootstrap || !msk.clusterArn) {
  console.log(`FAIL  MskStack: ${msk.error ?? 'not deployed -- run npm run deploy:msk first'}`);
  process.exit(1);
}

const checks: Check[] = [];

const described = awsJson<{
  ClusterInfo: { State: string; Provisioned?: { NumberOfBrokerNodes: number } };
}>(['kafka', 'describe-cluster-v2', '--cluster-arn', msk.clusterArn]);
const info = described.value?.ClusterInfo;
checks.push({
  name: 'MSK cluster',
  ok: info?.State === 'ACTIVE' && info.Provisioned?.NumberOfBrokerNodes === 2,
  detail: described.error ?? `${info?.State}, ${info?.Provisioned?.NumberOfBrokerNodes} brokers`,
});

const ds = kubectlJson<{ status: { desiredNumberScheduled: number; numberReady: number } }>([
  'get', 'daemonset', 'otel-collector', '-n', 'observability',
]);
const s = ds.value?.status;
checks.push({
  name: 'OTel Collector DaemonSet',
  ok: !!s && s.desiredNumberScheduled >= 2 && s.numberReady === s.desiredNumberScheduled,
  detail: ds.error ?? `${s?.numberReady}/${s?.desiredNumberScheduled} pods ready`,
});

const logs = kubectl(['logs', '-n', 'observability', '-l', 'app=otel-collector', '--tail=500', '--max-log-requests=10']);
const kafkaErrors = logs.stdout.split('\n').filter((l) => /kafka/i.test(l) && /(error|failed|fail to)/i.test(l));
checks.push({
  name: 'Collector Kafka exporter errors',
  ok: logs.ok && kafkaErrors.length === 0,
  detail: logs.ok ? (kafkaErrors.length === 0 ? 'none in recent logs' : kafkaErrors[0].slice(0, 200)) : logs.stderr,
});

// One throwaway pod lists the topics, then reads up to 200 span messages from the start.
const script = [
  'echo security.protocol=SSL > /tmp/c.properties',
  'echo ==TOPICS==',
  `/opt/kafka/bin/kafka-topics.sh --bootstrap-server '${msk.bootstrap}' --command-config /tmp/c.properties --list`,
  'echo ==MESSAGES==',
  `/opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server '${msk.bootstrap}' --consumer.config /tmp/c.properties --topic otel.traces --from-beginning --max-messages 200 --timeout-ms 60000`,
].join('\n');
const podName = `kafka-verify-${Date.now()}`;
const run = spawnSync(
  'kubectl',
  kubectlArgs([
    'run', podName, '-n', 'observability', '--image=apache/kafka:3.9.0', '--restart=Never',
    '--rm', '-i', '--quiet', '--command', '--', 'sh', '-c', script,
  ]),
  { encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 },
);
const out = run.stdout ?? '';
const [, afterTopics = ''] = out.split('==TOPICS==');
const [topicsPart, messagesPart = ''] = afterTopics.split('==MESSAGES==');
const topics = new Set(topicsPart.split('\n').map((l) => l.trim()).filter(Boolean));
const missingTopics = EXPECTED_TOPICS.filter((t) => !topics.has(t));
checks.push({
  name: 'Topics',
  ok: run.status === 0 && missingTopics.length === 0,
  detail: run.status === 0
    ? (missingTopics.length === 0 ? EXPECTED_TOPICS.join(', ') : `missing: ${missingTopics.join(', ')}`)
    : `consumer pod failed (exit ${run.status}): ${(run.stderr ?? '').trim().slice(0, 300)}`,
});

const messages = messagesPart.split('\n').filter((l) => l.startsWith('{'));
const seen = new Set(
  [...messagesPart.matchAll(/"key":"service\.name","value":\{"stringValue":"([^"]+)"\}/g)].map((m) => m[1]),
);
const missing = TRACING_SERVICES.filter((svc) => !seen.has(svc));
checks.push({
  name: 'Spans readable from otel.traces',
  ok: TRACING_SERVICES.filter((svc) => seen.has(svc)).length >= MIN_SERVICES_SEEN,
  detail: `${messages.length} messages; services: ${[...seen].sort().join(', ') || '(none)'}` +
    (missing.length ? ` | not yet seen: ${missing.join(', ')}` : ''),
});

process.exit(report(checks) ? 0 : 1);
