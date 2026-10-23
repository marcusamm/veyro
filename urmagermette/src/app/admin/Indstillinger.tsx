// Åbningstider, ferie, blokerede tider, ydelser, bookingregler og adgangskode.
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFejl } from '../api';
import { Ikon } from '../components/Ikon';
import { kbhTid, klok, klokKolon, tilMin, ugedagNavn } from '../../shared/tid';
import type { Aabningstider, Blokering, BookingRegler, Lukkeperiode, Ydelse } from '../../shared/typer';
import { Panel, feltA, knapFare, knapP, knapS, useAdmin } from './faelles';

interface Data {
  aabningstider: Aabningstider;
  regler: BookingRegler;
  ydelser: Ydelse[];
  lukkeperioder: Lukkeperiode[];
  blokeringer: Blokering[];
}

const DAG_RAEKKEFOELGE = [1, 2, 3, 4, 5, 6, 0];

function datoDK(d: string): string {
  return d.split('-').reverse().join('.');
}

function useHandling() {
  const { besked, opdater } = useAdmin();
  const [fejl, setFejl] = useState('');
  const [arbejder, setArbejder] = useState(false);
  async function koer<T>(fn: () => Promise<T>, ok: string): Promise<T | undefined> {
    setFejl('');
    setArbejder(true);
    try {
      const r = await fn();
      besked(ok);
      opdater();
      return r;
    } catch (e) {
      setFejl(e instanceof ApiFejl ? e.message : 'Der opstod en fejl.');
    } finally {
      setArbejder(false);
    }
  }
  return { fejl, arbejder, koer };
}

function Fejl({ tekst }: { tekst: string }) {
  return tekst ? <p className="mt-3 rounded-xl bg-fejl/10 px-4 py-2.5 text-[0.93rem] font-medium text-fejl" role="alert">{tekst}</p> : null;
}

