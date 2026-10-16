// Reads the live graph (the cumulative counters the transformer maintains) into a GraphSnapshot.
// Read-only: the scorer's IAM role has neptune-db:ReadDataViaQuery and nothing else on the cluster.
import gremlin from 'gremlin';
import { BUCKET_COUNT } from '../aggregate';
import { GremlinWriter, isConnectionError, isRetryable, sleep } from '../writers/gremlin';
import { GraphSource } from './run';
import { GraphSnapshot } from './types';

const __ = gremlin.process.statics;
const ATTEMPTS = 3;
/** A read is two small queries; anything slower than this is a dead socket, not a slow database. */
const READ_TIMEOUT_MS = 10_000;

class ReadTimeout extends Error {
  constructor(ms: number) {
    super(`graph read timed out after ${ms} ms (connection is not open)`);
  }
}

const num = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));
const field = (row: any, key: string): any => (row instanceof Map ? row.get(key) : row[key]);
const zero = () => __.constant(0);

/** The two queries are small (hundreds of services at most) and run once a minute. */
export async function readSnapshot(g: any): Promise<GraphSnapshot> {
  const nodeRows = await g
    .V()
    .hasLabel('Service')
    .project('n', 'um', 'dm')
    .by('name')
    .by(__.coalesce(__.values('total_calls_as_um'), zero()))
    .by(__.coalesce(__.values('total_calls_as_dm'), zero()))
    .toList();

  const buckets = Array.from({ length: BUCKET_COUNT }, (_, i) => `h${i}`);
  let edgeQuery = g.E().hasLabel('CALLS').project('um', 'dm', 'c', 's', ...buckets);
  edgeQuery = edgeQuery
    .by(__.outV().values('name'))
    .by(__.inV().values('name'))
    .by(__.coalesce(__.values('call_count'), zero()))
    .by(__.coalesce(__.values('latency_sum_ms'), zero()));
  for (const b of buckets) edgeQuery = edgeQuery.by(__.coalesce(__.values(b), zero()));
  const edgeRows = await edgeQuery.toList();

  return {
    nodes: nodeRows.map((r: any) => ({
      name: String(field(r, 'n')),
      asUm: num(field(r, 'um')),
      asDm: num(field(r, 'dm')),
    })),
    edges: edgeRows.map((r: any) => ({
      um: String(field(r, 'um')),
      dm: String(field(r, 'dm')),
      calls: num(field(r, 'c')),
      sumMs: num(field(r, 's')),
      hist: buckets.map((b) => num(field(r, b))),
    })),
  };
}

/**
 * Snapshot source backed by the hardened Gremlin client (SigV4 handshake, ws library, re-sign on
 * reconnect). The connection is reused across invocations of a warm Lambda; a dead socket is
 * dropped and re-signed, the same recovery the transformer's writer does.
 */
export class GremlinGraphSource implements GraphSource {
  constructor(
    private readonly client: Pick<GremlinWriter, 'connectedSource' | 'close'>,
    private readonly timeoutMs: number = READ_TIMEOUT_MS,
    private readonly reader: (g: any) => Promise<GraphSnapshot> = readSnapshot,
  ) {}

  async read(): Promise<GraphSnapshot> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.withTimeout(async () => this.reader(await this.client.connectedSource()));
      } catch (err) {
        const dead = err instanceof ReadTimeout || isConnectionError(err);
        if (attempt >= ATTEMPTS || !(dead || isRetryable(err))) throw err;
        // A Lambda's sockets are frozen between invocations: after a thaw the connection can be
        // half-dead and HANG instead of failing. Drop it so the retry opens and signs a new one.
        if (dead) await this.client.close();
        await sleep(100 * attempt + Math.random() * 200);
      }
    }
  }

  private withTimeout<T>(work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReadTimeout(this.timeoutMs)), this.timeoutMs);
    });
    return Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
  }
}
