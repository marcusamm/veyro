import { useEffect, useState } from 'react';
import { api } from '../api';
import { Ikon } from '../components/Ikon';
import { datoKort, kbhTid, klok, ugedagNavn, ugedag } from '../../shared/tid';
import type { Booking } from '../../shared/typer';
import { DemoMaerke, StatusPille, feltA, knapP, useAdmin } from './faelles';
import { NyAftale } from './NyAftale';

const VISNINGER = [
  { id: 'anmodninger', tekst: 'Anmodninger' },
  { id: 'kommende', tekst: 'Kommende' },
  { id: 'tidligere', tekst: 'Tidligere' },
  { id: 'alle', tekst: 'Alle' },
];

export function BookingRaekke({ b }: { b: Booking }) {
  const { aabnBooking } = useAdmin();
  return (
    <button type="button" onClick={() => aabnBooking(b.id)} className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-creme/60 sm:px-5">
      <div className="w-14 shrink-0 text-center">
        <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-messing">{ugedagNavn(ugedag(b.dato)).slice(0, 3)}</p>
        <p className="font-serif text-[1.5rem] leading-none text-groen">{Number(b.dato.slice(8))}</p>
        <p className="text-[0.72rem] text-graa">{datoKort(b.dato).split(' ')[1]}</p>
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold tabular-nums">{klok(b.start)}</span>
          <span className="truncate font-semibold">{b.navn}</span>
          {b.kilde === 'demo' && <DemoMaerke />}
        </p>
        <p className="truncate text-[0.9rem] text-graa">{b.ydelseNavn}{b.maerke ? ` · ${b.maerke}` : ''} · {b.beskrivelse}</p>
      </div>
      <div className="hidden shrink-0 sm:block"><StatusPille status={b.status} /></div>
      <Ikon navn="pil" className="h-4 w-4 shrink-0 text-graa" />
    </button>
  );
}

export function Liste() {
  const { opdatering } = useAdmin();
  const [visning, setVisning] = useState('anmodninger');
  const [q, setQ] = useState('');
  const [liste, setListe] = useState<Booking[] | null>(null);
  const [ny, setNy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams({ visning, q });
      api<{ bookinger: Booking[] }>(`/api/admin/bookinger?${p}`).then((d) => setListe(d.bookinger)).catch(() => setListe([]));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [visning, q, opdatering]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[2.2rem]">Bookinger</h1>
        <button type="button" className={knapP} onClick={() => setNy(true)}><Ikon navn="plus" className="h-4 w-4" strøg={2.2} /> Ny aftale</button>
      </div>
      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex gap-1 overflow-x-auto rounded-full border border-linje bg-white p-1" role="tablist">
          {VISNINGER.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={visning === v.id} onClick={() => setVisning(v.id)} className={`whitespace-nowrap rounded-full px-4 py-2 text-[0.92rem] font-semibold ${visning === v.id ? 'bg-groen text-creme' : 'text-graa hover:bg-sand'}`}>
              {v.tekst}
            </button>
          ))}
        </div>
        <div className="relative flex-1 lg:max-w-sm lg:ml-auto">
          <Ikon navn="lup" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-graa" />
          <input type="search" className={`${feltA} !pl-10`} placeholder="Søg navn, telefon, reference …" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Søg i bookinger" />
        </div>
      </div>
      <div className="mt-5 overflow-hidden rounded-2xl border border-linje bg-white">
        {liste === null ? (
          <p className="p-6 text-graa">Henter …</p>
        ) : liste.length === 0 ? (
          <p className="p-8 text-center text-graa">Ingen bookinger her.</p>
        ) : (
          <ul className="divide-y divide-linje">
            {liste.map((b) => <li key={b.id}><BookingRaekke b={b} /></li>)}
          </ul>
        )}
      </div>
      {ny && <NyAftale dato={kbhTid().dato} onLuk={() => setNy(false)} />}
    </div>
  );
}
