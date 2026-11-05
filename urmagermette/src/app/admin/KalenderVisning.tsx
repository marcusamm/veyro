// Kalender med dag-, uge- og månedsvisning.
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Ikon } from '../components/Ikon';
import { datoLang, kbhTid, klok, maanedNavn, plusDage, ugeStart, ugedag, ugenummer } from '../../shared/tid';
import type { Aabningstider, Blokering, Booking, Lukkeperiode } from '../../shared/typer';
import { DemoMaerke, STATUS_STIL, knapP, knapS, useAdmin } from './faelles';
import { NyAftale } from './NyAftale';

type Tilstand = 'dag' | 'uge' | 'maaned';

interface Data {
  bookinger: Booking[];
  blokeringer: Blokering[];
  lukkeperioder: Lukkeperiode[];
  aabningstider: Aabningstider;
}

const UGEDAGE = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
const PX_PR_MIN = 1.3;

function periode(t: Tilstand, d: string): [string, string] {
  if (t === 'dag') return [d, d];
  if (t === 'uge') { const s = ugeStart(d); return [s, plusDage(s, 6)]; }
  const f = `${d.slice(0, 7)}-01`;
  const s = ugeStart(f);
  return [s, plusDage(s, 41)];
}

function BookingBlok({ b, top, hoejde }: { b: Booking; top: number; hoejde: number }) {
  const { aabnBooking } = useAdmin();
  return (
    <button type="button" onClick={() => aabnBooking(b.id)} style={{ top, height: Math.max(hoejde, 26) }}
      className={`absolute inset-x-1 overflow-hidden rounded-lg border-l-4 px-2 py-1 text-left text-[0.8rem] leading-tight shadow-sm transition-shadow hover:z-10 hover:shadow-md ${STATUS_STIL[b.status].blok}`}>
      <span className="font-semibold tabular-nums">{klok(b.start)}</span> <span className="font-semibold">{b.navn}</span>
      {hoejde > 34 && <span className="block truncate opacity-80">{b.ydelseNavn}</span>}
    </button>
  );
}

