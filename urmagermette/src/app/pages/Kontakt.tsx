import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiFejl } from '../api';
import { SideHero } from '../components/Dele';
import { Ikon } from '../components/Ikon';
import { Honeypot } from '../components/Spamfelter';
import { DEMO } from '../demo';
import { VIRKSOMHED } from '../../shared/virksomhed';

function Kort() {
  const [vis, setVis] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem('um-kort') === 'ja') setVis(true);
    } catch {
      /* ingen lagring */
    }
  }, []);
  const tillad = () => {
    setVis(true);
    try {
      localStorage.setItem('um-kort', 'ja');
    } catch {
      /* ingen lagring */
    }
  };
  return (
    <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-linje bg-sand sm:aspect-[16/10]">
      {vis ? (
        <iframe title={`Kort over ${VIRKSOMHED.adresse}, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}`} src={VIRKSOMHED.kortEmbed} className="h-full w-full border-0" loading="lazy" referrerPolicy="no-referrer-when-downgrade" allowFullScreen />
      ) : (
        <div className="flex h-full flex-col items-center justify-center bg-[radial-gradient(circle_at_center,#f1ebdd,#e6dcc7)] p-6 text-center">
          <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-groen text-creme shadow-lg">
            <Ikon navn="sted" className="h-7 w-7" />
          </span>
          <p className="mt-4 font-serif text-[1.5rem] text-groen">{VIRKSOMHED.adresse}, {VIRKSOMHED.postnr} {VIRKSOMHED.by}</p>
          <p className="mt-2 max-w-sm text-[0.92rem] text-graa">Kortet hentes fra Google Maps. Når du viser det, sendes oplysninger til Google.</p>
          <button type="button" onClick={tillad} className="knap-primaer mt-5 !min-h-[2.8rem]">Vis interaktivt kort</button>
        </div>
      )}
    </div>
  );
}

