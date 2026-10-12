// Stage 9 verification probe: a short-lived Lambda that runs inside the VPC so the workstation can
// check Neptune, which has no public endpoint by design. Deployed with NeptuneStack and destroyed
// with it. Invoked by infra-cdk/scripts/verify-neptune.ts, one action per invocation.
import https from 'node:https';
import gremlin from 'gremlin';
import {
  Check,
  clearGraph,
  concurrencyTest,
  graphStats,
  GraphStats,
  LoadEdge,
  LoadNode,
  loadGraph,
  smokeTest,
} from './probe-actions';
import { credentialsFromEnv, signGetHeaders } from './writers/sigv4';
import { GremlinWriter } from './writers/gremlin';

const { DriverRemoteConnection } = gremlin.driver;
const { traversal } = gremlin.process.AnonymousTraversalSource;

export type ProbeEvent =
  | { action: 'status' }
  | { action: 'unsigned' }
  | { action: 'smoke' }
  | { action: 'concurrency'; writers?: number }
  | { action: 'load'; nodes?: LoadNode[]; edges?: LoadEdge[] }
  | { action: 'stats' }
  | { action: 'clear' };

export interface ProbeResult {
  action: string;
  ok: boolean;
  checks?: Check[];
  stats?: GraphStats;
  detail?: unknown;
}

interface Config {
  gremlinUrl: string;
  statusUrl: string;
  region: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gremlinUrl = env.GREMLIN_URL;
  if (!gremlinUrl) throw new Error('GREMLIN_URL is not set');
  const url = new URL(gremlinUrl);
  return {
    gremlinUrl,
    statusUrl: `https://${url.host}/status`,
    region: env.AWS_REGION ?? 'us-east-1',
  };
}

/** Validates a payload from the caller; the probe writes to the database, so reject anything malformed. */
export function validateLoad(event: { nodes?: unknown; edges?: unknown }): { nodes: LoadNode[]; edges: LoadEdge[] } {
  const nodes = (event.nodes ?? []) as LoadNode[];
  const edges = (event.edges ?? []) as LoadEdge[];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('nodes and edges must be arrays');
  for (const n of nodes) {
    if (typeof n?.name !== 'string' || !n.name || !Number.isFinite(n.total_calls_as_um) || !Number.isFinite(n.total_calls_as_dm)) {
      throw new Error(`invalid node row: ${JSON.stringify(n)}`);
    }
  }
  for (const e of edges) {
    if (
      typeof e?.um !== 'string' || typeof e.dm !== 'string' || !e.um || !e.dm ||
      !Number.isFinite(e.call_count) || !Number.isFinite(e.avg_latency_ms) || !Number.isFinite(e.p95_latency_ms) ||
      typeof e.rpctype !== 'string'
    ) {
      throw new Error(`invalid edge row: ${JSON.stringify(e)}`);
    }
  }
  return { nodes, edges };
}

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15_000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

async function signedWriter(config: Config): Promise<GremlinWriter> {
  return new GremlinWriter({ url: config.gremlinUrl, iamAuth: true, region: config.region });
}

async function status(config: Config): Promise<ProbeResult> {
  const credentials = await credentialsFromEnv();
  const headers = await signGetHeaders({ url: config.statusUrl, region: config.region, credentials });
  const res = await httpsGet(config.statusUrl, headers);
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // keep the raw text
  }
  const healthy = res.status === 200 && body?.status === 'healthy';

  // Also a trivial query over a signed WebSocket, which is the path the transformer uses.
  const writer = await signedWriter(config);
  let queryOk = false;
  let queryDetail = '';
  try {
    const g = await writer.connectedSource();
    const count = await g.V().limit(1).count().next();
    queryOk = true;
    queryDetail = `signed websocket query ok (count=${count.value})`;
  } catch (err) {
    queryDetail = `signed websocket query failed: ${(err as Error).message}`;
  } finally {
    await writer.close();
  }
  return {
    action: 'status',
    ok: healthy && queryOk,
    checks: [
      { name: 'signed /status', ok: healthy, detail: `HTTP ${res.status} ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify({ status: body?.status, dbEngineVersion: body?.dbEngineVersion })}` },
      { name: 'signed Gremlin websocket', ok: queryOk, detail: queryDetail },
    ],
  };
}

/** Proves IAM authentication is enforced: the same requests without signed headers must be refused. */
async function unsigned(config: Config): Promise<ProbeResult> {
  const checks: Check[] = [];

  try {
    const res = await httpsGet(config.statusUrl, {});
    checks.push({ name: 'unsigned /status is refused', ok: res.status === 401 || res.status === 403, detail: `HTTP ${res.status}` });
  } catch (err) {
    checks.push({ name: 'unsigned /status is refused', ok: false, detail: `request error (not an auth refusal): ${(err as Error).message}` });
  }

  const connection = new DriverRemoteConnection(config.gremlinUrl, {});
  try {
    await traversal().withRemote(connection).V().limit(1).count().next();
    checks.push({ name: 'unsigned Gremlin websocket is refused', ok: false, detail: 'query SUCCEEDED without credentials' });
  } catch (err) {
    const message = (err as Error).message;
    checks.push({ name: 'unsigned Gremlin websocket is refused', ok: /40[13]|forbidden|unauthori[sz]ed/i.test(message), detail: message.slice(0, 200) });
  } finally {
    await connection.close().catch(() => undefined);
  }
  return { action: 'unsigned', ok: checks.every((c) => c.ok), checks };
}

export async function handler(event: ProbeEvent): Promise<ProbeResult> {
  const config = readConfig();
  switch (event.action) {
    case 'status':
      return status(config);
    case 'unsigned':
      return unsigned(config);
    case 'smoke':
    case 'concurrency':
    case 'load':
    case 'stats':
    case 'clear': {
      const writer = await signedWriter(config);
      try {
        const g = await writer.connectedSource();
        if (event.action === 'smoke') {
          const checks = await smokeTest(writer, g);
          return { action: 'smoke', ok: checks.every((c) => c.ok || c.informational), checks };
        }
        if (event.action === 'concurrency') {
          const writers = Math.min(Math.max(event.writers ?? 8, 2), 16);
          const checks = await concurrencyTest(() => new GremlinWriter({ url: config.gremlinUrl, iamAuth: true, region: config.region }), g, writers);
          return { action: 'concurrency', ok: checks.every((c) => c.ok || c.informational), checks };
        }
        if (event.action === 'load') {
          const { nodes, edges } = validateLoad(event);
          return { action: 'load', ok: true, detail: await loadGraph(g, nodes, edges) };
        }
        if (event.action === 'stats') {
          return { action: 'stats', ok: true, stats: await graphStats(g) };
        }
        return { action: 'clear', ok: true, detail: { dropped: await clearGraph(g) } };
      } finally {
        await writer.close();
      }
    }
    default:
      throw new Error(`Unknown probe action: ${JSON.stringify(event)}`);
  }
}
