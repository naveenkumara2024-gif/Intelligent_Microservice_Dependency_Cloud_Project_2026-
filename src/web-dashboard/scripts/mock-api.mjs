// Local stand-in for the dashboard API (npm run mock), for developing and reviewing the SPA with no
// AWS account. It serves the golden files the Lambda tests produce, so what you see is exactly the
// contract, with timestamps rebased to "now" so relative times read sensibly.
//
//   npm run mock                      # scenario "incident" (a root cause with a blast radius)
//   SCENARIO=healthy npm run mock     # nothing open
//   SCENARIO=no-topology npm run mock # 503 on /api/topology, as when Neptune is not deployed
//   SCENARIO=down npm run mock        # every call fails with 502
// The scenario can also be switched live:  POST /__scenario/healthy
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const fixtures = (name) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../lambda-transformer/test/fixtures/${name}`, import.meta.url)), 'utf8'));
const topologyGolden = fixtures('api-topology.json');
const incidentsGolden = fixtures('api-incidents.json');

let scenario = process.env.SCENARIO ?? 'incident';
const MS_FIELDS = ['opened_at_ms', 'last_seen_ms', 'resolved_at_ms'];

function incidents(now) {
  // Rebase so the open incident was opened 4 minutes ago, and the resolved one an hour ago.
  const open = incidentsGolden.incidents.find((i) => i.status === 'OPEN');
  const delta = now - 4 * 60_000 - open.opened_at_ms;
  return incidentsGolden.incidents.map((i) => {
    const shifted = structuredClone(i);
    for (const f of MS_FIELDS) if (typeof shifted[f] === 'number') shifted[f] += delta;
    if (shifted.status === 'OPEN') shifted.last_seen_ms = now - 20_000;
    return shifted;
  });
}

function topology(now) {
  const t = structuredClone(topologyGolden);
  t.generated_at_ms = now;
  if (scenario === 'healthy') {
    t.open_incidents = [];
    for (const n of t.nodes) {
      n.status = 'healthy';
      n.incident_id = null;
    }
  } else {
    t.open_incidents = incidents(now).filter((i) => i.status === 'OPEN').map((i) => i.incident_id);
    for (const n of t.nodes) if (n.incident_id) n.incident_id = t.open_incidents[0];
  }
  return t;
}

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const now = Date.now();

  if (req.method === 'POST' && url.pathname.startsWith('/__scenario/')) {
    scenario = decodeURIComponent(url.pathname.slice('/__scenario/'.length));
    return send(res, 200, { scenario });
  }
  if (scenario === 'down') return send(res, 502, { error: 'upstream data store unavailable' });
  if (url.pathname === '/api/health') return send(res, 200, { status: 'ok', time_ms: now });

  if (url.pathname === '/api/topology') {
    return scenario === 'no-topology' ? send(res, 503, { error: 'graph backend not configured' }) : send(res, 200, topology(now));
  }
  if (url.pathname === '/api/incidents') {
    const status = (url.searchParams.get('status') ?? 'OPEN').toUpperCase();
    const all = scenario === 'healthy' ? incidents(now).filter((i) => i.status === 'RESOLVED') : incidents(now);
    const list = all.filter((i) => i.status === status).slice(0, Number(url.searchParams.get('limit') ?? 50));
    return send(res, 200, { incidents: list, count: list.length });
  }
  const one = /^\/api\/incidents\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const found = incidents(now).find((i) => i.incident_id === decodeURIComponent(one[1]));
    return found ? send(res, 200, found) : send(res, 404, { error: 'incident not found' });
  }
  send(res, 404, { error: 'not found' });
}).listen(8787, '127.0.0.1', () => console.log(`mock API on http://127.0.0.1:8787 (scenario: ${scenario})`));
