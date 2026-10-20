import { describe, expect, it } from 'vitest';
import { buildCsv, csvToTsv, isExampleCell, parseCsv } from './csv';

describe('csv helpers', () => {
  it('parses quoted cells, escaped quotes, embedded commas/newlines and a BOM', () => {
    const rows = parseCsv('﻿Name,Notes\r\n"Kumar, S","He said ""hi""\nsecond line"\r\nPlain,ok\r\n');
    expect(rows).toEqual([
      ['Name', 'Notes'],
      ['Kumar, S', 'He said "hi"\nsecond line'],
      ['Plain', 'ok'],
    ]);
  });

  it('detects semicolon and tab delimiters (Excel in some locales)', () => {
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('skips blank lines and keeps empty cells in place', () => {
    expect(parseCsv('a,b,c\n\n,,\n1,,3\n')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });

  it('converts an upload to the tab-separated text the parsers read', () => {
    expect(csvToTsv('Name,Phone\n"Kumar, S",9876543210')).toBe('Name\tPhone\nKumar, S\t9876543210');
  });

  it('builds CSV with quoting and CRLF', () => {
    expect(buildCsv(['a', 'b'], [['x,y', 'say "hi"']])).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
  });

  it('recognises template example rows', () => {
    expect(isExampleCell('EXAMPLE – Priya Sharma')).toBe(true);
    expect(isExampleCell('**example - Monday**')).toBe(true);
    expect(isExampleCell('Examples Kumar')).toBe(false);
    expect(isExampleCell('Priya')).toBe(false);
  });
});
