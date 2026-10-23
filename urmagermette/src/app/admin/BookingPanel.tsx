// Detaljer om én booking: kunde, ur, status, flytning, noter, historik og sletning af persondata.
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiFejl } from '../api';
import { Ikon } from '../components/Ikon';
import { datoLang, klok } from '../../shared/tid';
import type { Booking, BookingStatus, Historik, Note } from '../../shared/typer';
import { DemoMaerke, StatusPille, feltA, knapFare, knapP, knapS, useAdmin } from './faelles';
import { TidVaelger } from './TidVaelger';

interface Detalje {
  booking: Booking;
  noter: Note[];
  historik: Historik[];
  mails: { til: string; emne: string; status: string; oprettet: string }[];
  andre: { id: string; ref: string; dato: string; start: number; status: BookingStatus; ydelseNavn: string }[];
}

function tidspunkt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Raekke({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-3 py-2">
      <dt className="text-[0.88rem] text-graa">{titel}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export function BookingPanel({ id, onLuk }: { id: string; onLuk: () => void }) {
  const { opdater, demo, besked, aabnBooking } = useAdmin();
  const [d, setD] = useState<Detalje | null>(null);
  const [fejl, setFejl] = useState('');
  const [arbejder, setArbejder] = useState(false);
  const [handling, setHandling] = useState<null | 'afvis' | 'aflys' | 'flyt' | 'slet'>(null);
  const [beskedTekst, setBeskedTekst] = useState('');
  const [sendMail, setSendMail] = useState(true);
  const [note, setNote] = useState('');
  const [visBillede, setVisBillede] = useState(false);

  const hent = () => api<Detalje>(`/api/admin/bookinger/${id}`).then(setD).catch((e: Error) => setFejl(e.message));
  useEffect(() => {
    setD(null);
    setHandling(null);
    hent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onLuk();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onLuk]);

  async function udfoer(fn: () => Promise<unknown>, ok: string) {
    setArbejder(true);
    setFejl('');
    try {
      await fn();
      await hent();
      opdater();
      setHandling(null);
      setBeskedTekst('');
      besked(ok);
    } catch (e) {
      setFejl(e instanceof ApiFejl ? e.message : 'Der opstod en fejl.');
    } finally {
      setArbejder(false);
    }
  }

  const status = (s: BookingStatus, ok: string, ekstra: Record<string, unknown> = {}) =>
    udfoer(() => api(`/api/admin/bookinger/${id}/status`, { method: 'POST', json: { status: s, besked: beskedTekst, sendMail, ...ekstra } }), ok);

  const b = d?.booking;
  const mailTekst = demo ? 'Gem e-mail til kunden i udbakken (demo: sendes ikke)' : 'Send e-mail til kunden';

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-groen-moerk/30 backdrop-blur-[1px]" onMouseDown={(e) => e.target === e.currentTarget && onLuk()}>
      <aside className="ind flex h-full w-full max-w-xl flex-col bg-creme shadow-2xl" role="dialog" aria-modal="true" aria-label="Booking">
        <div className="flex items-center justify-between gap-3 border-b border-linje bg-papir px-5 py-4">
          <div className="min-w-0">
            <p className="text-[0.8rem] font-semibold uppercase tracking-[0.14em] text-messing">{b?.ref ?? 'Booking'}</p>
            <h2 className="truncate font-sans text-[1.25rem] font-semibold text-koks">{b ? b.navn : 'Henter …'}</h2>
          </div>
          <button type="button" onClick={onLuk} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-sand" aria-label="Luk">
            <Ikon navn="luk" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          {fejl && <p className="rounded-xl bg-fejl/10 px-4 py-3 text-[0.95rem] font-medium text-fejl" role="alert">{fejl}</p>}
          {b && d && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPille status={b.status} />
                {b.kilde === 'demo' && <DemoMaerke />}
                {b.kilde === 'admin' && <span className="text-[0.85rem] text-graa">Oprettet af værkstedet</span>}
                {b.anonymiseret && <span className="text-[0.85rem] font-semibold text-fejl">Persondata slettet</span>}
              </div>

              {/* Handlinger */}
              {!b.anonymiseret && (
                <div className="rounded-2xl border border-linje bg-white p-4">
                  <div className="flex flex-wrap gap-2">
                    {b.status === 'anmodet' && (
                      <>
                        <button type="button" className={knapP} disabled={arbejder} onClick={() => status('bekraeftet', 'Tiden er godkendt')}><Ikon navn="tjek" className="h-4 w-4" strøg={2.2} /> Godkend</button>
                        <button type="button" className={knapFare} disabled={arbejder} onClick={() => setHandling(handling === 'afvis' ? null : 'afvis')}>Afvis</button>
                      </>
                    )}
                    {b.status === 'bekraeftet' && (
                      <>
                        <button type="button" className={knapP} disabled={arbejder} onClick={() => status('gennemfoert', 'Markeret som gennemført', { sendMail: false })}><Ikon navn="tjek" className="h-4 w-4" strøg={2.2} /> Gennemført</button>
                        <button type="button" className={knapS} disabled={arbejder} onClick={() => status('udeblevet', 'Markeret som udeblevet', { sendMail: false })}>Udeblevet</button>
                        <button type="button" className={knapFare} disabled={arbejder} onClick={() => setHandling(handling === 'aflys' ? null : 'aflys')}>Aflys</button>
                      </>
                    )}
                    {(b.status === 'anmodet' || b.status === 'bekraeftet') && (
                      <button type="button" className={knapS} disabled={arbejder} onClick={() => setHandling(handling === 'flyt' ? null : 'flyt')}><Ikon navn="kalender" className="h-4 w-4" /> Flyt</button>
                    )}
                    {(b.status === 'afvist' || b.status === 'aflyst') && (
                      <button type="button" className={knapS} disabled={arbejder} onClick={() => status('bekraeftet', 'Aftalen er genåbnet')}>Genåbn som bekræftet</button>
                    )}
                    {(b.status === 'gennemfoert' || b.status === 'udeblevet') && (
                      <button type="button" className={knapS} disabled={arbejder} onClick={() => status('bekraeftet', 'Status sat tilbage', { sendMail: false, tving: true })}>Sæt tilbage til bekræftet</button>
                    )}
                  </div>
                  {(handling === 'afvis' || handling === 'aflys') && (
                    <div className="ind mt-4 space-y-3 border-t border-linje pt-4">
                      <label className="etiket" htmlFor="bp-besked">Besked til kunden <span className="font-normal text-graa">(valgfrit)</span></label>
                      <textarea id="bp-besked" className={`${feltA} min-h-[5rem]`} value={beskedTekst} onChange={(e) => setBeskedTekst(e.target.value)} placeholder={handling === 'afvis' ? 'Fx: Den dag er desværre optaget – ring gerne, så finder vi en anden tid.' : 'Fx: Værkstedet er desværre lukket på grund af sygdom.'} />
                      <label className="flex items-center gap-2 text-[0.92rem]"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={sendMail} onChange={(e) => setSendMail(e.target.checked)} /> {mailTekst}</label>
                      <button type="button" className={knapFare} disabled={arbejder} onClick={() => status(handling === 'afvis' ? 'afvist' : 'aflyst', handling === 'afvis' ? 'Anmodningen er afvist' : 'Aftalen er aflyst')}>
                        {handling === 'afvis' ? 'Afvis anmodningen' : 'Aflys aftalen'}
                      </button>
                    </div>
                  )}
                  {handling === 'flyt' && (
                    <div className="ind mt-4 border-t border-linje pt-4">
                      <TidVaelger
                        ydelseId={b.ydelseId}
                        ignorer={b.id}
                        startDato={b.dato}
                        knapTekst="Flyt aftalen hertil"
                        arbejder={arbejder}
                        ekstra={<label className="flex items-center gap-2 text-[0.92rem]"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={sendMail} onChange={(e) => setSendMail(e.target.checked)} /> {mailTekst}</label>}
                        onVaelg={(dato, start, tving) => udfoer(() => api(`/api/admin/bookinger/${id}/flyt`, { method: 'POST', json: { dato, start, tving, sendMail } }), 'Aftalen er flyttet')}
                      />
                    </div>
                  )}
                  {b.status === 'anmodet' && handling === null && (
                    <label className="mt-3 flex items-center gap-2 text-[0.88rem] text-graa"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={sendMail} onChange={(e) => setSendMail(e.target.checked)} /> {mailTekst}</label>
                  )}
                </div>
              )}

              <div className="rounded-2xl border border-linje bg-white px-4 py-2">
                <dl className="divide-y divide-linje">
                  <Raekke titel="Tid"><span className="font-semibold first-letter:uppercase">{datoLang(b.dato)}</span><br />kl. {klok(b.start)}–{klok(b.slut)}{b.buffer ? <span className="text-graa"> (+{b.buffer} min. buffer)</span> : null}</Raekke>
                  <Raekke titel="Service">{b.ydelseNavn}</Raekke>
                  <Raekke titel="Telefon">{b.telefon ? <a href={`tel:${b.telefon.replace(/[^\d+]/g, '')}`} className="font-semibold text-groen underline decoration-messing/50 underline-offset-2">{b.telefon}</a> : '–'}</Raekke>
                  <Raekke titel="E-mail">{b.email ? <a href={`mailto:${b.email}`} className="font-semibold text-groen underline decoration-messing/50 underline-offset-2">{b.email}</a> : '–'}</Raekke>
                  <Raekke titel="Urtype">{b.urtype}{b.maerke ? ` · ${b.maerke}` : ''}</Raekke>
                  <Raekke titel="Beskrivelse"><span className="whitespace-pre-line">{b.beskrivelse || '–'}</span></Raekke>
                  {b.harBillede && (
                    <Raekke titel="Billede">
                      <button type="button" onClick={() => setVisBillede(!visBillede)} className="block overflow-hidden rounded-xl border border-linje">
                        <img src={`/api/admin/bookinger/${b.id}/billede`} alt="Kundens billede af uret" className={visBillede ? 'max-h-[70vh] w-full object-contain' : 'h-28 w-28 object-cover'} />
                      </button>
                    </Raekke>
                  )}
                  <Raekke titel="Modtaget">{tidspunkt(b.oprettet)}</Raekke>
                </dl>
              </div>

              {/* Interne noter */}
              <div className="rounded-2xl border border-linje bg-white p-4">
                <h3 className="flex items-center gap-2 font-sans text-[1rem] font-semibold text-koks"><Ikon navn="noter" className="h-4 w-4 text-messing" /> Interne noter <span className="font-normal text-graa">(ses kun af værkstedet)</span></h3>
                <ul className="mt-3 space-y-2">
                  {d.noter.map((n) => (
                    <li key={n.id} className="group flex gap-3 rounded-xl bg-creme/70 px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line text-[0.95rem]">{n.tekst}</p>
                        <p className="mt-0.5 text-[0.78rem] text-graa">{tidspunkt(n.oprettet)}</p>
                      </div>
                      <button type="button" className="h-8 w-8 shrink-0 rounded-full text-graa hover:bg-white hover:text-fejl" aria-label="Slet note"
                        onClick={() => udfoer(() => api(`/api/admin/bookinger/${id}/noter/${n.id}`, { method: 'DELETE' }), 'Noten er slettet')}>
                        <Ikon navn="slet" className="mx-auto h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
                {!b.anonymiseret && (
                  <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) udfoer(() => api(`/api/admin/bookinger/${id}/noter`, { method: 'POST', json: { tekst: note } }).then(() => setNote('')), 'Noten er gemt'); }}>
                    <input className={`${feltA} flex-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Skriv en note …" aria-label="Ny note" />
                    <button type="submit" className={knapP} disabled={arbejder || !note.trim()}>Gem</button>
                  </form>
                )}
              </div>

              {d.andre.length > 0 && (
                <div className="rounded-2xl border border-linje bg-white p-4">
                  <h3 className="font-sans text-[1rem] font-semibold text-koks">Kundens andre bookinger</h3>
                  <ul className="mt-2 divide-y divide-linje">
                    {d.andre.map((a) => (
                      <li key={a.id}>
                        <button type="button" className="flex w-full items-center justify-between gap-3 py-2 text-left text-[0.93rem] hover:text-groen" onClick={() => aabnBooking(a.id)}>
                          <span>{a.dato.split('-').reverse().join('.')} kl. {klok(a.start)} · {a.ydelseNavn}</span>
                          <StatusPille status={a.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <details className="rounded-2xl border border-linje bg-white p-4">
                <summary className="cursor-pointer font-sans text-[1rem] font-semibold text-koks">Historik og e-mails</summary>
                <ol className="mt-3 space-y-2 border-l border-linje pl-4">
                  {d.historik.map((h, i) => (
                    <li key={i} className="text-[0.9rem]">
                      <span className="font-semibold first-letter:uppercase">{h.handling}</span>{h.tekst && <span className="text-graa"> – {h.tekst}</span>}
                      <span className="block text-[0.78rem] text-graa">{tidspunkt(h.tid)}</span>
                    </li>
                  ))}
                </ol>
                {d.mails.length > 0 && (
                  <ul className="mt-4 space-y-1.5 border-t border-linje pt-3 text-[0.88rem]">
                    {d.mails.map((m, i) => (
                      <li key={i} className="flex flex-wrap justify-between gap-2">
                        <span>{m.emne}</span>
                        <span className={m.status === 'sendt' ? 'text-groen' : m.status === 'fejl' ? 'text-fejl' : 'text-[#7a5e30]'}>{m.status === 'sendt' ? 'Sendt' : m.status === 'fejl' ? 'Fejlede' : 'Ikke sendt (demo)'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </details>

              {/* Persondata */}
              <div className="rounded-2xl border border-fejl/20 bg-white p-4">
                <h3 className="font-sans text-[1rem] font-semibold text-koks">Persondata</h3>
                {handling !== 'slet' ? (
                  <button type="button" className={`${knapFare} mt-3`} onClick={() => setHandling('slet')}><Ikon navn="slet" className="h-4 w-4" /> Slet kundens oplysninger …</button>
                ) : (
                  <div className="ind mt-3 space-y-3">
                    <p className="text-[0.93rem] text-graa">Navn, kontaktoplysninger, beskrivelse, billede og noter slettes permanent. Tiden bevares anonymt i statistikken – eller slet hele bookingen.</p>
                    <div className="flex flex-wrap gap-2">
                      {!b.anonymiseret && <button type="button" className={knapFare} disabled={arbejder} onClick={() => udfoer(() => api(`/api/admin/bookinger/${id}/anonymiser`, { method: 'POST' }), 'Oplysningerne er slettet')}>Slet oplysningerne</button>}
                      <button type="button" className={knapFare} disabled={arbejder} onClick={async () => {
                        setArbejder(true);
                        try {
                          await api(`/api/admin/bookinger/${id}`, { method: 'DELETE' });
                          opdater();
                          besked('Bookingen er slettet');
                          onLuk();
                        } catch (e) {
                          setFejl(e instanceof ApiFejl ? e.message : 'Der opstod en fejl.');
                          setArbejder(false);
                        }
                      }}>Slet hele bookingen</button>
                      <button type="button" className={knapS} onClick={() => setHandling(null)}>Fortryd</button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
