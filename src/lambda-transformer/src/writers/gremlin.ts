// Gremlin graph writer for Neptune (and a local TinkerPop Gremlin Server in tests).
// Targets TinkerPop 3.7.x, the series Neptune engine >= 1.3.2.0 supports (client pinned to 3.7.3).
//
// Graph contract (Stage 2's schema, adapted to a stream; see prompt/stage-08-lambda-transformer.md):
//   (:Service {name, total_calls_as_um, total_calls_as_dm})
//   (:Service)-[:CALLS {call_count, latency_sum_ms, latency_recent_avg_ms, last_seen_ms, h0..h9}]->(:Service)
// Readers derive avg_latency_ms = latency_sum_ms / call_count and estimate p95 from h0..h9.
// All upserts are idempotent; counters are incremented by the batch's amounts.
import gremlin from 'gremlin';
import { Aggregate, BUCKET_COUNT, EdgeAgg, NodeAgg } from '../aggregate';
import { CredentialsProvider, credentialsFromEnv, signGetHeaders } from './sigv4';
import { GraphWriter, WriteResult } from './types';

const { traversal } = gremlin.process.AnonymousTraversalSource;
const { DriverRemoteConnection } = gremlin.driver;
const __ = gremlin.process.statics;
const { single } = gremlin.process.cardinality;
const { label: T_LABEL } = gremlin.process.t;

const CHUNK = 20;
const MAX_ATTEMPTS = 4;

export interface GremlinWriterOptions {
  /** e.g. wss://<neptune-endpoint>:8182/gremlin or ws://localhost:8182/gremlin */
  url: string;
  /**
   * Sign the connection with SigV4 (Neptune IAM database authentication). The connection is
   * then opened on first use, because signing is asynchronous.
   */
  iamAuth?: boolean;
  /** Region used for signing; defaults to AWS_REGION, then us-east-1. */
  region?: string;
  /** Credentials used for signing; defaults to the Lambda environment's. */
  credentials?: CredentialsProvider;
}

/**
 * Node >= 22 defines a global WebSocket, and the gremlin driver prefers it over the `ws` package
 * (`globalThis.WebSocket ?? import('ws')`). It then constructs it with NO options, so custom
 * headers are silently dropped: under IAM auth Neptune receives an unsigned handshake and answers
 * 403, which the driver reports only as "non-101 status code". Found in Stage 9b on the Lambda
 * Node 22 runtime (raw `ws` with the same headers was accepted). Hiding the global makes the driver
 * fall back to `ws`, which honours `headers`. Nothing else in this process uses the global.
 */
