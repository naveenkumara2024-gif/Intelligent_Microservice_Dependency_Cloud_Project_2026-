// Lambda entry point: Amazon MSK event source mapping -> graph upserts.
//
// MSK delivers records grouped by "<topic>-<partition>", with base64-encoded values. Each value
// is one OTLP/JSON ExportTraceServiceRequest written by the collector's Kafka exporter.
// Delivery is at-least-once: if the writer throws, Lambda retries the batch, so counters can
// double-count on a retry (documented trade-off; metrics are approximate).
import { aggregate } from './aggregate';
import { Call, deriveCall } from './edges';
import { parseTraces } from './otlp';
import { GraphWriter } from './writers/types';
import { LogWriter } from './writers/log';
import { GremlinWriter } from './writers/gremlin';

export interface MskRecord {
  topic: string;
  partition: number;
  offset: number;
  value?: string; // base64
}

export interface MskEvent {
  eventSource?: string;
  records: Record<string, MskRecord[]>;
}

export interface Summary {
  records: number;
  undecodable: number;
  spans: number;
  skippedSpans: number;
  calls: number;
  edges: number;
  nodes: number;
}

let writer: GraphWriter | undefined;

/** GRAPH_BACKEND=log (default, used until Neptune exists) or gremlin (GREMLIN_URL required). */
export function getWriter(env: NodeJS.ProcessEnv = process.env): GraphWriter {
  if (writer) return writer;
  const backend = env.GRAPH_BACKEND ?? 'log';
  if (backend === 'log') {
    writer = new LogWriter();
  } else if (backend === 'gremlin') {
    if (!env.GREMLIN_URL) throw new Error('GRAPH_BACKEND=gremlin requires GREMLIN_URL');
    writer = new GremlinWriter({ url: env.GREMLIN_URL, iamAuth: env.NEPTUNE_IAM_AUTH === 'true' });
  } else {
    throw new Error(`Unknown GRAPH_BACKEND "${backend}" (expected "log" or "gremlin")`);
  }
  return writer;
}

/** Replaces the cached writer (tests). */
export function setWriter(w: GraphWriter | undefined): void {
  writer = w;
}

export async function handler(event: MskEvent): Promise<Summary> {
  const summary: Summary = { records: 0, undecodable: 0, spans: 0, skippedSpans: 0, calls: 0, edges: 0, nodes: 0 };
  const calls: Call[] = [];

  for (const records of Object.values(event.records ?? {})) {
    for (const record of records) {
      summary.records++;
      if (!record.value) {
        summary.undecodable++;
        continue;
      }
      const parsed = parseTraces(Buffer.from(record.value, 'base64').toString('utf8'));
      summary.skippedSpans += parsed.skipped;
      summary.spans += parsed.spans.length;
      for (const span of parsed.spans) {
        const call = deriveCall(span);
        if (call) calls.push(call);
      }
    }
  }
  summary.calls = calls.length;

  if (calls.length > 0) {
    const written = await getWriter().write(aggregate(calls));
    summary.edges = written.edges;
    summary.nodes = written.nodes;
  }
  console.log(JSON.stringify({ transformer: summary }));
  return summary;
}
