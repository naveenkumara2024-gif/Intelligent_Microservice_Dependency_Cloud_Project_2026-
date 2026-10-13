// Stage 13b checkpoint: the dashboard and its API, through the CloudFront URL (not the API URL).
//
//   npm run verify:dashboard                    DynamoDB-only tier (deploy:dynamodb + deploy:frontend)
//   npm run verify:dashboard -- --topology      graph tier (also deploy:vpc, deploy:neptune,
//                                               deploy:frontend -- -c topology=neptune; the graph
//                                               must already hold at least one edge)
//   npm run verify:dashboard -- --after-destroy after destroy:frontend (+ destroy:dynamodb)
//
// It writes SYNTHETIC incidents (id prefix `verify-`, the production record shape) into
// rca-incidents and deletes them again (they also carry a 1 h TTL). It sends a short burst of
// requests to observe throttling, which is deliberately within the stage's limits.
import { INCIDENTS_TABLE, INCIDENT_KEY } from '../../src/lambda-transformer/src/scorer/schema';
import { incidentIdOf, incidentItem } from './alerts-live';
import { aws, awsJson, Check, report } from './aws-cli';
import { ddb, sleepMs } from './ddb-cli';
import { AttributeValue, marshallItem } from './incidents-live';

const afterDestroy = process.argv.includes('--after-destroy');
const withTopology = process.argv.includes('--topology');
const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

