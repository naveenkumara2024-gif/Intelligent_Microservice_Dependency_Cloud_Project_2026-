import { formatAgo, formatDuration, formatPercent } from '../format';
import type { Incident } from '../types';

interface Props {
  title: string;
  incidents: Incident[];
  /** False until the feed has answered once: a count of 0 would otherwise read as "nothing open". */
  loaded?: boolean;
  selectedId: string | undefined;
  nowMs: number;
  emptyText: string;
  onSelect: (id: string) => void;
}

export function IncidentList({ title, incidents, loaded = true, selectedId, nowMs, emptyText, onSelect }: Props) {
  return (
    <section className="panel" aria-label={title}>
      <h2>
        {title} {loaded && <span className="count">{incidents.length}</span>}
      </h2>
      {incidents.length === 0 ? (
        <p className="muted">{emptyText}</p>
      ) : (
        <ul className="incident-list">
          {incidents.map((i) => (
            <li key={i.incident_id}>
              <button
                type="button"
                className={`incident ${i.incident_id === selectedId ? 'is-selected' : ''}`}
                aria-pressed={i.incident_id === selectedId}
                onClick={() => onSelect(i.incident_id)}
              >
                <span className={`pill sev-${i.severity}`}>{i.severity}</span>
                <span className="incident-main">
                  <b>{i.root_cause}</b>
                  <span className="muted">
                    {formatPercent(i.score)} confidence
                    {i.blast_radius.length > 0 ? ` · ${i.blast_radius.length} affected` : ''}
                  </span>
                </span>
                <span className="incident-when muted">
                  {i.status === 'OPEN'
                    ? `opened ${formatAgo(i.opened_at_ms, nowMs)}`
                    : `lasted ${formatDuration((i.resolved_at_ms ?? i.last_seen_ms) - i.opened_at_ms)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