export function useNodeWebSocketLibrary(): void {
  const g = globalThis as { WebSocket?: unknown };
  if (g.WebSocket !== undefined) g.WebSocket = undefined;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const messageOf = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * True when the connection is unusable and the next attempt needs a NEW one with freshly signed
 * headers: the socket is gone, or Neptune rejected the opening handshake. A handshake 401/403 means
 * the SigV4 signature is invalid or expired (they live 5 minutes, and the driver replays the headers
 * it was constructed with on every reconnect). It is distinct from a query-level authorization
 * failure, which arrives as a ResponseError on an open connection and is NOT retried.
 */
export function isConnectionError(err: unknown): boolean {
  return /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|not open|connection (is )?closed|WebSocket was closed|Unexpected server response: 40[13]/i.test(
    messageOf(err),
  );
}

/** True for errors worth retrying: concurrent updates to the same element, a transient timeout, or a lost connection. */
export function isRetryable(err: unknown): boolean {
  return /ConcurrentModification|ConcurrentUpdate|Timeout|timed out/i.test(messageOf(err)) || isConnectionError(err);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Vertex counter: property(single, key, <existing value, or 0> + amount), also correct on first create. */
function incrementVertex(t: any, key: string, amount: number): any {
  return t.property(single, key, __.union(__.values(key), __.constant(amount)).sum());
}

/**
 * Edge counter. Edge properties take no cardinality argument (a real server rejects
 * `property(single, ...)` on an edge with "Property cardinality can only be set for a Vertex").
 */
function incrementEdge(t: any, key: string, amount: number): any {
  return t.property(key, __.union(__.values(key), __.constant(amount)).sum());
}

export function nodeTraversal(g: any, nodes: NodeAgg[]): any {
  let t: any = g;
  for (const n of nodes) {
    t = t.mergeV(new Map<any, any>([[T_LABEL, 'Service'], ['name', n.name]]));
    if (n.asCaller > 0) t = incrementVertex(t, 'total_calls_as_um', n.asCaller);
    if (n.asCallee > 0) t = incrementVertex(t, 'total_calls_as_dm', n.asCallee);
  }
  return t;
}

export function edgeTraversal(g: any, edges: EdgeAgg[]): any {
  let t: any = g;
  for (const e of edges) {
    t = t
      .V().has('Service', 'name', e.caller).as('a')
      .V().has('Service', 'name', e.callee).as('b')
      .coalesce(__.inE('CALLS').where(__.outV().as('a')), __.addE('CALLS').from_('a').to('b'));
    t = incrementEdge(t, 'call_count', e.count);
    t = incrementEdge(t, 'latency_sum_ms', e.sumMs);
    t = t.property('latency_recent_avg_ms', e.recentAvgMs).property('last_seen_ms', e.lastSeenMs);
    for (let i = 0; i < BUCKET_COUNT; i++) {
      if (e.hist[i] > 0) t = incrementEdge(t, `h${i}`, e.hist[i]);
    }
  }
  return t;
}

export class GremlinWriter implements GraphWriter {
  private connection: any;
  private g: any;
  /** Set once a request has gone through, so a closed socket is distinguishable from "not opened yet". */
  private everOpened = false;

  constructor(private readonly options: GremlinWriterOptions) {
    // Unauthenticated connections open immediately; IAM ones open on first use (signing is async).
    if (!options.iamAuth) this.open({});
  }

  private open(headers: Record<string, string>): void {
    this.connection = new DriverRemoteConnection(this.options.url, Object.keys(headers).length > 0 ? { headers } : {});
    this.g = traversal().withRemote(this.connection);
  }

  /** The traversal source, opening (and signing) the connection first when needed. */
  async connectedSource(): Promise<any> {
    // The driver reopens a closed socket on its own, but with the headers it was built with: under
    // SigV4 that replays a stale signature (Stage 9c: bursts of "Unexpected server response: 403").
    // Drop a connection that has closed since it was last used so the next one is signed afresh.
    if (this.g && this.options.iamAuth && this.everOpened && this.connection?.isOpen === false) {
      await this.reset();
    }
    if (!this.g) {
      if (this.options.iamAuth) useNodeWebSocketLibrary();
      const headers = this.options.iamAuth
        ? await signGetHeaders({
            url: this.options.url,
            region: this.options.region ?? process.env.AWS_REGION ?? 'us-east-1',
            credentials: await (this.options.credentials ?? credentialsFromEnv)(),
          })
        : {};
      this.open(headers);
    }
    return this.g;
  }

  /** Drops the connection so the next use opens a new one (with fresh signed headers under IAM). */
  private async reset(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    this.g = undefined;
    this.everOpened = false;
    try {
      await connection?.close();
    } catch {
      // the socket is already gone
    }
  }

  private async submit(build: (g: any) => any): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const g = await this.connectedSource();
        // Each traversal is one request; Neptune applies a request atomically, so a retry cannot double-apply.
        await build(g).iterate();
        this.everOpened = true;
        return;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
        if (isConnectionError(err)) await this.reset();
        await sleep(50 * attempt + Math.random() * 150);
      }
    }
  }

  async write(batch: Aggregate): Promise<WriteResult> {
    // Nodes first: the edge upserts look both endpoints up by name.
    for (const part of chunks(batch.nodes, CHUNK)) {
      await this.submit((g) => nodeTraversal(g, part));
    }
    for (const part of chunks(batch.edges, CHUNK)) {
      await this.submit((g) => edgeTraversal(g, part));
    }
    return { nodes: batch.nodes.length, edges: batch.edges.length };
  }

  /** Test helper and diagnostics: the traversal source of an already-open connection. */
  get source(): any {
    if (!this.g) throw new Error('not connected yet: IAM connections open on first use; use connectedSource()');
    return this.g;
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
