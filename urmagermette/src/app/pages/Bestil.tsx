import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { api, ApiFejl } from '../api';
import { Ikon } from '../components/Ikon';
import { Honeypot } from '../components/Spamfelter';
import { Kalender } from '../components/Kalender';
import { DEMO } from '../demo';
import { komprimerBillede } from '../billedvaerktoej';
import { STANDARD_YDELSER } from '../../shared/standard';
import { datoLang, klok, plusDage } from '../../shared/tid';
import type { Ydelse } from '../../shared/typer';
import { validerKunde, type Kundeoplysninger } from '../../shared/validering';
import { URTYPER, VIRKSOMHED } from '../../shared/virksomhed';

const URTYPE_FOR: Record<string, string> = {
  armbaandsur: 'Armbåndsur', vintageur: 'Vintageur', lommeur: 'Lommeur', bornholmerur: 'Bornholmerur', taffelur: 'Taffelur', stueur: 'Stueur', andet: 'Andet',
};

const FORSLAG = ['Uret går for hurtigt', 'Uret går for langsomt', 'Uret er stoppet', 'Uret slår forkert', 'Glasset er gået i stykker', 'Ønsker service/eftersyn'];

const TRIN = ['Service', 'Tidspunkt', 'Oplysninger', 'Bekræft'];

interface Offentlig {
  demo: boolean;
  ydelser: Ydelse[];
  maxDageFrem: number;
  idag: string;
  turnstileSiteKey: string | null;
}

interface Kvittering {
  ref: string;
  token: string;
  ydelseNavn: string;
  dato: string;
  start: number;
  slut: number;
  statusTekst: string;
  navn: string;
  telefon: string;
  email: string;
  emailSendt: boolean;
}

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, o: { sitekey: string; callback: (t: string) => void }) => string; reset: (id?: string) => void };
  }
}

