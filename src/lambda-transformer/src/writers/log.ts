import { Aggregate } from '../aggregate';
import { GraphWriter, WriteResult } from './types';

/** Prints what a graph writer would upsert. Used before Neptune exists (Stage 8b). */
export class LogWriter implements GraphWriter {
  async write(batch: Aggregate): Promise<WriteResult> {
    for (const e of batch.edges) {
      console.log(
        JSON.stringify({
          edge: `${e.caller} -> ${e.callee}`,
          count: e.count,
          avgMs: Number(e.recentAvgMs.toFixed(3)),
          hist: e.hist,
        }),
      );
    }
    return { nodes: batch.nodes.length, edges: batch.edges.length };
  }
}
