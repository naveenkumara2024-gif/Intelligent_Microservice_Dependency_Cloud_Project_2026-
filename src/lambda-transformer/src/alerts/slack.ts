// Slack incoming-webhook message (Block Kit) for an alert. Pure: no I/O here, the sender is in http.ts.
import { LIMITS } from './config';
import { formatDuration, formatMs, iso, listNames, percent, truncate } from './format';
import { AlertEvent, AlertIncident } from './types';

export interface SlackMessage {
  /** Fallback text for notifications and clients that do not render blocks. */
  text: string;
  blocks: unknown[];
}

export interface RenderOptions {
  dashboardUrl?: string;
}

/** Slack mrkdwn treats these three characters as control characters. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const name = (n: string) => escapeSlack(truncate(n, LIMITS.name));
const mono = (n: string) => `\`${name(n)}\``;
const field = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` });

function evidenceLines(incident: AlertIncident): string[] {
  const rows = Object.entries(incident.evidence).sort((a, b) => b[1].own_delta - a[1].own_delta);
  const lines = rows.slice(0, LIMITS.listed).map(([svc, e]) => {
    const rise = e.own_delta > 0 ? `+${Math.round(e.own_delta * 100)}%` : 'no rise';
    return `• ${mono(svc)}: ${formatMs(e.window_avg_ms)} vs ${formatMs(e.baseline_ms)} baseline (${rise}, ${e.calls} calls)`;
  });
  if (rows.length > LIMITS.listed) lines.push(`• +${rows.length - LIMITS.listed} more`);
  return lines;
}

function candidates(incident: AlertIncident): string {
  return incident.top_candidates
    .slice(0, LIMITS.candidates)
    .map((c, i) => `${i + 1}. ${mono(c.name)} ${percent(c.score)}`)
    .join('  ·  ');
}

export function renderSlack(event: AlertEvent, options: RenderOptions = {}): SlackMessage {
  const i = event.incident;
  const opened = event.event === 'incident.opened';
  const title = opened ? `Incident opened: ${i.root_cause}` : `Incident resolved: ${i.root_cause}`;
  const emoji = opened ? (i.severity === 'critical' ? ':rotating_light:' : ':warning:') : ':white_check_mark:';

  const fields = opened
    ? [
        field('Root cause', mono(i.root_cause)),
        field('Confidence', percent(i.score)),
        field('Severity', i.severity),
        field('Opened', iso(i.opened_at_ms)),
        field('Blast radius', escapeSlack(listNames(i.blast_radius, LIMITS.listed, LIMITS.name))),
        field('At risk (callers)', escapeSlack(listNames(i.at_risk, LIMITS.listed, LIMITS.name))),
      ]
    : [
        field('Root cause', mono(i.root_cause)),
        field('Duration', formatDuration((i.resolved_at_ms ?? event.occurred_at_ms) - i.opened_at_ms)),
        field('Peak confidence', percent(i.peak_score)),
        field('Severity', i.severity),
        field('Opened', iso(i.opened_at_ms)),
        field('Resolved', iso(i.resolved_at_ms ?? event.occurred_at_ms)),
      ];

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', emoji: true, text: truncate(`${emoji} ${title}`, LIMITS.slackHeader) } },
    { type: 'section', fields },
  ];

  const evidence = evidenceLines(i);
  if (evidence.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(`*Evidence (this window vs baseline)*\n${evidence.join('\n')}`, LIMITS.slackSection) },
    });
  }
  if (opened && i.top_candidates.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(`*Model ranking*\n${candidates(i)}`, LIMITS.slackSection) } });
  }

  const footer = [`incident \`${escapeSlack(truncate(i.incident_id, 64))}\``];
  if (i.model_version) footer.push(`model ${escapeSlack(truncate(i.model_version, 40))}`);
  if (options.dashboardUrl) footer.push(`<${options.dashboardUrl}|dashboard>`);
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.join('  ·  ') }] });

  // The header block is plain_text (shown literally, so it keeps the raw name), but the top-level
  // `text` is rendered as mrkdwn: an unescaped "<!channel>" in a service name would notify everyone.
  const safeTitle = `Incident ${opened ? 'opened' : 'resolved'}: ${name(i.root_cause)}`;
  const text = opened
    ? `${safeTitle} (confidence ${percent(i.score)}, severity ${i.severity})`
    : `${safeTitle} after ${formatDuration((i.resolved_at_ms ?? event.occurred_at_ms) - i.opened_at_ms)}`;
  return { text: truncate(text, LIMITS.slackSection), blocks };
}