function Trinviser({ trin, gaaTil }: { trin: number; gaaTil: (n: number) => void }) {
  return (
    <ol className="flex items-center gap-1.5 sm:gap-3" aria-label="Trin i bestillingen">
      {TRIN.map((t, i) => {
        const n = i + 1;
        const faerdig = n < trin;
        const aktiv = n === trin;
        return (
          <li key={t} className="flex flex-1 items-center gap-1.5 sm:gap-3">
            <button
              type="button"
              disabled={!faerdig}
              onClick={() => gaaTil(n)}
              aria-current={aktiv ? 'step' : undefined}
              className="group flex min-w-0 items-center gap-2 disabled:cursor-default"
            >
              <span
                className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-[0.95rem] font-semibold transition-colors duration-300 ${
                  aktiv ? 'border-groen bg-groen text-creme' : faerdig ? 'border-messing bg-messing text-white group-hover:bg-[#93713d]' : 'border-linje bg-papir text-graa'
                }`}
              >
                {faerdig ? <Ikon navn="tjek" className="h-4 w-4" strøg={2.4} /> : n}
              </span>
              <span className={`hidden truncate text-[0.95rem] font-semibold md:inline ${aktiv ? 'text-groen' : 'text-graa'}`}>{t}</span>
            </button>
            {n < TRIN.length && <span className={`h-px flex-1 ${faerdig ? 'bg-messing' : 'bg-linje'}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function Bestil() {
  const [info, setInfo] = useState<Offentlig>({ demo: DEMO, ydelser: STANDARD_YDELSER, maxDageFrem: 60, idag: '', turnstileSiteKey: null });
  const [infoFejl, setInfoFejl] = useState('');
  const [trin, setTrin] = useState(1);
  const [ydelseId, setYdelseId] = useState('');
  const [dato, setDato] = useState('');
  const [start, setStart] = useState<number | null>(null);
  const [kunde, setKunde] = useState<Kundeoplysninger>({ navn: '', telefon: '', email: '', urtype: '', maerke: '', beskrivelse: '' });
  const [billede, setBillede] = useState<{ fil: Blob; url: string; navn: string } | null>(null);
  const [billedFejl, setBilledFejl] = useState('');
  const [felter, setFelter] = useState<Record<string, string>>({});
  const [samtykke, setSamtykke] = useState(false);
  const [firma, setFirma] = useState('');
  const [sender, setSender] = useState(false);
  const [fejl, setFejl] = useState('');
  const [kvittering, setKvittering] = useState<Kvittering | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [ledighedNoegle, setLedighedNoegle] = useState(0);
  const startet = useRef(0);
  const topRef = useRef<HTMLDivElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);

  const ydelse = info.ydelser.find((y) => y.id === ydelseId);

  useEffect(() => {
    startet.current = Date.now();
    const valgt = new URLSearchParams(window.location.search).get('ydelse');
    api<Offentlig>('/api/offentlig')
      .then((d) => {
        setInfo(d);
        if (valgt && d.ydelser.some((y) => y.id === valgt)) {
          setYdelseId(valgt);
          setKunde((k) => ({ ...k, urtype: URTYPE_FOR[valgt] ?? 'Andet' }));
          setTrin(2);
        }
      })
      .catch((e: Error) => setInfoFejl(e.message));
  }, []);

  // Rul op til toppen af bestillingen ved trinskift
  useEffect(() => {
    if (startet.current && topRef.current && topRef.current.getBoundingClientRect().top < 0) {
      topRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [trin, kvittering]);

  // Spamkontrol (Cloudflare Turnstile) – kun hvis den er sat op
  useEffect(() => {
    if (trin !== 4 || !info.turnstileSiteKey || !turnstileRef.current) return;
    const el = turnstileRef.current;
    const render = () => window.turnstile?.render(el, { sitekey: info.turnstileSiteKey!, callback: setTurnstileToken });
    if (window.turnstile) render();
    else {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = render;
      document.head.appendChild(s);
    }
  }, [trin, info.turnstileSiteKey]);

  function vaelgYdelse(id: string) {
    if (id !== ydelseId) {
      setDato('');
      setStart(null);
    }
    setYdelseId(id);
    setKunde((k) => ({ ...k, urtype: k.urtype && k.urtype !== URTYPE_FOR[ydelseId] ? k.urtype : URTYPE_FOR[id] ?? 'Andet' }));
    setTrin(2);
  }

  async function vaelgBillede(e: ChangeEvent<HTMLInputElement>) {
    setBilledFejl('');
    const fil = e.target.files?.[0];
    e.target.value = '';
    if (!fil) return;
    if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(fil.type) && !/\.(jpe?g|png|webp|heic)$/i.test(fil.name)) {
      setBilledFejl('Vælg et billede (JPG, PNG eller WebP).');
      return;
    }
    try {
      const blob = await komprimerBillede(fil);
      if (billede) URL.revokeObjectURL(billede.url);
      setBillede({ fil: blob, url: URL.createObjectURL(blob), navn: fil.name });
    } catch {
      setBilledFejl('Billedet kunne ikke læses. Prøv et andet billede, eller tag et skærmbillede af det.');
    }
  }

  function tilBekraeft(e: FormEvent) {
    e.preventDefault();
    const f = validerKunde(kunde);
    setFelter(f);
    if (Object.keys(f).length) {
      const foerste = document.getElementById(`b-${Object.keys(f)[0]}`);
      foerste?.focus();
      return;
    }
    setTrin(4);
  }

  async function send() {
    if (!ydelse || !dato || start === null) return;
    if (!samtykke) {
      setFelter({ samtykke: 'Du skal acceptere, at vi gemmer dine oplysninger for at behandle din booking.' });
      return;
    }
    setSender(true);
    setFejl('');
    const fd = new FormData();
    for (const [k, v] of Object.entries(kunde)) fd.set(k, v);
    fd.set('ydelse', ydelse.id);
    fd.set('dato', dato);
    fd.set('start', String(start));
    fd.set('samtykke', 'ja');
    fd.set('firma', firma);
    fd.set('startet', String(startet.current));
    if (turnstileToken) fd.set('cf-turnstile-response', turnstileToken);
    if (billede) fd.set('billede', billede.fil, 'ur.jpg');
    try {
      const k = await api<Kvittering>('/api/bookinger', { method: 'POST', body: fd });
      setKvittering(k);
    } catch (err) {
      if (err instanceof ApiFejl) {
        if (err.status === 409) {
          setStart(null);
          setLedighedNoegle((n) => n + 1);
          setTrin(2);
        }
        if (Object.keys(err.felter).length) {
          setFelter(err.felter);
          if (Object.keys(err.felter).some((k) => k !== 'samtykke')) setTrin(3);
        }
        setFejl(err.message);
      }
      if (window.turnstile) window.turnstile.reset();
    } finally {
      setSender(false);
    }
  }

  const saet = (k: keyof Kundeoplysninger) => (e: { target: { value: string } }) => setKunde({ ...kunde, [k]: e.target.value });
  const feltProps = (k: string) => ({ id: `b-${k}`, 'aria-invalid': !!felter[k], 'aria-describedby': felter[k] ? `b-${k}-f` : undefined });
  const feltFejl = (k: string) => (felter[k] ? <p id={`b-${k}-f`} className="feltfejl">{felter[k]}</p> : null);

  if (kvittering) return <Bekraeftelse k={kvittering} />;

  return (
    <section className="bg-papir">
      <div className="beholder max-w-5xl py-12 sm:py-16">
        <p className="overtekst">Online tidsbestilling</p>
        <h1 className="mt-3 text-[2.6rem] sm:text-[3.4rem]">Bestil tid</h1>
        <p className="mt-3 max-w-2xl text-[1.08rem] text-graa">Vælg service og tidspunkt, og fortæl kort om dit ur. Du behøver ikke oprette en bruger.</p>

        <div ref={topRef} className="scroll-mt-24 pt-8">
          <Trinviser trin={trin} gaaTil={setTrin} />
        </div>

        {infoFejl && <p className="mt-6 rounded-xl bg-fejl/10 px-4 py-3 font-medium text-fejl" role="alert">Bookingsystemet kunne ikke hentes: {infoFejl} Du kan også ringe på {VIRKSOMHED.telefon}.</p>}
        {fejl && <p className="ind mt-6 rounded-xl bg-fejl/10 px-4 py-3 font-medium text-fejl" role="alert">{fejl}</p>}

        <div className="mt-8 rounded-[1.75rem] border border-linje bg-white p-5 shadow-[0_30px_60px_-45px_rgba(31,58,46,0.5)] sm:p-9">
          {trin === 1 && (
            <div className="ind">
              <h2 className="text-[2rem]">1. Hvad drejer det sig om?</h2>
              <p className="mt-2 text-graa">Vælg den type ur eller opgave, besøget handler om.</p>
              <div className="mt-6 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Vælg service">
                {info.ydelser.map((y) => (
                  <button
                    key={y.id}
                    type="button"
                    role="radio"
                    aria-checked={ydelseId === y.id}
                    onClick={() => vaelgYdelse(y.id)}
                    className={`group flex min-h-[5.5rem] items-center gap-4 rounded-2xl border p-4 text-left transition-all duration-200 hover:border-groen hover:bg-creme/50 ${ydelseId === y.id ? 'border-groen bg-creme/60 ring-2 ring-groen/15' : 'border-linje'}`}
                  >
                    <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${ydelseId === y.id ? 'bg-groen text-creme' : 'bg-creme text-messing group-hover:bg-groen group-hover:text-creme'} transition-colors`}>
                      <Ikon navn={y.id === 'andet' ? 'lup' : 'ur'} className="h-5 w-5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-serif text-[1.4rem] leading-tight text-groen">{y.navn}</span>
                      <span className="mt-0.5 block text-[0.93rem] leading-snug text-graa">{y.beskrivelse}</span>
                    </span>
                    <Ikon navn="pil" className="h-5 w-5 shrink-0 text-messing opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
              <Bemaerkning />
            </div>
          )}

          {trin === 2 && ydelse && (
            <div className="ind">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-[2rem]">2. Vælg dato og tidspunkt</h2>
                <button type="button" className="text-[0.95rem] font-semibold text-groen underline decoration-messing underline-offset-4" onClick={() => setTrin(1)}>
                  {ydelse.navn} · Skift
                </button>
              </div>
              <p className="mt-2 text-graa">Kun ledige tider vises. Alle tider er dansk tid. Besøget varer ca. {ydelse.varighed} minutter.</p>
              {info.demo && (
                <p className="mt-3 inline-flex items-center gap-2 rounded-full bg-messing/10 px-3.5 py-1.5 text-[0.88rem] font-semibold text-[#7a5e30]">
                  <Ikon navn="info" className="h-4 w-4" /> Demodata: åbningstider og ledige tider er eksempler
                </p>
              )}
              <div className="mt-6">
                <Kalender
                  key={`${ydelse.id}-${ledighedNoegle}`}
                  ydelseId={ydelse.id}
                  idag={info.idag}
                  sidsteDato={info.idag ? plusDage(info.idag, info.maxDageFrem) : ''}
                  dato={dato}
                  start={start}
                  onDato={(d) => { setDato(d); setStart(null); }}
                  onStart={setStart}
                />
              </div>
              <div className="mt-8 flex flex-col-reverse gap-3 border-t border-linje pt-6 sm:flex-row sm:justify-between">
                <button type="button" className="knap-sekundaer" onClick={() => setTrin(1)}><Ikon navn="pilVenstre" className="h-4 w-4" /> Tilbage</button>
                <button type="button" className="knap-primaer" disabled={start === null} onClick={() => { setFejl(''); setTrin(3); }} aria-disabled={start === null}>
                  {start === null ? 'Vælg et tidspunkt' : <>Fortsæt med {klok(start)} <Ikon navn="pil" className="h-4 w-4" /></>}
                </button>
              </div>
            </div>
          )}

          {trin === 3 && (
            <form className="ind relative" onSubmit={tilBekraeft} noValidate>
              <Honeypot vaerdi={firma} saet={setFirma} />
              <h2 className="text-[2rem]">3. Dine oplysninger</h2>
              <p className="mt-2 text-graa">Så vi kan kontakte dig om tiden og forberede besøget.</p>
              <div className="mt-6 grid gap-5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label htmlFor="b-navn" className="etiket">Fulde navn</label>
                  <input {...feltProps('navn')} className="felt" autoComplete="name" value={kunde.navn} onChange={saet('navn')} />
                  {feltFejl('navn')}
                </div>
                <div>
                  <label htmlFor="b-telefon" className="etiket">Telefonnummer</label>
                  <input {...feltProps('telefon')} className="felt" type="tel" inputMode="tel" autoComplete="tel" value={kunde.telefon} onChange={saet('telefon')} />
                  {feltFejl('telefon')}
                </div>
                <div>
                  <label htmlFor="b-email" className="etiket">E-mail</label>
                  <input {...feltProps('email')} className="felt" type="email" inputMode="email" autoComplete="email" value={kunde.email} onChange={saet('email')} />
                  {feltFejl('email')}
                </div>
                <div>
                  <label htmlFor="b-urtype" className="etiket">Urtype</label>
                  <div className="relative">
                    <select {...feltProps('urtype')} className="felt appearance-none pr-11" value={kunde.urtype} onChange={saet('urtype')}>
                      <option value="">Vælg …</option>
                      {URTYPER.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-messing" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                  </div>
                  {feltFejl('urtype')}
                </div>
                <div>
                  <label htmlFor="b-maerke" className="etiket">Mærke/model <span className="font-normal text-graa">(hvis kendt)</span></label>
                  <input id="b-maerke" className="felt" value={kunde.maerke} onChange={saet('maerke')} placeholder="Fx mærke, model eller alder" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="b-beskrivelse" className="etiket">Kort beskrivelse af problemet</label>
                  <div className="mb-2.5 flex flex-wrap gap-2">
                    {FORSLAG.map((f) => (
                      <button key={f} type="button" className="rounded-full border border-linje bg-creme/60 px-3.5 py-1.5 text-[0.9rem] text-koks transition-colors hover:border-messing hover:bg-creme"
                        onClick={() => setKunde((k) => ({ ...k, beskrivelse: k.beskrivelse ? `${k.beskrivelse.replace(/\s+$/, '')}${/[.!?]$/.test(k.beskrivelse.trim()) ? '' : '.'} ${f}.` : `${f}.` }))}>
                        + {f}
                      </button>
                    ))}
                  </div>
                  <textarea {...feltProps('beskrivelse')} className="felt min-h-[8rem]" value={kunde.beskrivelse} onChange={saet('beskrivelse')} placeholder="Fx: Uret er stoppet, efter det blev tabt. Det går i et par minutter, når jeg ryster det." maxLength={2000} />
                  {feltFejl('beskrivelse')}
                </div>
                <div className="sm:col-span-2">
                  <span className="etiket">Billede af uret <span className="font-normal text-graa">(valgfrit)</span></span>
                  {billede ? (
                    <div className="flex items-center gap-4 rounded-xl border border-linje p-3">
                      <img src={billede.url} alt="Dit valgte billede" className="h-20 w-20 rounded-lg object-cover" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-semibold">{billede.navn}</p>
                        <p className="text-[0.9rem] text-graa">{Math.round(billede.fil.size / 1024)} kB</p>
                      </div>
                      <button type="button" className="knap-lille border border-linje text-fejl hover:bg-fejl/5" onClick={() => { URL.revokeObjectURL(billede.url); setBillede(null); }}>
                        <Ikon navn="slet" className="h-4 w-4" /> Fjern
                      </button>
                    </div>
                  ) : (
                    <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#cfc4ad] bg-creme/40 px-4 py-7 text-center transition-colors hover:border-groen hover:bg-creme">
                      <Ikon navn="billede" className="h-8 w-8 text-messing" strøg={1.4} />
                      <span className="font-semibold text-groen">Vælg eller tag et billede</span>
                      <span className="text-[0.9rem] text-graa">JPG, PNG eller WebP. Billedet gøres automatisk mindre.</span>
                      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic" className="sr-only" onChange={vaelgBillede} />
                    </label>
                  )}
                  {billedFejl && <p className="feltfejl">{billedFejl}</p>}
                </div>
              </div>
              <div className="mt-8 flex flex-col-reverse gap-3 border-t border-linje pt-6 sm:flex-row sm:justify-between">
                <button type="button" className="knap-sekundaer" onClick={() => setTrin(2)}><Ikon navn="pilVenstre" className="h-4 w-4" /> Tilbage</button>
                <button type="submit" className="knap-primaer">Se oversigt <Ikon navn="pil" className="h-4 w-4" /></button>
              </div>
            </form>
          )}

          {trin === 4 && ydelse && dato && start !== null && (
            <div className="ind">
              <h2 className="text-[2rem]">4. Tjek og send din anmodning</h2>
              <p className="mt-2 text-graa">Se oplysningerne igennem, før du sender.</p>
              <dl className="mt-6 divide-y divide-linje rounded-2xl border border-linje">
                <Opsummering titel="Service" vaerdi={ydelse.navn} ret={() => setTrin(1)} />
                <Opsummering titel="Dato og tidspunkt" vaerdi={<><span className="first-letter:uppercase">{datoLang(dato)}</span><br />kl. {klok(start)}–{klok(start + ydelse.varighed)}</>} ret={() => setTrin(2)} />
                <Opsummering titel="Kontaktoplysninger" vaerdi={<>{kunde.navn}<br />{kunde.telefon}<br />{kunde.email}</>} ret={() => setTrin(3)} />
                <Opsummering titel="Uret" vaerdi={<>{kunde.urtype}{kunde.maerke ? ` · ${kunde.maerke}` : ''}<br /><span className="text-graa">{kunde.beskrivelse}</span>{billede && <><br /><span className="text-graa">Billede vedhæftet</span></>}</>} ret={() => setTrin(3)} />
              </dl>
              <div className="mt-6 rounded-2xl bg-creme/70 p-5">
                <p className="flex gap-3 text-[0.97rem]">
                  <Ikon navn="info" className="mt-0.5 h-5 w-5 shrink-0 text-messing" />
                  <span>
                    Du sender en <strong>anmodning</strong>. Tiden er holdt til dig, men er først endeligt aftalt, når UrmagerMette har bekræftet den.
                    Tiden er til indlevering, konsultation eller vurdering – ikke nødvendigvis selve reparationen.
                  </span>
                </p>
              </div>
              <label className="mt-6 flex cursor-pointer items-start gap-3">
                <input type="checkbox" className="mt-1 h-5 w-5 shrink-0 accent-[#1f3a2e]" checked={samtykke} onChange={(e) => { setSamtykke(e.target.checked); setFelter({}); }} aria-describedby={felter.samtykke ? 'b-samtykke-f' : undefined} />
                <span>Jeg accepterer, at mine oplysninger gemmes og bruges til at behandle min booking. Læs <Link to="/privatliv" target="_blank" className="underline decoration-messing underline-offset-2">privatlivspolitikken</Link>.</span>
              </label>
              {felter.samtykke && <p id="b-samtykke-f" className="feltfejl">{felter.samtykke}</p>}
              {info.turnstileSiteKey && <div ref={turnstileRef} className="mt-5" />}
              {info.demo && (
                <p className="mt-5 flex gap-2.5 rounded-xl border border-messing/30 bg-messing/5 p-4 text-[0.93rem] text-[#6b5229]">
                  <Ikon navn="info" className="mt-0.5 h-5 w-5 shrink-0" />
                  <span>Demo: Anmodningen gemmes i demoens bookingsystem, men der sendes ingen e-mail, og den når ikke UrmagerMette. Brug gerne opdigtede oplysninger.</span>
                </p>
              )}
              <div className="mt-8 flex flex-col-reverse gap-3 border-t border-linje pt-6 sm:flex-row sm:justify-between">
                <button type="button" className="knap-sekundaer" onClick={() => setTrin(3)}><Ikon navn="pilVenstre" className="h-4 w-4" /> Tilbage</button>
                <button type="button" className="knap-primaer" onClick={send} disabled={sender || (!!info.turnstileSiteKey && !turnstileToken)}>
                  {sender ? 'Sender …' : <><Ikon navn="tjek" className="h-5 w-5" strøg={2} /> Send anmodning</>}
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="mt-6 text-center text-[0.95rem] text-graa">
          Foretrækker du at ringe? <a href={VIRKSOMHED.telefonLink} className="font-semibold text-groen underline decoration-messing underline-offset-4">{VIRKSOMHED.telefon}</a>
        </p>
      </div>
    </section>
  );
}

function Bemaerkning() {
  return (
    <div className="mt-6 flex gap-3 rounded-2xl bg-creme/70 p-5 text-[0.97rem]">
      <Ikon navn="info" className="mt-0.5 h-5 w-5 shrink-0 text-messing" />
      <p>
        <strong className="font-semibold text-groen">Godt at vide:</strong> Den tid, du vælger, er som udgangspunkt til indlevering, konsultation eller
        vurdering af dit ur. Det er ikke nødvendigvis tidspunktet, hvor selve reparationen bliver udført.
      </p>
    </div>
  );
}

function Opsummering({ titel, vaerdi, ret }: { titel: string; vaerdi: ReactNode; ret: () => void }) {
  return (
    <div className="flex gap-4 p-4 sm:p-5">
      <div className="min-w-0 flex-1 sm:flex sm:gap-6">
        <dt className="text-[0.85rem] font-semibold uppercase tracking-[0.12em] text-messing sm:w-44 sm:shrink-0 sm:pt-0.5">{titel}</dt>
        <dd className="mt-1 break-words sm:mt-0">{vaerdi}</dd>
      </div>
      <button type="button" onClick={ret} className="self-start text-[0.92rem] font-semibold text-groen underline decoration-messing underline-offset-4">Ret</button>
    </div>
  );
}

function Bekraeftelse({ k }: { k: Kvittering }) {
  const link = useMemo(() => (typeof window === 'undefined' ? '' : `${window.location.origin}/booking/${k.token}`), [k.token]);
  const [kopieret, setKopieret] = useState(false);
  return (
    <section className="bg-papir">
      <div className="beholder max-w-3xl py-14 sm:py-20">
        <div className="ind rounded-[1.75rem] border border-linje bg-white p-6 text-center shadow-[0_30px_60px_-45px_rgba(31,58,46,0.5)] sm:p-12" role="status">
          <span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full bg-groen text-creme">
            <Ikon navn="tjek" className="h-8 w-8" strøg={2.2} />
          </span>
          <h1 className="mt-6 text-[2.4rem] sm:text-[3rem]">Tak, {k.navn.split(' ')[0]}! Din anmodning er modtaget</h1>
          <p className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-messing/15 px-4 py-1.5 text-[0.95rem] font-semibold text-[#7a5e30]">
            <span className="h-2 w-2 rounded-full bg-messing" /> {k.statusTekst}
          </p>
          <p className="mx-auto mt-5 max-w-lg text-graa">
            Tiden er holdt til dig, men den er <strong>endnu ikke endeligt bekræftet</strong>. Du får besked, når UrmagerMette har godkendt tiden.
          </p>
          <dl className="mt-8 grid gap-px overflow-hidden rounded-2xl border border-linje bg-linje text-left sm:grid-cols-2">
            {[
              ['Reference', k.ref],
              ['Service', k.ydelseNavn],
              ['Dato', datoLang(k.dato)],
              ['Tidspunkt', `kl. ${klok(k.start)}–${klok(k.slut)}`],
              ['Adresse', `${VIRKSOMHED.adresse}, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}`],
              ['Kontakt', `${k.telefon} · ${k.email}`],
            ].map(([t, v]) => (
              <div key={t} className="bg-white p-4">
                <dt className="text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-messing">{t}</dt>
                <dd className="mt-1 break-words first-letter:uppercase">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-8 rounded-2xl bg-creme/70 p-5 text-left">
            <p className="font-semibold text-groen">Gem dette link</p>
            <p className="mt-1 text-[0.95rem] text-graa">Her kan du følge status og afbestille din tid.</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input readOnly value={link} className="felt !min-h-[2.8rem] flex-1 text-[0.9rem]" aria-label="Link til din booking" onFocus={(e) => e.target.select()} />
              <button type="button" className="knap-lille bg-groen text-creme hover:bg-groen-moerk" onClick={() => { navigator.clipboard?.writeText(link).then(() => setKopieret(true)).catch(() => {}); }}>
                {kopieret ? 'Kopieret' : 'Kopiér link'}
              </button>
            </div>
          </div>
          <p className="mt-6 text-[0.93rem] text-graa">
            {k.emailSendt
              ? `Vi har sendt en kvittering til ${k.email}.`
              : 'Demo: Der er ikke sendt nogen e-mail. I den færdige version får du en e-mail med dato, tidspunkt, adresse og mulighed for at afbestille.'}
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link to={`/booking/${k.token}`} className="knap-primaer">Se din booking</Link>
            <Link to="/" className="knap-sekundaer">Til forsiden</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
