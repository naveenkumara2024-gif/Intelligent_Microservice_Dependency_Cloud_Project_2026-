// SYNTHETIC fixtures: hand-built to the OTLP/JSON shape the collector's `kafka` exporter
// (encoding: otlp_json) writes. They are NOT captured Online Boutique traffic; attribute names
// are plausible semantic-convention names, to be confirmed against a live capture (Stage 7b/8b).
import { MskEvent } from '../src/handler';

export interface SpanSpec {
  kind?: number | string;
  /** attributes as plain key/value pairs */
  attrs?: Record<string, string | number>;
  durationMs?: number;
  endMs?: number;
}

const attr = (key: string, v: string | number) => ({
  key,
  value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v },
});

/** One ExportTraceServiceRequest (one Kafka record value) from a single reporting service. */
export function traceMessage(service: string | undefined, spans: SpanSpec[]): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: service === undefined ? [] : [attr('service.name', service)] },
        scopeSpans: [
          {
            scope: { name: 'synthetic' },
            spans: spans.map((s, i) => {
              const endMs = s.endMs ?? 1_700_000_000_000 + i;
              const durationMs = s.durationMs ?? 10;
              return {
                traceId: '00000000000000000000000000000001',
                spanId: `000000000000000${i}`.slice(-16),
                name: 'synthetic',
                kind: s.kind ?? 3,
                // 64-bit values are strings in OTLP/JSON; nanoseconds exceed 2^53
                startTimeUnixNano: String(BigInt(Math.round((endMs - durationMs) * 1e6))),
                endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
                attributes: Object.entries(s.attrs ?? {}).map(([k, v]) => attr(k, v)),
              };
            }),
          },
        ],
      },
    ],
  });
}

/** An MSK event-source-mapping event: values are base64, grouped by "<topic>-<partition>". */
export function mskEvent(values: (string | undefined)[], partition = 0): MskEvent {
  return {
    eventSource: 'aws:kafka',
    records: {
      [`otel.traces-${partition}`]: values.map((v, offset) => ({
        topic: 'otel.traces',
        partition,
        offset,
        value: v === undefined ? undefined : Buffer.from(v, 'utf8').toString('base64'),
      })),
    },
  };
}

/** A CLIENT span calling `callee` via the given attribute name. */
export const clientCall = (callee: string, durationMs = 10, attrName = 'server.address'): SpanSpec => ({
  kind: 3,
  durationMs,
  attrs: { [attrName]: callee },
});
