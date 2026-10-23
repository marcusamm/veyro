import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { Ikon } from '../components/Ikon';
import { datoLang, plusDage } from '../../shared/tid';
import type { Booking } from '../../shared/typer';
import { Panel, useAdmin } from './faelles';
import { BookingRaekke } from './Liste';

interface Tal {
  idag: string;
  anmodninger: number;
  iDag: number;
  kommende7: number;
  ulaesteBeskeder: number;
  uafsluttede: number;
}

export function Oversigt() {
  const { opdatering } = useAdmin();
  const [tal, setTal] = useState<Tal | null>(null);
  const [anmodninger, setAnmodninger] = useState<Booking[]>([]);
  const [kommende, setKommende] = useState<Booking[]>([]);

  useEffect(() => {
    api<Tal>('/api/admin/oversigt').then((t) => {
      setTal(t);
      api<{ bookinger: Booking[] }>(`/api/admin/bookinger?visning=kommende&til=${plusDage(t.idag, 6)}`).then((d) => setKommende(d.bookinger.filter((b) => b.status === 'bekraeftet')));
    });
    api<{ bookinger: Booking[] }>('/api/admin/bookinger?visning=anmodninger').then((d) => setAnmodninger(d.bookinger));
  }, [opdatering]);

  const kort = [
    { tekst: 'Afventer godkendelse', tal: tal?.anmodninger, til: '/admin/bookinger', fremhaev: !!tal?.anmodninger },
    { tekst: 'Aftaler i dag', tal: tal?.iDag, til: '/admin/kalender' },
    { tekst: 'Næste 7 dage', tal: tal?.kommende7, til: '/admin/kalender' },
    { tekst: 'Ulæste beskeder', tal: tal?.ulaesteBeskeder, til: '/admin/beskeder' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[0.9rem] font-semibold text-messing first-letter:uppercase">{tal ? datoLang(tal.idag) : ''}</p>
        <h1 className="text-[2.3rem]">Goddag, Mette</h1>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kort.map((k) => (
          <Link key={k.tekst} to={k.til} className={`rounded-2xl border p-4 transition-colors sm:p-5 ${k.fremhaev ? 'border-[#e3cb9a] bg-[#fbf1dc] hover:bg-[#f8eacd]' : 'border-linje bg-white hover:border-groen/40'}`}>
            <p className="font-serif text-[2.6rem] leading-none text-groen">{k.tal ?? '–'}</p>
            <p className="mt-2 text-[0.92rem] font-semibold text-graa">{k.tekst}</p>
          </Link>
        ))}
      </div>
      {!!tal?.uafsluttede && (
        <p className="flex items-center gap-2 rounded-xl border border-linje bg-white px-4 py-3 text-[0.93rem]">
          <Ikon navn="info" className="h-5 w-5 shrink-0 text-messing" /> {tal.uafsluttede} tidligere aftale(r) står stadig som bekræftet. Markér dem som gennemført under Bookinger → Tidligere.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel titel={`Anmodninger (${anmodninger.length})`} handling={<Link to="/admin/bookinger" className="text-[0.9rem] font-semibold text-groen">Se alle</Link>} className="overflow-hidden [&>div:last-child]:p-0">
          {anmodninger.length === 0 ? <p className="p-5 text-graa">Ingen anmodninger venter.</p> : (
            <ul className="divide-y divide-linje">{anmodninger.slice(0, 6).map((b) => <li key={b.id}><BookingRaekke b={b} /></li>)}</ul>
          )}
        </Panel>
        <Panel titel="Bekræftede aftaler de næste 7 dage" handling={<Link to="/admin/kalender" className="text-[0.9rem] font-semibold text-groen">Kalender</Link>} className="overflow-hidden [&>div:last-child]:p-0">
          {kommende.length === 0 ? <p className="p-5 text-graa">Ingen bekræftede aftaler.</p> : (
            <ul className="divide-y divide-linje">{kommende.slice(0, 8).map((b) => <li key={b.id}><BookingRaekke b={b} /></li>)}</ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
