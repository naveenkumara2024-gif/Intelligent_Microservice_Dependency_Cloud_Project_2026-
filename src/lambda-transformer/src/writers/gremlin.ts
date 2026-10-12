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
  /** SigV4-signed connections are a Stage 9 (Neptune) decision and are not implemented yet. */
  iamAuth?: boolean;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True for errors worth retrying: concurrent updates to the same element, or a transient timeout. */
export function isRetryable(err: unknown): boolean {
  return /ConcurrentModification|ConcurrentUpdate|Timeout|timed out|ECONNRESET/i.test(String((err as Error)?.message ?? err));
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
  private readonly connection: any;
  private readonly g: any;

  constructor(options: GremlinWriterOptions) {
    if (options.iamAuth) {
      throw new Error('IAM (SigV4) authentication for Neptune is implemented in Stage 9; use an unauthenticated endpoint until then');
    }
    this.connection = new DriverRemoteConnection(options.url, {});
    this.g = traversal().withRemote(this.connection);
  }

  private async submit(build: () => any): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        // Each traversal is one request; Neptune applies a request atomically, so a retry cannot double-apply.
        await build().iterate();
        return;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
        await sleep(50 * attempt + Math.random() * 150);
      }
    }
  }

  async write(batch: Aggregate): Promise<WriteResult> {
    // Nodes first: the edge upserts look both endpoints up by name.
    for (const part of chunks(batch.nodes, CHUNK)) {
      await this.submit(() => nodeTraversal(this.g, part));
    }
    for (const part of chunks(batch.edges, CHUNK)) {
      await this.submit(() => edgeTraversal(this.g, part));
    }
    return { nodes: batch.nodes.length, edges: batch.edges.length };
  }

  /** Test helper and diagnostics: the underlying traversal source. */
  get source(): any {
    return this.g;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}
