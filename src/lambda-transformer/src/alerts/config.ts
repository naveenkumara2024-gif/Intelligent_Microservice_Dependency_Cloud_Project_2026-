// Alert thresholds and text limits in one place (prompt/stage-12-sns-alerting.md, decisions 6-7).
import { AlertSeverity } from './types';

/**
 * PagerDuty severity (and the severity shown everywhere else): `critical` once the fault is
 * propagating, i.e. at least one other service is already anomalous; `error` for a single service.
 */
export function severityOf(blastRadius: readonly string[]): AlertSeverity {
  return blastRadius.length > 0 ? 'critical' : 'error';
}

export const LIMITS = {
  /** Slack header block text. */
  slackHeader: 150,
  /** Slack section text. */
  slackSection: 3000,
  /** One service name inside a message (names are graph labels, usually short). */
  name: 80,
  /** PagerDuty payload.summary. */
  pagerDutySummary: 1024,
  /** SNS Subject (also the email subject). */
  snsSubject: 100,
  /** Services listed in a message before "+N more". */
  listed: 5,
  /** Top candidates shown in a message. */
  candidates: 3,
} as const;

/** Notifier HTTP timeout; the Lambda timeout leaves room for one attempt. */
export const HTTP_TIMEOUT_MS = 10_000;
/** How long a fetched SecureString is reused inside one execution environment. */
export const SECRET_TTL_MS = 5 * 60_000;
/** A parameter that was not found is re-checked sooner, so switching a channel on is quick. */
export const SECRET_MISSING_TTL_MS = 30_000;
