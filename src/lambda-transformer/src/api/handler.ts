// Stage 13 dashboard API: two Lambdas from one bundle (dist/api.js).
//
//   api.incidents   (no VPC)   GET /api/health, /api/incidents, /api/incidents/{id}   -> DynamoDB
//   api.topology    (in VPC)   GET /api/topology                                      -> Neptune + DynamoDB
//
// Both are read-only. Every request must carry the origin header CloudFront injects (http.ts), so
// the raw execute-api URL is not a second public door. Dependencies are injected for tests.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GremlinWriter } from '../writers/gremlin';
import { GremlinGraphSource } from '../scorer/graph';
import { GraphSource } from '../scorer/run';
import { DEFAULT_TABLES, documentClient, DynamoScorerStore, listIncidents, TableNames } from '../scorer/store';
import { ScorerState } from '../scorer/types';
import { BadRequest, getIncidentView, listIncidentViews, parseListQuery } from './incidents';
import { errorBody, internalError, json, lowerCaseHeaders, methodOf, originAllowed } from './http';
import { buildTopology, recentWindow } from './topology';
import { HttpApiEvent, HttpApiResult } from './types';

export interface ApiDeps {
  originSecret?: string;
  doc: DynamoDBDocumentClient;
  tables: TableNames;
  /** Absent in the no-VPC function (and when the topology backend is not deployed). */
  graph?: GraphSource;
  /** The scorer's state item: baselines, and the counters the recent window is measured from. */
  state: { load(): Promise<ScorerState | undefined> };
  now: () => number;
  topologyCacheSeconds: number;
}

/** Open incidents shown on the topology; far above what a healthy demo ever has. */
const TOPOLOGY_INCIDENT_LIMIT = 100;

/** Method, origin and routing gate shared by both Lambdas; returns a response to send, or undefined. */
function gate(event: HttpApiEvent, deps: ApiDeps): HttpApiResult | undefined {
  if (methodOf(event) !== 'GET') return errorBody(405, 'method not allowed');
  if (!originAllowed(lowerCaseHeaders(event.headers), deps.originSecret)) return errorBody(403, 'forbidden');
  return undefined;
}

export async function handleTopology(event: HttpApiEvent, deps: ApiDeps): Promise<HttpApiResult> {
  const refused = gate(event, deps);
  if (refused) return refused;
  if (!deps.graph) return errorBody(503, 'graph backend not configured');

  try {
    const [snapshot, open, state] = await Promise.all([
      deps.graph.read(),
      listIncidents(deps.doc, { status: 'OPEN', limit: TOPOLOGY_INCIDENT_LIMIT, nowMs: deps.now() }, deps.tables),
      deps.state.load(),
    ]);
    const nowMs = deps.now();
    const body = buildTopology(snapshot, open, state?.baselines ?? {}, nowMs, recentWindow(snapshot, state, nowMs));
    return json(200, body, { cacheSeconds: deps.topologyCacheSeconds });
  } catch (err) {
    return internalError('topology', err);
  }
}

export async function handleIncidents(event: HttpApiEvent, deps: ApiDeps): Promise<HttpApiResult> {
  const refused = gate(event, deps);
  if (refused) return refused;

  const path = (event.rawPath ?? '').replace(/\/+$/, '');
  try {
    if (path === '/api/health') {
      return json(200, { status: 'ok', time_ms: deps.now() });
    }
    if (path === '/api/incidents') {
      const query = parseListQuery(event.queryStringParameters);
      return json(200, await listIncidentViews(deps.doc, query, deps.tables, deps.now()));
    }
    const match = /^\/api\/incidents\/([^/]+)$/.exec(path);
    if (match) {
      let id: string;
      try {
        id = decodeURIComponent(event.pathParameters?.id ?? match[1]);
      } catch {
        throw new BadRequest('invalid incident id');
      }
      const view = await getIncidentView(deps.doc, id, deps.tables, deps.now());
      return view ? json(200, view) : errorBody(404, 'incident not found');
    }
    return errorBody(404, 'not found');
  } catch (err) {
    if (err instanceof BadRequest) return errorBody(400, err.message);
    return internalError('incidents', err);
  }
}

// --- Lambda wiring ------------------------------------------------------------------------------

let cached: ApiDeps | undefined;

export function buildDeps(env: NodeJS.ProcessEnv = process.env): ApiDeps {
  if (cached) return cached;
  const doc = documentClient(new DynamoDBClient({}));
  const tables: TableNames = {
    incidents: env.INCIDENTS_TABLE ?? DEFAULT_TABLES.incidents,
    state: env.STATE_TABLE ?? DEFAULT_TABLES.state,
  };
  const graph = env.GREMLIN_URL
    ? new GremlinGraphSource(new GremlinWriter({ url: env.GREMLIN_URL, iamAuth: env.NEPTUNE_IAM_AUTH !== 'false' }))
    : undefined;
  cached = {
    originSecret: env.ORIGIN_SECRET,
    doc,
    tables,
    graph,
    state: new DynamoScorerStore(doc, tables),
    now: Date.now,
    topologyCacheSeconds: Number(env.TOPOLOGY_CACHE_SECONDS ?? 5),
  };
  return cached;
}

/** Replaces the cached dependencies (tests). */
export function setDeps(deps: ApiDeps | undefined): void {
  cached = deps;
}

export const topology = (event: HttpApiEvent) => handleTopology(event, buildDeps());
export const incidents = (event: HttpApiEvent) => handleIncidents(event, buildDeps());