function Tidslinje({ dage, data, fra, til, visAflyste }: { dage: string[]; data: Data; fra: number; til: number; visAflyste: boolean }) {
  const timer: number[] = [];
  for (let t = Math.floor(fra / 60) * 60; t <= til; t += 60) timer.push(t);
  const hoejde = (til - fra) * PX_PR_MIN;
  const idag = kbhTid();
  return (
    <div className="overflow-x-auto">
      <div className="flex min-w-full" style={{ minWidth: dage.length > 1 ? 760 : undefined }}>
        <div className="w-14 shrink-0 pt-10">
          <div className="relative" style={{ height: hoejde }}>
            {timer.map((t) => <span key={t} className="absolute -translate-y-1/2 pr-2 text-right text-[0.75rem] tabular-nums text-graa" style={{ top: (t - fra) * PX_PR_MIN, right: 0 }}>{klok(t)}</span>)}
          </div>
        </div>
        {dage.map((d) => {
          const aab = data.aabningstider[String(ugedag(d))] ?? [];
          const lukket = data.lukkeperioder.find((p) => p.fra <= d && d <= p.til);
          const bk = data.bookinger.filter((b) => b.dato === d && (visAflyste || (b.status !== 'aflyst' && b.status !== 'afvist')));
          return (
            <div key={d} className="min-w-0 flex-1 border-l border-linje">
              <div className={`sticky top-0 flex h-10 items-center justify-center gap-1.5 border-b border-linje text-[0.85rem] font-semibold ${d === idag.dato ? 'text-groen' : 'text-graa'}`}>
                {dage.length > 1 && <>{UGEDAGE[(ugedag(d) + 6) % 7]} <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${d === idag.dato ? 'bg-groen text-creme' : ''}`}>{Number(d.slice(8))}</span></>}
                {dage.length === 1 && (lukket ? <span className="text-fejl">Lukket: {lukket.note}</span> : aab.length ? `Åbent ${aab.map((a) => `${klok(a.fra)}–${klok(a.til)}`).join(', ')}` : 'Lukket')}
              </div>
              <div className="relative bg-[#ebe6da]" style={{ height: hoejde }}>
                {!lukket && aab.map((a, i) => <div key={i} className="absolute inset-x-0 bg-white" style={{ top: (a.fra - fra) * PX_PR_MIN, height: (a.til - a.fra) * PX_PR_MIN }} />)}
                {timer.map((t) => <div key={t} className="absolute inset-x-0 border-t border-linje/70" style={{ top: (t - fra) * PX_PR_MIN }} />)}
                {lukket && dage.length > 1 && <div className="absolute inset-x-1 top-2 rounded-md bg-fejl/10 px-1.5 py-1 text-center text-[0.72rem] font-semibold text-fejl">{lukket.note}</div>}
                {data.blokeringer.filter((b) => b.dato === d).map((b) => (
                  <div key={b.id} className="absolute inset-x-0 bg-[repeating-linear-gradient(135deg,#e7e1d3_0,#e7e1d3_6px,#f3efe6_6px,#f3efe6_12px)] px-2 py-1 text-[0.72rem] font-semibold text-graa" style={{ top: (b.fra - fra) * PX_PR_MIN, height: (b.til - b.fra) * PX_PR_MIN }}>{b.note}</div>
                ))}
                {d === idag.dato && idag.min >= fra && idag.min <= til && <div className="absolute inset-x-0 z-[5] border-t-2 border-fejl/70" style={{ top: (idag.min - fra) * PX_PR_MIN }} />}
                {bk.map((b) => <BookingBlok key={b.id} b={b} top={(b.start - fra) * PX_PR_MIN} hoejde={(b.slut - b.start) * PX_PR_MIN} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Agenda({ dage, data, visAflyste }: { dage: string[]; data: Data; visAflyste: boolean }) {
  const { aabnBooking } = useAdmin();
  return (
    <ul className="divide-y divide-linje">
      {dage.map((d) => {
        const bk = data.bookinger.filter((b) => b.dato === d && (visAflyste || (b.status !== 'aflyst' && b.status !== 'afvist')));
        const lukket = data.lukkeperioder.find((p) => p.fra <= d && d <= p.til);
        return (
          <li key={d} className="px-4 py-3">
            <p className="text-[0.85rem] font-semibold text-messing first-letter:uppercase">{datoLang(d)}</p>
            {lukket && <p className="text-[0.9rem] text-fejl">Lukket: {lukket.note}</p>}
            {bk.length === 0 && !lukket && <p className="text-[0.9rem] text-graa">Ingen aftaler</p>}
            <ul className="mt-1.5 space-y-1.5">
              {bk.map((b) => (
                <li key={b.id}>
                  <button type="button" onClick={() => aabnBooking(b.id)} className={`w-full rounded-lg border-l-4 px-3 py-2 text-left text-[0.92rem] ${STATUS_STIL[b.status].blok}`}>
                    <span className="font-semibold tabular-nums">{klok(b.start)}–{klok(b.slut)}</span> · <span className="font-semibold">{b.navn}</span> {b.kilde === 'demo' && <DemoMaerke />}
                    <span className="block text-[0.85rem] opacity-80">{b.ydelseNavn}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function Maaned({ start, maaned, data, vaelg, visAflyste }: { start: string; maaned: string; data: Data; vaelg: (d: string) => void; visAflyste: boolean }) {
  const idag = kbhTid().dato;
  return (
    <div>
      <div className="grid grid-cols-7 border-b border-linje text-center text-[0.8rem] font-semibold uppercase tracking-wider text-graa">
        {UGEDAGE.map((u) => <div key={u} className="py-2">{u}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: 42 }, (_, i) => plusDage(start, i)).map((d) => {
          const bk = data.bookinger.filter((b) => b.dato === d && (visAflyste || (b.status !== 'aflyst' && b.status !== 'afvist')));
          const anm = bk.filter((b) => b.status === 'anmodet').length;
          const lukket = data.lukkeperioder.find((p) => p.fra <= d && d <= p.til);
          const udenfor = d.slice(0, 7) !== maaned;
          return (
            <button key={d} type="button" onClick={() => vaelg(d)} className={`min-h-[4.5rem] border-b border-r border-linje p-1.5 text-left align-top transition-colors hover:bg-creme sm:min-h-[6.5rem] sm:p-2 ${udenfor ? 'bg-[#f6f3ec] text-graa/60' : 'bg-white'} ${lukket ? 'bg-[repeating-linear-gradient(135deg,#fff_0,#fff_8px,#f5ece9_8px,#f5ece9_16px)]' : ''}`}>
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-[0.88rem] font-semibold ${d === idag ? 'bg-groen text-creme' : ''}`}>{Number(d.slice(8))}</span>
              {bk.length > 0 && (
                <span className="mt-1 block space-y-0.5">
                  {bk.slice(0, 3).map((b) => (
                    <span key={b.id} className={`hidden truncate rounded px-1.5 py-0.5 text-[0.72rem] font-semibold sm:block ${STATUS_STIL[b.status].pille}`}>{klok(b.start)} {b.navn}</span>
                  ))}
                  {bk.length > 3 && <span className="hidden text-[0.72rem] text-graa sm:block">+{bk.length - 3} mere</span>}
                  <span className="flex gap-1 sm:hidden">
                    <span className="rounded-full bg-groen px-1.5 text-[0.7rem] font-bold text-creme">{bk.length}</span>
                    {anm > 0 && <span className="rounded-full bg-messing px-1.5 text-[0.7rem] font-bold text-white">{anm}</span>}
                  </span>
                </span>
              )}
              {lukket && !udenfor && <span className="mt-1 hidden truncate text-[0.7rem] font-semibold text-fejl sm:block">{lukket.note}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function KalenderVisning() {
  const { opdatering } = useAdmin();
  const [tilstand, setTilstand] = useState<Tilstand>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'dag' : 'uge'));
  const [dato, setDato] = useState(kbhTid().dato);
  const [data, setData] = useState<Data | null>(null);
  const [visAflyste, setVisAflyste] = useState(false);
  const [ny, setNy] = useState(false);
  const [fra, til] = periode(tilstand, dato);

  useEffect(() => {
    api<Data>(`/api/admin/kalender?fra=${fra}&til=${til}`).then(setData).catch(() => setData(null));
  }, [fra, til, opdatering]);

  // Tidsakse ud fra åbningstider og aftaler
  const [aksFra, aksTil] = useMemo(() => {
    let a = 9 * 60;
    let z = 17 * 60;
    if (data) {
      const alle = Object.values(data.aabningstider).flat();
      if (alle.length) { a = Math.min(...alle.map((i) => i.fra)); z = Math.max(...alle.map((i) => i.til)); }
      for (const b of data.bookinger) { a = Math.min(a, b.start); z = Math.max(z, b.slut); }
    }
    return [Math.max(0, Math.floor(a / 60) * 60 - 60), Math.min(24 * 60, Math.ceil(z / 60) * 60 + 30)];
  }, [data]);

  const flyt = (n: number) => {
    if (tilstand === 'dag') setDato(plusDage(dato, n));
    else if (tilstand === 'uge') setDato(plusDage(dato, 7 * n));
    else { const [y, m] = dato.split('-').map(Number) as [number, number]; setDato(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10)); }
  };
  const [y, m] = dato.split('-').map(Number) as [number, number];
  const titel = tilstand === 'dag' ? datoLang(dato) : tilstand === 'uge' ? `Uge ${ugenummer(fra)} · ${Number(fra.slice(8))}. ${maanedNavn(Number(fra.slice(5, 7)) - 1).slice(0, 3)}. – ${Number(til.slice(8))}. ${maanedNavn(Number(til.slice(5, 7)) - 1).slice(0, 3)}.` : `${maanedNavn(m - 1)} ${y}`;
  const ugeDage = Array.from({ length: 7 }, (_, i) => plusDage(fra, i));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[2.2rem]">Kalender</h1>
        <button type="button" className={knapP} onClick={() => setNy(true)}><Ikon navn="plus" className="h-4 w-4" strøg={2.2} /> Ny aftale</button>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-linje bg-white p-1" role="tablist" aria-label="Visning">
          {(['dag', 'uge', 'maaned'] as Tilstand[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tilstand === t} onClick={() => setTilstand(t)} className={`rounded-full px-4 py-1.5 text-[0.9rem] font-semibold ${tilstand === t ? 'bg-groen text-creme' : 'text-graa hover:bg-sand'}`}>
              {t === 'dag' ? 'Dag' : t === 'uge' ? 'Uge' : 'Måned'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className={`${knapS} !h-10 !w-10 !px-0`} onClick={() => flyt(-1)} aria-label="Forrige"><Ikon navn="pilVenstre" className="h-4 w-4" /></button>
          <button type="button" className={knapS} onClick={() => setDato(kbhTid().dato)}>I dag</button>
          <button type="button" className={`${knapS} !h-10 !w-10 !px-0`} onClick={() => flyt(1)} aria-label="Næste"><Ikon navn="pil" className="h-4 w-4" /></button>
        </div>
        <p className="font-serif text-[1.45rem] text-groen first-letter:uppercase">{titel}</p>
        <label className="ml-auto flex items-center gap-2 text-[0.88rem] text-graa"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={visAflyste} onChange={(e) => setVisAflyste(e.target.checked)} /> Vis aflyste/afviste</label>
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-[0.8rem] text-graa">
        {(['anmodet', 'bekraeftet', 'gennemfoert'] as const).map((s) => <span key={s} className="flex items-center gap-1.5"><span className={`h-3 w-3 rounded-sm border-l-4 ${STATUS_STIL[s].blok}`} />{s === 'anmodet' ? 'Afventer' : s === 'bekraeftet' ? 'Bekræftet' : 'Gennemført'}</span>)}
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-[repeating-linear-gradient(135deg,#d8d0be_0,#d8d0be_2px,#f3efe6_2px,#f3efe6_4px)]" />Blokeret</span>
      </div>
      <div className="mt-4 overflow-hidden rounded-2xl border border-linje bg-white">
        {!data ? <p className="p-6 text-graa">Henter …</p> : tilstand === 'maaned' ? (
          <Maaned start={fra} maaned={dato.slice(0, 7)} data={data} visAflyste={visAflyste} vaelg={(d) => { setDato(d); setTilstand('dag'); }} />
        ) : tilstand === 'dag' ? (
          <Tidslinje dage={[dato]} data={data} fra={aksFra} til={aksTil} visAflyste={visAflyste} />
        ) : (
          <>
            <div className="hidden md:block"><Tidslinje dage={ugeDage} data={data} fra={aksFra} til={aksTil} visAflyste={visAflyste} /></div>
            <div className="md:hidden"><Agenda dage={ugeDage} data={data} visAflyste={visAflyste} /></div>
          </>
        )}
      </div>
      {ny && <NyAftale dato={dato} onLuk={() => setNy(false)} />}
    </div>
  );
}
