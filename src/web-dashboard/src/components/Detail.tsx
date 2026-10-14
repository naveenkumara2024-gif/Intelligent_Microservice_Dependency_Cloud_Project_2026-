import { formatAgo, formatCount, formatDuration, formatMs, formatPercent, formatRise } from '../format';
import { roleIn, STATUS } from '../graph';
import type { Incident, TopologyEdge, TopologyNode } from '../types';

interface IncidentDetailProps {
  incident: Incident;
  nowMs: number;
  onSelectNode: (id: string) => void;
}

const Chips = ({ names, onSelect }: { names: string[]; onSelect: (id: string) => void }) =>
  names.length === 0 ? (
    <span className="muted">none</span>
  ) : (
    <span className="chips">
      {names.map((n) => (
        <button key={n} type="button" className="chip" onClick={() => onSelect(n)}>
          {n}
        </button>
      ))}
    </span>
  );

export function IncidentDetail({ incident: i, nowMs, onSelectNode }: IncidentDetailProps) {
  const open = i.status === 'OPEN';
  const evidence = Object.entries(i.evidence).sort((a, b) => b[1].own_delta - a[1].own_delta);
  return (
    <section className="panel detail" aria-label="Incident detail">
      <h2>
        {i.root_cause} <span className={`pill sev-${i.severity}`}>{i.severity}</span>{' '}
        <span className={`pill state-${i.status.toLowerCase()}`}>{i.status.toLowerCase()}</span>
      </h2>
      <dl className="facts">
        <dt>Confidence</dt>
        <dd>
          {formatPercent(i.score)} <span className="muted">(peak {formatPercent(i.peak_score)})</span>
        </dd>
        <dt>{open ? 'Opened' : 'Duration'}</dt>
        <dd>
          {open
            ? `${new Date(i.opened_at_ms).toLocaleString()} · ${formatAgo(i.opened_at_ms, nowMs)}`
            : formatDuration((i.resolved_at_ms ?? i.last_seen_ms) - i.opened_at_ms)}
        </dd>
        <dt>Windows</dt>
        <dd>{i.windows}</dd>
        <dt>Affected</dt>
        <dd>
          <Chips names={i.blast_radius} onSelect={onSelectNode} />
        </dd>
        <dt>Callers at risk</dt>
        <dd>
          <Chips names={i.at_risk} onSelect={onSelectNode} />
        </dd>
      </dl>

      {evidence.length > 0 && (
        <>
          <h3>Evidence</h3>
          <table className="evidence">
            <thead>
              <tr>
                <th>Service</th>
                <th>Window avg</th>
                <th>Baseline</th>
                <th>Rise</th>
              </tr>
            </thead>
            <tbody>
              {evidence.map(([name, e]) => (
                <tr key={name}>
                  <td>
                    <button type="button" className="link" onClick={() => onSelectNode(name)}>
                      {name}
                    </button>
                  </td>
                  <td>{formatMs(e.window_avg_ms)}</td>
                  <td>{formatMs(e.baseline_ms)}</td>
                  <td>{formatRise(e.own_delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {i.top_candidates.length > 0 && (
        <>
          <h3>Model ranking</h3>
          <ol className="ranking">
            {i.top_candidates.map((c) => (
              <li key={c.name}>
                <span className="rank-name">{c.name}</span>
                <span className="bar" aria-hidden="true">
                  <span style={{ width: `${Math.max(1, Math.round(c.score * 100))}%` }} />
                </span>
                <span className="muted">{formatPercent(c.score)}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <p className="muted small">
        {i.incident_id}
        {i.model_version ? ` · model ${i.model_version}` : ''}
      </p>
    </section>
  );
}

interface NodeDetailProps {
  node: TopologyNode;
  callers: TopologyEdge[];
  callees: TopologyEdge[];
  incidents: Incident[];
  onSelectNode: (id: string) => void;
  onSelectIncident: (id: string) => void;
}

export function NodeDetail({ node, callers, callees, incidents, onSelectNode, onSelectIncident }: NodeDetailProps) {
  return (
    <section className="panel detail" aria-label="Service detail">
      <h2>
        {node.id} <span className={`pill status-${node.status}`}>{STATUS[node.status].label}</span>
      </h2>
      <dl className="facts">
        <dt>Calls received</dt>
        <dd>{formatCount(node.calls_as_callee)}</dd>
        <dt>Calls made</dt>
        <dd>{formatCount(node.calls_as_caller)}</dd>
        <dt>Baseline latency</dt>
        <dd>{node.baseline_ms === null ? <span className="muted">not learned yet</span> : formatMs(node.baseline_ms)}</dd>
      </dl>

      <h3>Called by</h3>
      <EdgeList edges={callers} other="source" onSelect={onSelectNode} />
      <h3>Calls</h3>
      <EdgeList edges={callees} other="target" onSelect={onSelectNode} />

      {incidents.length > 0 && (
        <>
          <h3>Incidents</h3>
          <ul className="plain">
            {incidents.map((i) => (
              <li key={i.incident_id}>
                <button type="button" className="link" onClick={() => onSelectIncident(i.incident_id)}>
                  {i.root_cause}
                </button>{' '}
                <span className="muted">
                  {roleIn(node.id, i)} · {i.status.toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function EdgeList({ edges, other, onSelect }: { edges: TopologyEdge[]; other: 'source' | 'target'; onSelect: (id: string) => void }) {
  if (edges.length === 0) return <p className="muted">none</p>;
  return (
    <ul className="plain">
      {edges.map((e) => (
        <li key={`${e.source}>${e.target}`}>
          <button type="button" className="link" onClick={() => onSelect(e[other])}>
            {e[other]}
          </button>{' '}
          <span className="muted">
            {formatCount(e.call_count)} calls · avg {formatMs(e.avg_latency_ms)}
            {e.p95_latency_ms !== null ? ` · p95 ${formatMs(e.p95_latency_ms)}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}
