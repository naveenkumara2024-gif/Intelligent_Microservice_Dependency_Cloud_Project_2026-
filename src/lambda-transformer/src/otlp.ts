// Parser for the OTLP/JSON trace payload the collector's `kafka` exporter writes with
// `encoding: otlp_json` (one ExportTraceServiceRequest per Kafka record).
// Only the fields the transformer needs are extracted; malformed spans are skipped, not fatal.

export const SPAN_KIND_CLIENT = 3;

export interface ParsedSpan {
  /** resource attribute `service.name` of the reporting service */
  service: string;
  kind: number;
  durationMs: number;
  /** end time, epoch milliseconds */
  endMs: number;
  attrs: Record<string, string>;
}

export interface ParseResult {
  spans: ParsedSpan[];
  /** spans dropped because required fields were missing or unparsable */
  skipped: number;
}

const KIND_NAMES: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

function parseKind(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return KIND_NAMES[raw] ?? (Number.isNaN(Number(raw)) ? 0 : Number(raw));
  return 0;
}

// OTLP/JSON encodes 64-bit integers as strings; nanosecond timestamps exceed 2^53, so use BigInt.
function parseNanos(raw: unknown): bigint | undefined {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return BigInt(raw);
  if (typeof raw === 'number' && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
  return undefined;
}

interface KeyValue {
  key?: string;
  value?: Record<string, unknown>;
}

function attrsToMap(list: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list as KeyValue[]) {
    if (!kv || typeof kv.key !== 'string' || !kv.value) continue;
    const v = kv.value.stringValue ?? kv.value.intValue ?? kv.value.doubleValue ?? kv.value.boolValue;
    if (v !== undefined && v !== null) out[kv.key] = String(v);
  }
  return out;
}

export function parseTraces(json: string): ParseResult {
  const result: ParseResult = { spans: [], skipped: 0 };
  let doc: any;
  try {
    doc = JSON.parse(json);
  } catch {
    // An unparsable record counts as one skipped unit.
    result.skipped = 1;
    return result;
  }
  const resourceSpans: any[] = Array.isArray(doc?.resourceSpans) ? doc.resourceSpans : [];
  for (const rs of resourceSpans) {
    const service = attrsToMap(rs?.resource?.attributes)['service.name'];
    const scopeSpans: any[] = Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : [];
    for (const ss of scopeSpans) {
      const spans: any[] = Array.isArray(ss?.spans) ? ss.spans : [];
      for (const s of spans) {
        const start = parseNanos(s?.startTimeUnixNano);
        const end = parseNanos(s?.endTimeUnixNano);
        if (!service || start === undefined || end === undefined || end < start) {
          result.skipped++;
          continue;
        }
        result.spans.push({
          service,
          kind: parseKind(s.kind),
          durationMs: Number(end - start) / 1e6,
          endMs: Number(end / 1_000_000n),
          attrs: attrsToMap(s.attributes),
        });
      }
    }
  }
  return result;
}
