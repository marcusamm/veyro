import { describe, expect, it } from 'vitest';
import { copenhagenInstants, parseInstant, validDate, zonedParts } from '../src/aj/store.ts';

const toIso = values => values.map(seconds => new Date(seconds * 1000).toISOString());

describe('AJ Auto Europe/Copenhagen time handling', () => {
  it('converts the same workshop clock time using the correct winter and summer offset', () => {
    expect(toIso(copenhagenInstants('2027-01-15', 9 * 60))).toEqual(['2027-01-15T08:00:00.000Z']);
    expect(toIso(copenhagenInstants('2027-07-15', 9 * 60))).toEqual(['2027-07-15T07:00:00.000Z']);
  });

  it('does not invent the local hour skipped when summer time starts', () => {
    expect(copenhagenInstants('2027-03-28', 2 * 60 + 30)).toEqual([]);
    expect(toIso(copenhagenInstants('2027-03-28', 3 * 60))).toEqual(['2027-03-28T01:00:00.000Z']);
  });

  it('keeps both distinct instants when the autumn clock hour repeats', () => {
    expect(toIso(copenhagenInstants('2027-10-31', 2 * 60 + 30))).toEqual([
      '2027-10-31T00:30:00.000Z', '2027-10-31T01:30:00.000Z',
    ]);
  });

  it('derives the Danish date and weekday across UTC midnight', () => {
    expect(zonedParts(Date.parse('2027-07-04T22:30:00Z') / 1000)).toEqual({ date: '2027-07-05', minute: 30, weekday: 1 });
  });

  it('rejects impossible dates and ambiguous client times without an explicit offset', () => {
    expect(validDate('2027-02-29')).toBe(false);
    expect(validDate('2028-02-29')).toBe(true);
    expect(copenhagenInstants('2027-02-29', 540)).toEqual([]);
    expect(() => parseInstant('2027-10-31T02:30')).toThrow();
    expect(parseInstant('2027-10-31T02:30:00+02:00')).toBe(Date.parse('2027-10-31T00:30:00Z') / 1000);
  });
});
