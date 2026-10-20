import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiFejl } from '../api';
import { Ikon } from '../components/Ikon';
import { datoLang, kbhTilUtc, klok } from '../../shared/tid';
import type { BookingStatus as Status } from '../../shared/typer';
import { VIRKSOMHED } from '../../shared/virksomhed';

interface Visning {
  ref: string;
  ydelseNavn: string;
  dato: string;
  start: number;
  slut: number;
  status: Status;
  statusTekst: string;
  navn: string;
  demo: boolean;
}

const FARVE: Record<Status, string> = {
  anmodet: 'bg-messing/15 text-[#7a5e30]',
  bekraeftet: 'bg-groen/10 text-groen',
  afvist: 'bg-fejl/10 text-fejl',
  aflyst: 'bg-fejl/10 text-fejl',
  gennemfoert: 'bg-groen/10 text-groen',
  udeblevet: 'bg-sand text-graa',
};

function ics(v: Visning): string {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//UrmagerMette//Booking//DA', 'BEGIN:VEVENT',
    `UID:${v.ref}@urmagermette`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(kbhTilUtc(v.dato, v.start))}`, `DTEND:${f(kbhTilUtc(v.dato, v.slut))}`,
    `SUMMARY:UrmagerMette: ${v.ydelseNavn}`, `LOCATION:${VIRKSOMHED.adresse}\\, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}`, `DESCRIPTION:Reference ${v.ref}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}

export default function BookingStatus() {
  const { token = '' } = useParams();
  const [v, setV] = useState<Visning | null>(null);
  const [fejl, setFejl] = useState('');
  const [bekraefter, setBekraefter] = useState(false);
  const [arbejder, setArbejder] = useState(false);

  useEffect(() => {
    document.title = 'Din booking · UrmagerMette';
    api<Visning>(`/api/booking/${encodeURIComponent(token)}`).then(setV).catch((e: Error) => setFejl(e.message));
  }, [token]);

  async function afbestil() {
    setArbejder(true);
    try {
      setV(await api<Visning>(`/api/booking/${encodeURIComponent(token)}/afbestil`, { method: 'POST' }));
      setBekraefter(false);
    } catch (e) {
      setFejl(e instanceof ApiFejl ? e.message : 'Der opstod en fejl.');
    } finally {
      setArbejder(false);
    }
  }

  const aktiv = v && (v.status === 'anmodet' || v.status === 'bekraeftet');

  return (
    <section className="bg-papir">
      <div className="beholder max-w-2xl py-14 sm:py-20">
        <p className="overtekst">Din booking</p>
        {!v && !fejl && <p className="mt-6 text-graa">Henter …</p>}
        {fejl && !v && (
          <div className="mt-6 rounded-2xl border border-linje bg-white p-8">
            <h1 className="text-[2.2rem]">Bookingen blev ikke fundet</h1>
            <p className="mt-3 text-graa">Tjek, at linket er skrevet rigtigt, eller ring på <a className="font-semibold text-groen" href={VIRKSOMHED.telefonLink}>{VIRKSOMHED.telefon}</a>.</p>
          </div>
        )}
        {v && (
          <div className="ind mt-4 rounded-[1.75rem] border border-linje bg-white p-6 sm:p-10">
            <h1 className="text-[2.3rem] sm:text-[2.8rem]">{v.ydelseNavn}</h1>
            <p className={`mt-4 inline-flex items-center gap-2 rounded-full px-4 py-1.5 font-semibold ${FARVE[v.status]}`}>
              <span className="h-2 w-2 rounded-full bg-current" /> {v.statusTekst}
            </p>
            <p className="mt-4 text-graa">
              {v.status === 'anmodet' && 'Din anmodning afventer godkendelse. Tiden er holdt til dig, men er ikke endeligt aftalt endnu.'}
              {v.status === 'bekraeftet' && 'Din tid er bekræftet. Vi glæder os til at se dig og dit ur.'}
              {v.status === 'afvist' && 'Desværre kunne den ønskede tid ikke lade sig gøre. Du er velkommen til at vælge en ny tid.'}
              {v.status === 'aflyst' && 'Tiden er aflyst.'}
              {v.status === 'gennemfoert' && 'Besøget er gennemført. Tak, fordi du valgte UrmagerMette.'}
            </p>
            <dl className="mt-7 space-y-3 border-t border-linje pt-6">
              <div className="flex gap-4"><dt className="w-28 shrink-0 text-graa">Dato</dt><dd className="font-semibold first-letter:uppercase">{datoLang(v.dato)}</dd></div>
              <div className="flex gap-4"><dt className="w-28 shrink-0 text-graa">Tidspunkt</dt><dd className="font-semibold">kl. {klok(v.start)}–{klok(v.slut)}</dd></div>
              <div className="flex gap-4"><dt className="w-28 shrink-0 text-graa">Adresse</dt><dd className="font-semibold">{VIRKSOMHED.adresse}, {VIRKSOMHED.postnr} {VIRKSOMHED.by}</dd></div>
              <div className="flex gap-4"><dt className="w-28 shrink-0 text-graa">Reference</dt><dd className="font-semibold">{v.ref}</dd></div>
            </dl>
            {fejl && <p className="mt-5 rounded-xl bg-fejl/10 px-4 py-3 font-medium text-fejl" role="alert">{fejl}</p>}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {v.status === 'bekraeftet' && (
                <a className="knap-primaer" download={`urmagermette-${v.ref}.ics`} href={`data:text/calendar;charset=utf-8,${encodeURIComponent(ics(v))}`}>
                  <Ikon navn="kalender" /> Føj til kalender
                </a>
              )}
              {aktiv && !bekraefter && <button type="button" className="knap-sekundaer" onClick={() => setBekraefter(true)}>Afbestil tiden</button>}
              {(v.status === 'afvist' || v.status === 'aflyst') && <Link to="/bestil" className="knap-primaer">Bestil en ny tid</Link>}
            </div>
            {bekraefter && (
              <div className="ind mt-5 rounded-2xl border border-fejl/30 bg-fejl/5 p-5">
                <p className="font-semibold">Vil du afbestille din tid {datoLang(v.dato)} kl. {klok(v.start)}?</p>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <button type="button" className="knap bg-fejl text-white hover:bg-[#7f2222]" onClick={afbestil} disabled={arbejder}>{arbejder ? 'Afbestiller …' : 'Ja, afbestil'}</button>
                  <button type="button" className="knap-sekundaer" onClick={() => setBekraefter(false)}>Behold tiden</button>
                </div>
              </div>
            )}
            {v.demo && <p className="mt-6 text-[0.9rem] text-graa">Demo: Ændringer gemmes i demoens bookingsystem, men der sendes ingen e-mails.</p>}
          </div>
        )}
      </div>
    </section>
  );
}