const stackOutputs = (stack: string) => {
  const r = awsJson<{ Stacks: { Outputs?: { OutputKey: string; OutputValue: string }[] }[] }>([
    'cloudformation', 'describe-stacks', '--stack-name', stack,
  ]);
  return Object.fromEntries((r.value?.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
};

// --- teardown mode ----------------------------------------------------------------------------
if (afterDestroy) {
  const stack = aws(['cloudformation', 'describe-stacks', '--stack-name', 'FrontendStack']);
  add({ name: 'FrontendStack is gone', ok: !stack.ok && /does not exist/i.test(stack.stderr), detail: stack.ok ? 'stack still exists' : stack.stderr.split('\n')[0] });

  const dists = awsJson<{ DistributionList?: { Items?: { Id: string; Comment: string; Status: string }[] } }>(['cloudfront', 'list-distributions']);
  const left = (dists.value?.DistributionList?.Items ?? []).filter((d) => d.Comment === 'RCA dashboard');
  add({ name: 'No RCA dashboard distribution left', ok: !dists.error && left.length === 0, detail: dists.error ?? (left.map((d) => `${d.Id} ${d.Status}`).join(', ') || 'none') });

  const apis = awsJson<{ Items?: { Name: string; ApiId: string }[] }>(['apigatewayv2', 'get-apis']);
  const rest = (apis.value?.Items ?? []).filter((a) => a.Name.includes('Api') && a.Name.includes('Frontend'));
  add({ name: 'No dashboard HTTP API left', ok: !apis.error && rest.length === 0, detail: apis.error ?? (rest.map((a) => a.ApiId).join(', ') || 'none') });

  const secrets = awsJson<{ SecretList?: { Name: string; DeletedDate?: string }[] }>(['secretsmanager', 'list-secrets', '--include-planned-deletion']);
  const pending = (secrets.value?.SecretList ?? []).filter((s) => s.Name.startsWith('OriginSecret'));
  add({
    name: 'Origin secret',
    ok: true,
    warn: pending.length > 0,
    detail: pending.length === 0 ? 'none' : `${pending.length} scheduled for deletion (Secrets Manager keeps a recovery window; it costs cents and disappears on its own)`,
  });
  process.exit(report(checks) ? 0 : 1);
}

// --- deployed mode ----------------------------------------------------------------------------
const out = stackOutputs('FrontendStack');
if (!out.DashboardUrl || !out.ApiEndpoint) {
  console.log('FAIL  FrontendStack: not deployed -- run npm run deploy:dynamodb then npm run deploy:frontend first');
  process.exit(1);
}
const site = out.DashboardUrl.replace(/\/$/, '');
const rawApi = out.ApiEndpoint.replace(/\/$/, '');
const backend = out.TopologyBackend ?? 'none';

add({
  name: 'Topology backend matches the tier being verified',
  ok: withTopology ? backend === 'neptune' : true,
  warn: !withTopology && backend === 'neptune',
  detail: `deployed with topology=${backend}${!withTopology && backend === 'neptune' ? ' (run with --topology to check the graph)' : ''}`,
});

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json?: any;
}

async function get(url: string, init: { headers?: Record<string, string>; redirect?: 'follow' | 'manual' | 'error' } = {}): Promise<Reply> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** Polls until `ok(reply)` or the deadline; CloudFront and the first Lambda cold start take a moment. */
async function until(url: string, ok: (r: Reply) => boolean, seconds = 90): Promise<Reply | undefined> {
  const deadline = Date.now() + seconds * 1000;
  let last: Reply | undefined;
  for (;;) {
    try {
      last = await get(url);
      if (ok(last)) return last;
    } catch {
      /* DNS or TLS not ready yet */
    }
    if (Date.now() > deadline) return last;
    sleepMs(3000);
  }
}

async function main() {
  // 1. The SPA ------------------------------------------------------------------------------------
  console.log(`... checking ${site}`);
  const page = await until(`${site}/`, (r) => r.status === 200 && r.text.includes('id="root"'), 180);
  add({
    name: 'The SPA is served over HTTPS from the distribution',
    ok: page?.status === 200 && page.text.includes('id="root"') && (page.headers.get('content-type') ?? '').includes('text/html'),
    detail: page ? `HTTP ${page.status}, ${page.headers.get('content-type')}` : 'no response',
  });
  if (page) {
    const h = (n: string) => page.headers.get(n) ?? '';
    add({
      name: 'Security headers are present',
      ok:
        h('strict-transport-security').includes('max-age=31536000') &&
        h('x-content-type-options') === 'nosniff' &&
        h('x-frame-options') === 'DENY' &&
        h('content-security-policy').includes("default-src 'self'"),
      detail: `HSTS=${h('strict-transport-security') ? 'yes' : 'no'}, nosniff=${h('x-content-type-options')}, frame=${h('x-frame-options')}, CSP=${h('content-security-policy') ? 'yes' : 'no'}`,
    });
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.text)?.[1];
    const asset = script ? await get(`${site}${script}`) : undefined;
    add({
      name: 'The bundled script loads (the page is not just an empty shell)',
      ok: asset?.status === 200 && (asset.headers.get('content-type') ?? '').includes('javascript') && asset.text.length > 50_000,
      detail: asset ? `${script}: HTTP ${asset.status}, ${asset.text.length} bytes` : 'no script tag found',
    });
  }
  try {
    const plain = await get(site.replace(/^https:/, 'http:') + '/', { redirect: 'manual' });
    add({
      name: 'Plain HTTP is redirected to HTTPS',
      ok: [301, 302, 307, 308].includes(plain.status) && (plain.headers.get('location') ?? '').startsWith('https://'),
      detail: `HTTP ${plain.status} -> ${plain.headers.get('location') ?? 'no location'}`,
    });
  } catch (err) {
    add({ name: 'Plain HTTP is redirected to HTTPS', ok: false, detail: String((err as Error).message) });
  }

  // 2. The API through CloudFront, and the guard on the raw URL -------------------------------------
  const health = await until(`${site}/api/health`, (r) => r.status === 200, 90);
  add({
    name: '/api/health through CloudFront',
    ok: health?.status === 200 && health.json?.status === 'ok' && health.headers.get('cache-control') === 'no-store',
    detail: health ? `HTTP ${health.status}, cache-control=${health.headers.get('cache-control')}` : 'no response',
  });

  const rawNoHeader = await get(`${rawApi}/api/health`);
  const rawWrong = await get(`${rawApi}/api/health`, { headers: { 'x-rca-origin': 'not-the-secret' } });
  add({
    name: 'The raw execute-api URL refuses requests without the origin header',
    ok: rawNoHeader.status === 403 && rawWrong.status === 403,
    detail: `no header: HTTP ${rawNoHeader.status}, wrong header: HTTP ${rawWrong.status}`,
  });

  // 3. Incidents: open, list, detail, resolve -------------------------------------------------------
  const runId = `verify-${Date.now()}`;
  const openedAt = Date.now();
  const keyOf = (id: string): Record<string, AttributeValue> => ({ [INCIDENT_KEY]: { S: id } });
  const put = (step: 'open' | 'update' | 'resolve') =>
    ddb(['put-item', '--table-name', INCIDENTS_TABLE], { item: marshallItem(incidentItem(runId, step, Date.now(), openedAt)) });
  const incidentId = incidentIdOf(incidentItem(runId, 'open', openedAt, openedAt));

  try {
    const written = put('open');
    add({ name: 'Synthetic incident written (OPEN)', ok: written.ok, detail: written.ok ? incidentId : written.stderr.split('\n')[0] });

    const open = await until(`${site}/api/incidents?status=OPEN`, (r) => r.json?.incidents?.some((i: any) => i.incident_id === incidentId), 60);
    const found = open?.json?.incidents?.find((i: any) => i.incident_id === incidentId);
    add({
      name: 'It appears in the open list with the contract fields',
      ok:
        !!found &&
        found.status === 'OPEN' &&
        found.root_cause === `${runId}-svc` &&
        found.severity === 'critical' &&
        Array.isArray(found.blast_radius) &&
        typeof found.score === 'number' &&
        found.resolved_at_ms === null &&
        !('expires_at' in found),
      detail: found ? `severity=${found.severity}, score=${found.score}` : 'not listed',
    });

    const one = await get(`${site}/api/incidents/${encodeURIComponent(incidentId)}`);
    add({
      name: '/api/incidents/{id} returns it',
      ok: one.status === 200 && one.json?.incident_id === incidentId && Object.keys(one.json?.evidence ?? {}).length === 2,
      detail: `HTTP ${one.status}`,
    });

    put('update');
    const resolved = put('resolve');
    add({ name: 'Synthetic incident resolved', ok: resolved.ok, detail: resolved.ok ? 'written' : resolved.stderr.split('\n')[0] });

    const done = await until(`${site}/api/incidents?status=RESOLVED`, (r) => r.json?.incidents?.some((i: any) => i.incident_id === incidentId), 60);
    const closed = done?.json?.incidents?.find((i: any) => i.incident_id === incidentId);
    add({
      name: 'It moves to the resolved list with a resolution time',
      ok: !!closed && closed.status === 'RESOLVED' && typeof closed.resolved_at_ms === 'number',
      detail: closed ? `resolved_at_ms=${closed.resolved_at_ms}` : 'not listed as resolved',
    });
    const stillOpen = await get(`${site}/api/incidents?status=OPEN`);
    add({
      name: 'And it is no longer in the open list',
      ok: !stillOpen.json?.incidents?.some((i: any) => i.incident_id === incidentId),
      detail: `${stillOpen.json?.count ?? '?'} open incident(s)`,
    });

    const bySvc = await get(`${site}/api/incidents?service=${encodeURIComponent(`${runId}-svc`)}`);
    add({
      name: 'Listing by service finds it',
      ok: bySvc.status === 200 && bySvc.json?.incidents?.some((i: any) => i.incident_id === incidentId),
      detail: `HTTP ${bySvc.status}, ${bySvc.json?.count ?? '?'} item(s)`,
    });

    // 4. Errors are honest ----------------------------------------------------------------------
    const unknown = await get(`${site}/api/incidents/does-not-exist-1`);
    const badStatus = await get(`${site}/api/incidents?status=nope`);
    const badLimit = await get(`${site}/api/incidents?limit=0`);
    const badId = await get(`${site}/api/incidents/a%20b`);
    add({
      name: 'Unknown id is 404; bad status, limit and id are 400, each with a message',
      ok:
        unknown.status === 404 &&
        badStatus.status === 400 &&
        badLimit.status === 400 &&
        badId.status === 400 &&
        typeof badStatus.json?.error === 'string',
      detail: `unknown=${unknown.status}, status=${badStatus.status}, limit=${badLimit.status}, id=${badId.status}`,
    });

    // 5. Topology -------------------------------------------------------------------------------
    const topo = await until(`${site}/api/topology`, (r) => r.status === 200 || r.status === 503, 60);
    if (!withTopology) {
      add({
        name: '/api/topology says the graph backend is not configured (503)',
        ok: topo?.status === 503 && topo.json?.error === 'graph backend not configured',
        detail: `HTTP ${topo?.status}: ${topo?.json?.error ?? topo?.text.slice(0, 80)}`,
      });
    } else {
      const t = topo?.json;
      const ids = new Set<string>((t?.nodes ?? []).map((n: any) => n.id));
      add({
        name: '/api/topology returns the live graph with the contract fields',
        ok:
          topo?.status === 200 &&
          t.schema_version === 1 &&
          t.nodes.length > 0 &&
          t.edges.every((e: any) => ids.has(e.source) && ids.has(e.target)) &&
          typeof t.generated_at_ms === 'number',
        detail: topo ? `HTTP ${topo.status}, ${t?.nodes?.length ?? 0} nodes, ${t?.edges?.length ?? 0} edges` : 'no response',
      });
      add({
        name: 'The topology is cacheable for 10 s, and a second call is served from CloudFront',
        ok: topo?.headers.get('cache-control') === 'public, max-age=10',
        detail: `cache-control=${topo?.headers.get('cache-control')}`,
        warn: topo?.headers.get('cache-control') !== 'public, max-age=10',
      });
      const again = await get(`${site}/api/topology`);
      add({
        name: 'Second topology call is a CloudFront hit with the same generation time',
        ok: /hit/i.test(again.headers.get('x-cache') ?? '') && again.json?.generated_at_ms === t?.generated_at_ms,
        warn: true,
        detail: `x-cache=${again.headers.get('x-cache')}`,
      });
    }

    // 6. Throttling: a burst is answered 429, never 5xx -----------------------------------------------
    const burst = await Promise.all(Array.from({ length: 30 }, () => get(`${site}/api/health`).catch(() => ({ status: 0 }) as Reply)));
    const codes = burst.map((r) => r.status);
    const throttled = codes.filter((c) => c === 429).length;
    const serverErrors = codes.filter((c) => c >= 500 || c === 0).length;
    add({ name: 'A burst of 30 requests produces no 5xx or network errors', ok: serverErrors === 0, detail: `200:${codes.filter((c) => c === 200).length} 429:${throttled} 5xx/err:${serverErrors}` });
    add({
      name: 'Throttling engaged (HTTP 429 observed)',
      ok: throttled > 0,
      warn: throttled === 0,
      detail: throttled > 0 ? `${throttled} of 30 throttled` : 'no 429 seen: the burst may have fit inside the limit; throttling is best effort',
    });
  } finally {
    const gone = ddb(['delete-item', '--table-name', INCIDENTS_TABLE], { key: keyOf(incidentId) });
    add({ name: 'Synthetic incident removed', ok: gone.ok, warn: !gone.ok, detail: gone.ok ? incidentId : gone.stderr.split('\n')[0] });
  }

  // 7. Health -------------------------------------------------------------------------------------
  const since = String(Date.now() - 15 * 60_000);
  const problems: string[] = [];
  for (const key of ['IncidentsFunctionName', 'TopologyFunctionName']) {
    const group = awsJson<{ LoggingConfig?: { LogGroup?: string } }>(['lambda', 'get-function-configuration', '--function-name', out[key]]);
    const name = group.value?.LoggingConfig?.LogGroup;
    if (!name) continue;
    const r = awsJson<{ events?: { message: string }[] }>([
      'logs', 'filter-log-events', '--log-group-name', name, '--start-time', since,
      '--filter-pattern', '?"Invoke Error" ?"Task timed out" ?"api.error"',
    ]);
    for (const e of r.value?.events ?? []) problems.push(`${key}: ${e.message.trim().slice(0, 140)}`);
  }
  add({ name: 'No Lambda errors, timeouts or api.error lines in the last 15 minutes', ok: problems.length === 0, detail: problems[0] ?? 'none' });
}

main()
  .then(() => process.exit(report(checks) ? 0 : 1))
  .catch((err) => {
    console.log(`FAIL  verify-dashboard crashed: ${(err as Error).message}`);
    report(checks);
    process.exit(1);
  });
