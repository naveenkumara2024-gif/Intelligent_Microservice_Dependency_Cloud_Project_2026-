import { useMemo, useState } from 'react';
import { ApiError, freshness, loadIncidents, loadTopology, type Freshness } from './api';
import { Banner } from './components/Banner';
import { IncidentDetail, NodeDetail } from './components/Detail';
import { IncidentList } from './components/IncidentList';
import { TopologyGraph } from './components/TopologyGraph';
import { formatAgo } from './format';
import { incidentNodeIds, incidentsFor } from './graph';
import type { Incident } from './types';
import { useNow, usePolling } from './usePolling';

const POLL_MS = 10_000;
const HISTORY_POLL_MS = 30_000;

type Selection = { kind: 'node'; id: string } | { kind: 'incident'; id: string } | undefined;

const CHIP: Record<Freshness, string> = {
  loading: 'Connecting…',
  live: 'Live',
  stale: 'Stale',
  unavailable: 'Topology unavailable',
  unreachable: 'Unreachable',
};

export default function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [selection, setSelection] = useState<Selection>(undefined);
  const nowMs = useNow(1000);

  const topology = usePolling((s) => loadTopology(s), POLL_MS, refreshKey);
  const open = usePolling((s) => loadIncidents('OPEN', 50, s), POLL_MS, refreshKey);
  const recent = usePolling((s) => loadIncidents('RESOLVED', 10, s), HISTORY_POLL_MS, refreshKey);

  const topologyState = freshness(
    { hasData: !!topology.data, updatedAtMs: topology.updatedAtMs, error: topology.error },
    nowMs,
    POLL_MS,
  );
  const incidentsState = freshness({ hasData: !!open.data, updatedAtMs: open.updatedAtMs, error: open.error }, nowMs, POLL_MS);

  // The chip reports the worst of the two feeds; "unavailable" is a deploy choice, not an outage.
  const overall: Freshness =
    incidentsState === 'unreachable' || topologyState === 'unreachable'
      ? 'unreachable'
      : incidentsState === 'stale' || topologyState === 'stale'
        ? 'stale'
        : topologyState === 'unavailable'
          ? 'unavailable'
          : incidentsState === 'loading' && topologyState === 'loading'
            ? 'loading'
            : 'live';

  const openIncidents = open.data ?? [];
  const recentIncidents = recent.data ?? [];
  const known: Incident[] = useMemo(() => [...openIncidents, ...recentIncidents], [openIncidents, recentIncidents]);

  const selectedIncident = selection?.kind === 'incident' ? known.find((i) => i.incident_id === selection.id) : undefined;
  const selectedNode = selection?.kind === 'node' ? topology.data?.nodes.find((n) => n.id === selection.id) : undefined;
  const highlighted = useMemo(() => incidentNodeIds(selectedIncident), [selectedIncident]);

  const selectNode = (id: string | undefined) => setSelection(id ? { kind: 'node', id } : undefined);
  const selectIncident = (id: string) => setSelection({ kind: 'incident', id });
  const graphSelection = selection?.kind === 'node' ? selection.id : selectedIncident?.root_cause;

  const updated = topology.updatedAtMs ?? open.updatedAtMs;
  const lastError: ApiError | undefined = topology.error?.status === 503 ? open.error : (topology.error ?? open.error);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Microservice RCA</h1>
        <div className="topbar-right">
          <span className={`chip chip-${overall}`} role="status">
            <i aria-hidden="true" />
            {CHIP[overall]}
            {updated !== undefined && overall !== 'unreachable' ? ` · updated ${formatAgo(updated, nowMs)}` : ''}
          </span>
          <button type="button" className="btn" onClick={() => setRefreshKey((k) => k + 1)}>
            Refresh
          </button>
        </div>
      </header>

      <Banner
        topologyState={topologyState}
        incidentsState={incidentsState}
        error={lastError}
        lastUpdatedMs={updated}
        nowMs={nowMs}
        truncated={topology.data?.truncated ?? false}
      />

      <main className="layout">
        <section className="stage" aria-label="Topology">
          {topology.data ? (
            <TopologyGraph
              topology={topology.data}
              selectedNode={graphSelection}
              highlighted={highlighted}
              onSelectNode={selectNode}
            />
          ) : (
            <div className="empty">
              {topologyState === 'unavailable'
                ? 'The topology backend is not deployed in this environment. Incidents are still live.'
                : topologyState === 'unreachable'
                  ? 'Waiting for the API…'
                  : 'Loading topology…'}
            </div>
          )}
        </section>

        <aside className="side">
          <IncidentList
            title="Open incidents"
            incidents={openIncidents}
            loaded={!!open.data}
            selectedId={selection?.kind === 'incident' ? selection.id : undefined}
            nowMs={nowMs}
            emptyText={
              open.data
                ? 'No open incidents. All monitored services are within their baselines.'
                : open.error
                  ? 'Incidents could not be loaded.'
                  : 'Loading…'
            }
            onSelect={selectIncident}
          />

          {selectedIncident && <IncidentDetail incident={selectedIncident} nowMs={nowMs} onSelectNode={selectNode} />}

          {selectedNode && topology.data && (
            <NodeDetail
              node={selectedNode}
              callers={topology.data.edges.filter((e) => e.target === selectedNode.id)}
              callees={topology.data.edges.filter((e) => e.source === selectedNode.id)}
              incidents={incidentsFor(selectedNode.id, known)}
              onSelectNode={selectNode}
              onSelectIncident={selectIncident}
            />
          )}

          <IncidentList
            title="Recently resolved"
            incidents={recentIncidents}
            loaded={!!recent.data}
            selectedId={selection?.kind === 'incident' ? selection.id : undefined}
            nowMs={nowMs}
            emptyText={recent.data ? 'Nothing resolved recently.' : recent.error ? 'History could not be loaded.' : 'Loading…'}
            onSelect={selectIncident}
          />
        </aside>
      </main>
    </div>
  );
}