function Aabning({ start }: { start: Aabningstider }) {
  const [a, setA] = useState(() => Object.fromEntries(Object.entries(start).map(([d, l]) => [d, l.map((i) => ({ fra: klokKolon(i.fra), til: klokKolon(i.til) }))])) as Record<string, { fra: string; til: string }[]>);
  const { fejl, arbejder, koer } = useHandling();
  const [lokalFejl, setLokalFejl] = useState('');
  function gem() {
    const ud: Aabningstider = {};
    for (const [d, l] of Object.entries(a)) {
      ud[d] = [];
      for (const i of l) {
        const fra = tilMin(i.fra);
        const til = tilMin(i.til);
        if (fra === null || til === null || fra >= til) return setLokalFejl(`Tjek tiderne for ${ugedagNavn(Number(d))}: "fra" skal være før "til".`);
        ud[d].push({ fra, til });
      }
    }
    setLokalFejl('');
    koer(() => api('/api/admin/aabningstider', { method: 'PUT', json: ud }), 'Åbningstiderne er gemt');
  }
  return (
    <Panel titel="Åbningstider" handling={<button type="button" className={knapP} disabled={arbejder} onClick={gem}>Gem</button>}>
      <p className="mb-4 text-[0.9rem] text-graa">Kunder kan kun bestille tid inden for åbningstiden. Tilføj flere tidsrum, hvis du holder pause midt på dagen.</p>
      <ul className="divide-y divide-linje">
        {DAG_RAEKKEFOELGE.map((d) => {
          const l = a[String(d)] ?? [];
          return (
            <li key={d} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
              <div className="flex w-36 items-center justify-between gap-2 pt-2 sm:justify-start">
                <span className="font-semibold capitalize">{ugedagNavn(d)}</span>
                {l.length === 0 && <span className="text-[0.85rem] text-graa">Lukket</span>}
              </div>
              <div className="flex flex-1 flex-col gap-2">
                {l.map((i, n) => (
                  <div key={n} className="flex items-center gap-2">
                    <input type="time" className={`${feltA} w-[7.2rem] sm:w-32`} value={i.fra} aria-label={`${ugedagNavn(d)} fra`} onChange={(e) => setA({ ...a, [d]: l.map((x, k) => (k === n ? { ...x, fra: e.target.value } : x)) })} />
                    <span className="text-graa">–</span>
                    <input type="time" className={`${feltA} w-[7.2rem] sm:w-32`} value={i.til} aria-label={`${ugedagNavn(d)} til`} onChange={(e) => setA({ ...a, [d]: l.map((x, k) => (k === n ? { ...x, til: e.target.value } : x)) })} />
                    <button type="button" className="inline-flex h-10 w-10 items-center justify-center rounded-full text-graa hover:bg-sand hover:text-fejl" aria-label="Fjern tidsrum" onClick={() => setA({ ...a, [d]: l.filter((_, k) => k !== n) })}><Ikon navn="luk" className="h-4 w-4" /></button>
                  </div>
                ))}
                <button type="button" className="self-start text-[0.88rem] font-semibold text-groen hover:underline" onClick={() => setA({ ...a, [d]: [...l, l.length ? { fra: '13:00', til: '16:00' } : { fra: '10:00', til: '17:00' }] })}>
                  + {l.length ? 'Tilføj tidsrum' : 'Åbn denne dag'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <Fejl tekst={lokalFejl || fejl} />
    </Panel>
  );
}

function Lukkeperioder({ start }: { start: Lukkeperiode[] }) {
  const [liste, setListe] = useState(start);
  const [v, setV] = useState({ fra: '', til: '', note: '' });
  const [advarsel, setAdvarsel] = useState('');
  const { fejl, arbejder, koer } = useHandling();
  async function tilfoej(e: FormEvent) {
    e.preventDefault();
    const r = await koer(() => api<{ lukkeperioder: Lukkeperiode[]; konflikter: number }>('/api/admin/lukkeperioder', { method: 'POST', json: { ...v, til: v.til || v.fra } }), 'Lukkeperioden er tilføjet');
    if (r) {
      setListe(r.lukkeperioder);
      setV({ fra: '', til: '', note: '' });
      setAdvarsel(r.konflikter ? `Bemærk: ${r.konflikter} aftale(r) ligger allerede i perioden. Flyt eller aflys dem under Bookinger.` : '');
    }
  }
  const idag = kbhTid().dato;
  return (
    <Panel titel="Ferie og lukkedage">
      <p className="mb-4 text-[0.9rem] text-graa">I perioderne kan der ikke bestilles tid online.</p>
      <ul className="mb-4 divide-y divide-linje">
        {liste.length === 0 && <li className="py-2 text-graa">Ingen lukkeperioder.</li>}
        {liste.map((p) => (
          <li key={p.id} className={`flex items-center justify-between gap-3 py-2.5 ${p.til < idag ? 'opacity-50' : ''}`}>
            <span><span className="font-semibold">{datoDK(p.fra)}{p.til !== p.fra ? ` – ${datoDK(p.til)}` : ''}</span> · {p.note}</span>
            <button type="button" className={knapFare} disabled={arbejder} onClick={async () => { const r = await koer(() => api<{ lukkeperioder: Lukkeperiode[] }>(`/api/admin/lukkeperioder/${p.id}`, { method: 'DELETE' }), 'Lukkeperioden er fjernet'); if (r) setListe(r.lukkeperioder); }}>Fjern</button>
          </li>
        ))}
      </ul>
      <form onSubmit={tilfoej} className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto] sm:items-end">
        <div><label className="etiket" htmlFor="lp-fra">Fra</label><input id="lp-fra" type="date" className={feltA} value={v.fra} onChange={(e) => setV({ ...v, fra: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="lp-til">Til og med</label><input id="lp-til" type="date" className={feltA} value={v.til} min={v.fra} onChange={(e) => setV({ ...v, til: e.target.value })} /></div>
        <div><label className="etiket" htmlFor="lp-note">Note</label><input id="lp-note" className={feltA} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Fx Sommerferie" /></div>
        <button type="submit" className={knapP} disabled={arbejder}>Tilføj</button>
      </form>
      {advarsel && <p className="mt-3 rounded-xl bg-[#fbf1dc] px-4 py-2.5 text-[0.93rem] text-[#6b5229]">{advarsel}</p>}
      <Fejl tekst={fejl} />
    </Panel>
  );
}

function Blokeringer({ start }: { start: Blokering[] }) {
  const [liste, setListe] = useState(start);
  const [v, setV] = useState({ dato: '', fra: '12:00', til: '13:00', note: '' });
  const [advarsel, setAdvarsel] = useState('');
  const { fejl, arbejder, koer } = useHandling();
  async function tilfoej(e: FormEvent) {
    e.preventDefault();
    const fra = tilMin(v.fra);
    const til = tilMin(v.til);
    const r = await koer(() => api<{ blokeringer: Blokering[]; konflikter: number }>('/api/admin/blokeringer', { method: 'POST', json: { dato: v.dato, fra, til, note: v.note } }), 'Tidsrummet er blokeret');
    if (r) {
      setListe(r.blokeringer);
      setAdvarsel(r.konflikter ? `Bemærk: ${r.konflikter} aftale(r) ligger allerede i tidsrummet.` : '');
    }
  }
  return (
    <Panel titel="Blokerede tider">
      <p className="mb-4 text-[0.9rem] text-graa">Bloker enkelte tidsrum, fx et ærinde eller en aftale uden for værkstedet.</p>
      <ul className="mb-4 divide-y divide-linje">
        {liste.length === 0 && <li className="py-2 text-graa">Ingen kommende blokeringer.</li>}
        {liste.map((b) => (
          <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
            <span><span className="font-semibold">{datoDK(b.dato)} kl. {klok(b.fra)}–{klok(b.til)}</span> · {b.note}</span>
            <button type="button" className={knapFare} disabled={arbejder} onClick={async () => { const r = await koer(() => api<{ blokeringer: Blokering[] }>(`/api/admin/blokeringer/${b.id}`, { method: 'DELETE' }), 'Blokeringen er fjernet'); if (r) setListe(r.blokeringer); }}>Fjern</button>
          </li>
        ))}
      </ul>
      <form onSubmit={tilfoej} className="grid gap-2 sm:grid-cols-[1.2fr_0.8fr_0.8fr_1.2fr_auto] sm:items-end">
        <div><label className="etiket" htmlFor="bl-dato">Dato</label><input id="bl-dato" type="date" className={feltA} value={v.dato} onChange={(e) => setV({ ...v, dato: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="bl-fra">Fra</label><input id="bl-fra" type="time" className={feltA} value={v.fra} onChange={(e) => setV({ ...v, fra: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="bl-til">Til</label><input id="bl-til" type="time" className={feltA} value={v.til} onChange={(e) => setV({ ...v, til: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="bl-note">Note</label><input id="bl-note" className={feltA} value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Fx Tandlæge" /></div>
        <button type="submit" className={knapP} disabled={arbejder}>Bloker</button>
      </form>
      {advarsel && <p className="mt-3 rounded-xl bg-[#fbf1dc] px-4 py-2.5 text-[0.93rem] text-[#6b5229]">{advarsel}</p>}
      <Fejl tekst={fejl} />
    </Panel>
  );
}

function Ydelser({ start }: { start: Ydelse[] }) {
  const [liste, setListe] = useState(start);
  const { fejl, arbejder, koer } = useHandling();
  const saet = (i: number, felt: Partial<Ydelse>) => setListe(liste.map((y, k) => (k === i ? { ...y, ...felt } : y)));
  const flyt = (i: number, n: number) => {
    const ny = [...liste];
    const [x] = ny.splice(i, 1);
    ny.splice(i + n, 0, x!);
    setListe(ny);
  };
  return (
    <Panel titel="Servicetyper og tidsintervaller" handling={<button type="button" className={knapP} disabled={arbejder} onClick={async () => { const r = await koer(() => api<{ ydelser: Ydelse[] }>('/api/admin/ydelser', { method: 'PUT', json: { ydelser: liste } }), 'Ydelserne er gemt'); if (r) setListe(r.ydelser); }}>Gem</button>}>
      <p className="mb-4 text-[0.9rem] text-graa"><strong>Varighed</strong> er længden af selve besøget. <strong>Buffer</strong> er tid efter besøget, før næste kunde kan komme.</p>
      <ul className="space-y-3">
        {liste.map((y, i) => (
          <li key={y.id} className={`rounded-xl border border-linje p-3 ${y.aktiv ? 'bg-white' : 'bg-[#f6f3ec]'}`}>
            <div className="grid gap-2 sm:grid-cols-[1.3fr_2fr]">
              <input className={feltA} value={y.navn} onChange={(e) => saet(i, { navn: e.target.value })} aria-label="Navn" />
              <input className={feltA} value={y.beskrivelse} onChange={(e) => saet(i, { beskrivelse: e.target.value })} aria-label="Beskrivelse" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-[0.88rem]">Varighed <input type="number" min={5} max={240} step={5} className={`${feltA} w-20`} value={y.varighed} onChange={(e) => saet(i, { varighed: Number(e.target.value) })} /> min</label>
              <label className="flex items-center gap-2 text-[0.88rem]">Buffer <input type="number" min={0} max={120} step={5} className={`${feltA} w-20`} value={y.buffer} onChange={(e) => saet(i, { buffer: Number(e.target.value) })} /> min</label>
              <label className="flex items-center gap-2 text-[0.88rem]"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={y.aktiv} onChange={(e) => saet(i, { aktiv: e.target.checked })} /> Kan bookes online</label>
              <span className="ml-auto flex gap-1">
                <button type="button" className={`${knapS} !h-9 !w-9 !px-0`} disabled={i === 0} onClick={() => flyt(i, -1)} aria-label="Flyt op">↑</button>
                <button type="button" className={`${knapS} !h-9 !w-9 !px-0`} disabled={i === liste.length - 1} onClick={() => flyt(i, 1)} aria-label="Flyt ned">↓</button>
                <button type="button" className={`${knapFare} !h-9 !w-9 !px-0`} onClick={() => setListe(liste.filter((_, k) => k !== i))} aria-label="Fjern"><Ikon navn="slet" className="h-4 w-4" /></button>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <button type="button" className={`${knapS} mt-3`} onClick={() => setListe([...liste, { id: '', navn: 'Ny ydelse', beskrivelse: '', varighed: 30, buffer: 10, aktiv: true, sortering: liste.length + 1 }])}>
        <Ikon navn="plus" className="h-4 w-4" /> Tilføj ydelse
      </button>
      <p className="mt-2 text-[0.82rem] text-graa">Ydelser, der allerede er brugt i bookinger, bliver deaktiveret i stedet for slettet.</p>
      <Fejl tekst={fejl} />
    </Panel>
  );
}

function Regler({ start }: { start: BookingRegler }) {
  const [r, setR] = useState(start);
  const { fejl, arbejder, koer } = useHandling();
  const felt = (k: keyof BookingRegler, tekst: string, enhed: string, hjaelp: string) => (
    <label className="block">
      <span className="etiket">{tekst}</span>
      <span className="flex items-center gap-2"><input type="number" className={`${feltA} w-28`} value={r[k]} onChange={(e) => setR({ ...r, [k]: Number(e.target.value) })} /> <span className="text-[0.9rem] text-graa">{enhed}</span></span>
      <span className="mt-1 block text-[0.82rem] text-graa">{hjaelp}</span>
    </label>
  );
  return (
    <Panel titel="Bookingregler" handling={<button type="button" className={knapP} disabled={arbejder} onClick={async () => { const x = await koer(() => api<{ regler: BookingRegler }>('/api/admin/regler', { method: 'PUT', json: r }), 'Reglerne er gemt'); if (x) setR(x.regler); }}>Gem</button>}>
      <div className="grid gap-5 sm:grid-cols-2">
        {felt('interval', 'Tidsinterval', 'minutter', 'Hvor ofte en tid kan starte, fx hver 30. minut.')}
        {felt('kapacitet', 'Kunder ad gangen', 'samtidige', 'Hvor mange kunder der kan have tid på samme tidspunkt.')}
        {felt('minVarselTimer', 'Mindste varsel', 'timer', 'Hvor længe før en tid kunder senest kan bestille.')}
        {felt('maxDageFrem', 'Book op til', 'dage frem', 'Hvor langt ud i fremtiden der kan bestilles.')}
        {felt('sletEfterMaaneder', 'Slet kundeoplysninger efter', 'måneder', 'Automatisk sletning efter aftalens dato (0 = aldrig). Skal fastsættes af ejeren.')}
      </div>
      <Fejl tekst={fejl} />
    </Panel>
  );
}

function Adgangskode() {
  const [v, setV] = useState({ nuvaerende: '', ny: '', gentag: '' });
  const { fejl, arbejder, koer } = useHandling();
  const [lokal, setLokal] = useState('');
  return (
    <Panel titel="Skift adgangskode">
      <form className="grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={async (e) => {
        e.preventDefault();
        if (v.ny !== v.gentag) return setLokal('De to nye adgangskoder er ikke ens.');
        setLokal('');
        const r = await koer(() => api('/api/admin/adgangskode', { method: 'POST', json: v }), 'Adgangskoden er skiftet');
        if (r) setV({ nuvaerende: '', ny: '', gentag: '' });
      }}>
        <div><label className="etiket" htmlFor="pw-1">Nuværende</label><input id="pw-1" type="password" autoComplete="current-password" className={feltA} value={v.nuvaerende} onChange={(e) => setV({ ...v, nuvaerende: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="pw-2">Ny (mindst 10 tegn)</label><input id="pw-2" type="password" autoComplete="new-password" minLength={10} className={feltA} value={v.ny} onChange={(e) => setV({ ...v, ny: e.target.value })} required /></div>
        <div><label className="etiket" htmlFor="pw-3">Gentag ny</label><input id="pw-3" type="password" autoComplete="new-password" className={feltA} value={v.gentag} onChange={(e) => setV({ ...v, gentag: e.target.value })} required /></div>
        <button type="submit" className={`${knapP} sm:col-span-3 sm:justify-self-start`} disabled={arbejder}>Skift adgangskode</button>
      </form>
      <Fejl tekst={lokal || fejl} />
    </Panel>
  );
}

export function Indstillinger() {
  const [d, setD] = useState<Data | null>(null);
  const [noegle, setNoegle] = useState(0);
  const { demo, besked, opdater } = useAdmin();
  useEffect(() => {
    api<Data>('/api/admin/indstillinger').then(setD);
  }, [noegle]);
  if (!d) return <p className="text-graa">Henter …</p>;
  return (
    <div className="space-y-6" key={noegle}>
      <h1 className="text-[2.2rem]">Indstillinger</h1>
      <div className="grid gap-6 xl:grid-cols-2">
        <Aabning start={d.aabningstider} />
        <div className="space-y-6">
          <Lukkeperioder start={d.lukkeperioder} />
          <Blokeringer start={d.blokeringer} />
        </div>
      </div>
      <Ydelser start={d.ydelser} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Regler start={d.regler} />
        <Adgangskode />
      </div>
      {demo && (
        <Panel titel="Demodata">
          <p className="text-[0.93rem] text-graa">Sletter alle bookinger, beskeder og indstillinger og lægger nye testbookinger ind fra i dag.</p>
          <button type="button" className={`${knapFare} mt-3`} onClick={async () => {
            if (!window.confirm('Nulstil alle demodata?')) return;
            await api('/api/admin/demo/nulstil', { method: 'POST' });
            besked('Demodata er nulstillet');
            opdater();
            setNoegle((n) => n + 1);
          }}>Nulstil demodata</button>
        </Panel>
      )}
    </div>
  );
}
