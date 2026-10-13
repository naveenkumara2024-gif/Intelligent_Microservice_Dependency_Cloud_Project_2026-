// PagerDuty Events API v2 body for an alert. Pure: no I/O here, the sender is in http.ts.
//
// `dedup_key` is the incident id, so PagerDuty folds a duplicate trigger (at-least-once delivery)
// into the same alert and a resolve closes exactly the alert that the trigger opened.
import { LIMITS } from './config';
import { listNames, percent, truncate, iso } from './format';
import { AlertEvent } from './types';

export interface PagerDutyEvent {
  routing_key: string;
  event_action: 'trigger' | 'resolve';
  dedup_key: string;
  payload?: {
    summary: string;
    source: string;
    severity: 'critical' | 'error' | 'warning' | 'info';
    timestamp: string;
    component: string;
    group: string;
    class: string;
    custom_details: Record<string, unknown>;
  };
  links?: { href: string; text: string }[];
}

export interface PagerDutyOptions {
  dashboardUrl?: string;
}

export function renderPagerDuty(event: AlertEvent, routingKey: string, options: PagerDutyOptions = {}): PagerDutyEvent {
  const i = event.incident;
  if (event.event === 'incident.resolved') {
    // A resolve carries no payload: PagerDuty matches it to the open alert by dedup_key alone.
    return { routing_key: routingKey, event_action: 'resolve', dedup_key: i.incident_id };
  }

  const blast = i.blast_radius.length;
  const summary =
    `Root cause ${truncate(i.root_cause, LIMITS.name)} (confidence ${percent(i.score)}); ` +
    (blast === 0
      ? 'no other service affected yet'
      : `blast radius ${blast} service${blast === 1 ? '' : 's'}: ${listNames(i.blast_radius, LIMITS.listed, LIMITS.name)}`);

  const body: PagerDutyEvent = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: i.incident_id,
    payload: {
      summary: truncate(summary, LIMITS.pagerDutySummary),
      source: 'rca-framework',
      severity: i.severity,
      timestamp: iso(event.occurred_at_ms),
      component: truncate(i.root_cause, 255),
      group: 'microservices',
      class: 'latency-degradation',
      custom_details: {
        incident_id: i.incident_id,
        score: i.score,
        peak_score: i.peak_score,
        blast_radius: i.blast_radius,
        at_risk: i.at_risk,
        top_candidates: i.top_candidates,
        evidence: i.evidence,
        windows: i.windows,
        model_version: i.model_version,
      },
    },
  };
  if (options.dashboardUrl) body.links = [{ href: options.dashboardUrl, text: 'RCA dashboard' }];
  return body;
}
