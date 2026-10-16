import { plainRows, rankedEdgesQuery } from '../scripts/neo4j-baseline';

describe('plainRows (cypher-shell --format plain output)', () => {
  test('drops the header line and splits comma-separated values', () => {
    const text = 'um, dm, call_count\nabc, def, 190574\nghi, ghi, 7\n';
    expect(plainRows(text)).toEqual([
      ['abc', 'def', '190574'],
      ['ghi', 'ghi', '7'],
    ]);
  });

  test('tolerates CRLF, blank lines and quoted strings', () => {
    const text = 'name, um, dm\r\n"svc-a", 3, 4\r\n\r\n';
    expect(plainRows(text)).toEqual([['svc-a', '3', '4']]);
  });

  test('a result with only a header has no rows', () => {
    expect(plainRows('um, dm, call_count\n')).toEqual([]);
    expect(plainRows('')).toEqual([]);
  });
});

describe('rankedEdgesQuery', () => {
  test('orders like selectSubset: call_count desc, then um, then dm', () => {
    expect(rankedEdgesQuery(2000)).toContain('ORDER BY r.call_count DESC, a.name ASC, b.name ASC LIMIT 2000');
  });

  test('no limit means the whole graph', () => {
    expect(rankedEdgesQuery(undefined)).not.toContain('LIMIT');
  });
});
