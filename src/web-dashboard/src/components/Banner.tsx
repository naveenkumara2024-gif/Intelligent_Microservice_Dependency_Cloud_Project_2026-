import type { ApiError, Freshness } from '../api';
import { formatAgo } from '../format';

interface Props {
  topologyState: Freshness;
  incidentsState: Freshness;
  error: ApiError | undefined;
  lastUpdatedMs: number | undefined;
  nowMs: number;
  truncated: boolean;
}

/** One line of "what is wrong with the data you are looking at", or nothing when all is well. */
export function bannerMessage(p: Props): { tone: 'warn' | 'error' | 'info'; text: string } | undefined {
  const since = p.lastUpdatedMs !== undefined ? ` Showing data from ${formatAgo(p.lastUpdatedMs, p.nowMs)}.` : '';
  if (p.topologyState === 'unreachable' || p.incidentsState === 'unreachable') {
    return { tone: 'error', text: `Cannot reach the API${p.error?.status ? ` (HTTP ${p.error.status}: ${p.error.message})` : ''}.${since}` };
  }
  if (p.topologyState === 'stale' || p.incidentsState === 'stale') {
    return { tone: 'warn', text: `Data is not refreshing.${since}` };
  }
  if (p.topologyState === 'unavailable') {
    return { tone: 'info', text: 'Topology is unavailable: the graph backend is not deployed here. Incident data is live.' };
  }
  if (p.truncated) {
    return { tone: 'info', text: 'The graph is large: only the busiest calls are drawn.' };
  }
  return undefined;
}

export function Banner(props: Props) {
  const m = bannerMessage(props);
  if (!m) return null;
  return (
    <div className={`banner banner-${m.tone}`} role="status" aria-live="polite">
      {m.text}
    </div>
  );
}
