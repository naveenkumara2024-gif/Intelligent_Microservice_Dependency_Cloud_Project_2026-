import { describe, expect, test } from 'vitest';
import { formatAgo, formatCount, formatDuration, formatMs, formatPercent, formatRise } from '../src/format';

describe('format', () => {
  test('milliseconds keep useful precision', () => {
    expect(formatMs(0.694)).toBe('0.69 ms');
    expect(formatMs(8.4)).toBe('8.40 ms');
    expect(formatMs(26.667)).toBe('26.7 ms');
    expect(formatMs(412.4)).toBe('412 ms');
    expect(formatMs(null)).toBe('–');
    expect(formatMs(NaN)).toBe('–');
  });

  test('percent, counts, rise', () => {
    expect(formatPercent(0.994)).toBe('99.4%');
    expect(formatCount(950)).toBe('950');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(25_000)).toBe('25k');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatRise(7.2)).toBe('+720%');
    expect(formatRise(0)).toBe('no rise');
    expect(formatRise(-0.3)).toBe('no rise');
  });

  test('durations and relative times', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(3_840_000)).toBe('1h 04m');
    expect(formatDuration(-1)).toBe('0s');
    const now = 1_000_000_000;
    expect(formatAgo(now - 1000, now)).toBe('just now');
    expect(formatAgo(now - 42_000, now)).toBe('42 s ago');
    expect(formatAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatAgo(now - 72 * 3_600_000, now)).toBe('3 d ago');
    expect(formatAgo(now + 5000, now)).toBe('just now');
  });
});
