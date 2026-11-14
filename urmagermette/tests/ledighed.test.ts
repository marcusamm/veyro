import { describe, expect, it } from 'vitest';
import { ledigeTider, type LedighedInput } from '../src/shared/ledighed';
import { kbhTid, kbhTilUtc, plusDage, ugedag } from '../src/shared/tid';
import { validerKunde } from '../src/shared/validering';

// Tirsdag 3. november 2026
const DATO = '2026-11-03';
const basis = (over: Partial<LedighedInput> = {}): LedighedInput => ({
  dato: DATO,
  varighed: 30,
  buffer: 0,
  regler: { interval: 30, kapacitet: 1, minVarselTimer: 0, maxDageFrem: 60, sletEfterMaaneder: 12 },
  aabningstider: { '2': [{ fra: 600, til: 720 }] },
  lukkeperioder: [],
  blokeringer: [],
  optaget: [],
  tidligst: { dato: '2026-11-01', min: 0 },
  senesteDato: '2026-12-31',
  ...over,
});

describe('ledige tider', () => {
  it('følger åbningstiden', () => {
    expect(ledigeTider(basis())).toEqual([600, 630, 660, 690]);
  });
  it('er lukket på dage uden åbningstid', () => {
    expect(ledigeTider(basis({ dato: '2026-11-02' }))).toEqual([]);
  });
  it('forhindrer dobbeltbooking', () => {
    const optaget = [{ id: 'a', dato: DATO, start: 630, slut: 660, buffer: 0 }];
    expect(ledigeTider(basis({ optaget }))).toEqual([600, 660, 690]);
  });
  it('respekterer buffertid efter aftaler', () => {
    const optaget = [{ id: 'a', dato: DATO, start: 630, slut: 660, buffer: 15 }];
    // 660 er optaget af bufferen (indtil 675)
    expect(ledigeTider(basis({ optaget }))).toEqual([600, 690]);
    // En ny aftales buffer må ikke ramme en eksisterende aftale
    expect(ledigeTider(basis({ buffer: 15, optaget: [{ dato: DATO, start: 660, slut: 690, buffer: 0 }] }))).toEqual([600, 690]);
  });
  it('tillader flere samtidige ved højere kapacitet', () => {
    const optaget = [{ id: 'a', dato: DATO, start: 630, slut: 660, buffer: 0 }];
    expect(ledigeTider(basis({ optaget, regler: { ...basis().regler, kapacitet: 2 } }))).toEqual([600, 630, 660, 690]);
  });
  it('ignorerer bookingen selv ved flytning', () => {
    const optaget = [{ id: 'a', dato: DATO, start: 630, slut: 660, buffer: 0 }];
    expect(ledigeTider(basis({ optaget, ignorerId: 'a' }))).toContain(630);
  });
  it('respekterer blokeringer og lukkeperioder', () => {
    expect(ledigeTider(basis({ blokeringer: [{ id: 'b', dato: DATO, fra: 640, til: 700, note: '' }] }))).toEqual([600]);
    expect(ledigeTider(basis({ lukkeperioder: [{ id: 'l', fra: '2026-11-01', til: '2026-11-05', note: '' }] }))).toEqual([]);
  });
  it('respekterer minimumsvarsel og seneste dato', () => {
    expect(ledigeTider(basis({ tidligst: { dato: DATO, min: 650 } }))).toEqual([660, 690]);
    expect(ledigeTider(basis({ senesteDato: '2026-11-02' }))).toEqual([]);
  });
  it('kræver at besøget slutter inden lukketid', () => {
    expect(ledigeTider(basis({ varighed: 45 }))).toEqual([600, 630, 660]);
  });
});

describe('dansk tid', () => {
  it('håndterer sommertid og vintertid', () => {
    expect(kbhTilUtc('2026-07-01', 600).toISOString()).toBe('2026-07-01T08:00:00.000Z');
    expect(kbhTilUtc('2026-11-03', 600).toISOString()).toBe('2026-11-03T09:00:00.000Z');
    // Dagen hvor sommertiden slutter (25. oktober 2026) og begynder (29. marts 2026)
    expect(kbhTilUtc('2026-10-25', 600).toISOString()).toBe('2026-10-25T09:00:00.000Z');
    expect(kbhTilUtc('2026-03-29', 600).toISOString()).toBe('2026-03-29T08:00:00.000Z');
  });
  it('omregner UTC til dansk dato og klokkeslæt', () => {
    expect(kbhTid(new Date('2026-12-31T23:30:00Z'))).toEqual({ dato: '2027-01-01', min: 30 });
    expect(kbhTid(new Date('2026-06-15T22:15:00Z'))).toEqual({ dato: '2026-06-16', min: 15 });
  });
  it('regner datoer og ugedage rigtigt', () => {
    expect(ugedag('2026-11-03')).toBe(2);
    expect(plusDage('2026-12-30', 3)).toBe('2027-01-02');
  });
});

describe('validering', () => {
  const ok = { navn: 'Anna Hansen', telefon: '12 34 56 78', email: 'anna@example.com', urtype: 'Lommeur', maerke: '', beskrivelse: 'Uret er stoppet' };
  it('godkender gyldige oplysninger', () => expect(validerKunde(ok)).toEqual({}));
  it('afviser ugyldige felter', () => {
    const f = validerKunde({ ...ok, telefon: '123', email: 'x@', urtype: 'Robot', beskrivelse: '' });
    expect(Object.keys(f).sort()).toEqual(['beskrivelse', 'email', 'telefon', 'urtype']);
  });
});