function Kontaktformular() {
  const [v, setV] = useState({ navn: '', email: '', telefon: '', besked: '', samtykke: false });
  const [firma, setFirma] = useState('');
  const [felter, setFelter] = useState<Record<string, string>>({});
  const [fejl, setFejl] = useState('');
  const [status, setStatus] = useState<'klar' | 'sender' | 'sendt'>('klar');
  const startet = useRef(0);
  useEffect(() => {
    startet.current = Date.now();
  }, []);
  const saet = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  async function send(e: FormEvent) {
    e.preventDefault();
    setFejl('');
    setStatus('sender');
    try {
      await api('/api/kontakt', { method: 'POST', json: { ...v, samtykke: v.samtykke ? 'ja' : '', firma, startet: startet.current } });
      setStatus('sendt');
    } catch (err) {
      setStatus('klar');
      if (err instanceof ApiFejl) {
        setFelter(err.felter);
        setFejl(err.message);
      }
    }
  }

  if (status === 'sendt') {
    return (
      <div className="ind rounded-2xl border border-groen/20 bg-white p-8" role="status">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-groen text-creme"><Ikon navn="tjek" strøg={2.2} /></span>
        <h3 className="mt-4 text-[1.9rem]">Tak for din besked</h3>
        <p className="mt-2 text-graa">
          {DEMO
            ? 'Beskeden er gemt i demoens administrationspanel. Dette er en demo, så beskeden sendes ikke videre til UrmagerMette, og du får ikke svar.'
            : 'Vi har modtaget din besked og vender tilbage hurtigst muligt.'}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={send} noValidate className="relative space-y-5">
      <Honeypot vaerdi={firma} saet={setFirma} />
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="k-navn" className="etiket">Navn</label>
          <input id="k-navn" className="felt" autoComplete="name" value={v.navn} onChange={saet('navn')} aria-invalid={!!felter.navn} aria-describedby={felter.navn ? 'k-navn-f' : undefined} />
          {felter.navn && <p id="k-navn-f" className="feltfejl">{felter.navn}</p>}
        </div>
        <div>
          <label htmlFor="k-tlf" className="etiket">Telefon <span className="font-normal text-graa">(valgfrit)</span></label>
          <input id="k-tlf" className="felt" type="tel" autoComplete="tel" value={v.telefon} onChange={saet('telefon')} />
        </div>
      </div>
      <div>
        <label htmlFor="k-email" className="etiket">E-mail</label>
        <input id="k-email" className="felt" type="email" autoComplete="email" value={v.email} onChange={saet('email')} aria-invalid={!!felter.email} aria-describedby={felter.email ? 'k-email-f' : undefined} />
        {felter.email && <p id="k-email-f" className="feltfejl">{felter.email}</p>}
      </div>
      <div>
        <label htmlFor="k-besked" className="etiket">Besked</label>
        <textarea id="k-besked" className="felt min-h-[9rem]" value={v.besked} onChange={saet('besked')} aria-invalid={!!felter.besked} aria-describedby={felter.besked ? 'k-besked-f' : undefined} />
        {felter.besked && <p id="k-besked-f" className="feltfejl">{felter.besked}</p>}
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-[0.97rem]">
        <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#1f3a2e]" checked={v.samtykke} onChange={(e) => setV({ ...v, samtykke: e.target.checked })} />
        <span>Jeg accepterer, at mine oplysninger gemmes, så jeg kan få svar. Læs <Link to="/privatliv" className="underline decoration-messing underline-offset-2">privatlivspolitikken</Link>.</span>
      </label>
      {felter.samtykke && <p className="feltfejl">{felter.samtykke}</p>}
      {fejl && <p className="rounded-xl bg-fejl/10 px-4 py-3 font-medium text-fejl" role="alert">{fejl}</p>}
      {DEMO && <p className="text-[0.9rem] text-graa">Demo: Beskeden gemmes kun i demoens administrationspanel og sendes ikke til UrmagerMette.</p>}
      <button type="submit" className="knap-primaer w-full sm:w-auto" disabled={status === 'sender'}>
        {status === 'sender' ? 'Sender …' : 'Send besked'}
      </button>
    </form>
  );
}

export default function Kontakt() {
  return (
    <>
      <SideHero over="Kontakt" titel="Find værkstedet" tekst="Du er velkommen til at ringe, skrive eller bestille en tid direkte her på siden." />
      <section className="beholder grid gap-10 py-16 sm:py-20 lg:grid-cols-[1fr_1.3fr]">
        <div className="space-y-5">
          <div className="frem kort p-7">
            <h2 className="text-[1.9rem]">{VIRKSOMHED.navn}</h2>
            <ul className="mt-5 space-y-4">
              <li className="flex gap-3.5">
                <Ikon navn="sted" className="mt-1 h-5 w-5 shrink-0 text-messing" />
                <span>{VIRKSOMHED.adresse}<br />{VIRKSOMHED.postnr} {VIRKSOMHED.by}</span>
              </li>
              <li>
                <a href={VIRKSOMHED.telefonLink} className="flex items-center gap-3.5 font-semibold text-groen hover:text-messing">
                  <Ikon navn="telefon" className="h-5 w-5 text-messing" /> {VIRKSOMHED.telefon}
                </a>
              </li>
              <li>
                <a href={`mailto:${VIRKSOMHED.email}`} className="flex items-center gap-3.5 break-all font-semibold text-groen hover:text-messing">
                  <Ikon navn="mail" className="h-5 w-5 shrink-0 text-messing" /> {VIRKSOMHED.email}
                </a>
              </li>
            </ul>
            <div className="mt-7 flex flex-col gap-3 sm:flex-row lg:flex-col xl:flex-row">
              <Link to="/bestil" className="knap-primaer"><Ikon navn="kalender" /> Bestil tid</Link>
              <a href={VIRKSOMHED.ruteLink} target="_blank" rel="noopener" className="knap-sekundaer"><Ikon navn="rute" /> Rutevejledning</a>
            </div>
          </div>
          <div className="frem kort p-7">
            <h2 className="flex items-center gap-2.5 text-[1.6rem]"><Ikon navn="ur" className="h-6 w-6 text-messing" /> Åbningstider</h2>
            {VIRKSOMHED.aabningstiderBekraeftet ? (
              <ul className="mt-3">{VIRKSOMHED.aabningstiderBekraeftet.map((l) => <li key={l}>{l}</li>)}</ul>
            ) : (
              <p className="mt-3 text-graa">Åbningstiderne bliver offentliggjort her, når de er bekræftet. Ring gerne, inden du kommer forbi uden aftale.</p>
            )}
          </div>
        </div>
        <div className="frem">
          <Kort />
          <a href={VIRKSOMHED.kortLink} target="_blank" rel="noopener" className="mt-3 inline-flex items-center gap-2 text-[0.95rem] font-semibold text-groen hover:text-messing">
            Åbn i Google Maps <Ikon navn="rute" className="h-4 w-4" />
          </a>
        </div>
      </section>
      <section className="bg-papir py-16 sm:py-24">
        <div className="beholder grid gap-10 lg:grid-cols-[1fr_1.3fr]">
          <div className="frem">
            <p className="overtekst">Skriv til os</p>
            <h2 className="mt-3 text-[2.3rem] sm:text-[2.8rem]">Har du et spørgsmål?</h2>
            <p className="mt-4 text-graa">Brug formularen, hvis du har et spørgsmål om dit ur. Vil du have en tid, er det hurtigst at bestille direkte.</p>
          </div>
          <div className="frem kort bg-white p-6 sm:p-8">
            <Kontaktformular />
          </div>
        </div>
      </section>
    </>
  );
}
