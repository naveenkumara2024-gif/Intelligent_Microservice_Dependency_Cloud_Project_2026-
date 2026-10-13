// Small pure formatters shared by the Slack and PagerDuty renderers.

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 0.994 -> "99.4%". */
export function percent(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

/** 8.4 -> "8.4 ms"; sub-millisecond values keep two decimals. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 2)} ms`;
}

/** 192_000 -> "3m 12s"; 3_840_000 -> "1h 04m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** "a, b, c +2 more" with every name truncated. */
export function listNames(names: readonly string[], listed: number, nameLimit: number): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, listed).map((n) => truncate(n, nameLimit));
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} +${rest} more` : shown.join(', ');
}
