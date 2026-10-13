// Incident lifecycle with hysteresis (decision 5). Pure: trackers in, trackers and actions out.
//
// A service is "implicated" in a window when the evidence gate holds and it is the model's top
// candidate. One implicated window is noise; `openAfter` consecutive ones open an incident. Once
// open, `resolveAfter` consecutive windows without being implicated resolve it. State lives in the
// trackers (carried in the scorer's state item), not in a query against the incidents table.
import { ScorerConfig } from './config';
import { SCHEMA_VERSION } from './schema';
import { Action, Implication, IncidentRecord, Tracker } from './types';

export type Trackers = Record<string, Tracker>;

const expiry = (nowMs: number, cfg: ScorerConfig) => Math.floor(nowMs / 1000) + cfg.ttlDays * 86_400;

export function stepLifecycle(
  trackers: Trackers,
  implication: Implication | undefined,
  nowMs: number,
  cfg: ScorerConfig,
): { trackers: Trackers; actions: Action[] } {
  const next: Trackers = {};
  const actions: Action[] = [];

  for (const [service, t] of Object.entries(trackers)) {
    if (implication?.service === service) continue; // handled below
    const misses = t.misses + 1;
    if (t.incident) {
      if (misses >= cfg.resolveAfter) {
        const incident: IncidentRecord = {
          ...t.incident,
          status: 'RESOLVED',
          resolved_at_ms: nowMs,
          expires_at: expiry(nowMs, cfg),
        };
        actions.push({ kind: 'resolve', service, incident });
        // tracker dropped: the incident is closed and the service starts clean
      } else {
        next[service] = { ...t, hits: 0, misses };
      }
    }
    // A candidate that was not confirmed on consecutive windows is dropped (hits must be consecutive).
  }

  if (implication) {
    const previous = trackers[implication.service];
    const hits = (previous?.hits ?? 0) + 1;
    const firstHitMs = previous && previous.hits > 0 ? previous.firstHitMs : nowMs;

    if (previous?.incident) {
      const incident: IncidentRecord = {
        ...previous.incident,
        last_seen_ms: nowMs,
        score: implication.score,
        peak_score: Math.max(previous.incident.peak_score, implication.score),
        ranking: implication.ranking,
        blast_radius: implication.blastRadius,
        at_risk: implication.atRisk,
        evidence: implication.evidence,
        windows: previous.incident.windows + 1,
        model_version: implication.modelVersion,
        expires_at: expiry(nowMs, cfg),
      };
      next[implication.service] = { hits, misses: 0, firstHitMs, incident };
      actions.push({ kind: 'update', service: implication.service, incident });
    } else if (hits >= cfg.openAfter) {
      const incident: IncidentRecord = {
        schema_version: SCHEMA_VERSION,
        incident_id: `${firstHitMs}-${implication.service}`,
        status: 'OPEN',
        root_cause: implication.service,
        opened_at_ms: firstHitMs,
        last_seen_ms: nowMs,
        score: implication.score,
        peak_score: implication.score,
        ranking: implication.ranking,
        blast_radius: implication.blastRadius,
        at_risk: implication.atRisk,
        evidence: implication.evidence,
        windows: hits,
        model_version: implication.modelVersion,
        expires_at: expiry(nowMs, cfg),
      };
      next[implication.service] = { hits, misses: 0, firstHitMs, incident };
      actions.push({ kind: 'open', service: implication.service, incident });
    } else {
      next[implication.service] = { hits, misses: 0, firstHitMs };
    }
  }

  return { trackers: next, actions };
}
