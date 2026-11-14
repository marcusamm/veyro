// Beskeder fra kontaktformularen samt eksport, udbakke og sletning af kundedata.
import { useEffect, useState } from 'react';
import { api, ApiFejl } from '../api';
import { Ikon } from '../components/Ikon';
import { kbhTid, plusDage } from '../../shared/tid';
import { DemoMaerke, Panel, feltA, knapFare, knapP, knapS, useAdmin } from './faelles';

interface Besked {
  id: string;
  navn: string;
  email: string;
  telefon: string;
  besked: string;
  oprettet: string;
  laest: number;
  kilde: string;
}

const tid = (iso: string) => new Date(iso).toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Beskeder() {
  const { opdatering, opdater, besked } = useAdmin();
  const [liste, setListe] = useState<Besked[] | null>(null);
  useEffect(() => {
    api<{ beskeder: Besked[] }>('/api/admin/beskeder').then((d) => setListe(d.beskeder));
  }, [opdatering]);
  return (
    <div>
      <h1 className="text-[2.2rem]">Beskeder</h1>
      <p className="mt-1 text-graa">Henvendelser fra kontaktformularen på hjemmesiden.</p>
      <div className="mt-5 space-y-3">
        {liste === null && <p className="text-graa">Henter …</p>}
        {liste?.length === 0 && <p className="rounded-2xl border border-linje bg-white p-8 text-center text-graa">Ingen beskeder.</p>}
        {liste?.map((b) => (
          <article key={b.id} className={`rounded-2xl border bg-white p-5 ${b.laest ? 'border-linje' : 'border-[#e3cb9a] shadow-[0_0_0_3px_#fbf1dc]'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 font-semibold">{!b.laest && <span className="h-2 w-2 rounded-full bg-messing" aria-label="Ulæst" />}{b.navn} {b.kilde === 'demo' && <DemoMaerke />}</p>
              <p className="text-[0.85rem] text-graa">{tid(b.oprettet)}</p>
            </div>
            <p className="mt-1 text-[0.9rem] text-graa">
              <a className="text-groen underline decoration-messing/50 underline-offset-2" href={`mailto:${b.email}`}>{b.email}</a>
              {b.telefon && <> · <a className="text-groen underline decoration-messing/50 underline-offset-2" href={`tel:${b.telefon.replace(/[^\d+]/g, '')}`}>{b.telefon}</a></>}
            </p>
            <p className="mt-3 whitespace-pre-line">{b.besked}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a className={knapP} href={`mailto:${b.email}?subject=${encodeURIComponent('Svar fra UrmagerMette')}`}><Ikon navn="mail" className="h-4 w-4" /> Svar</a>
              <button type="button" className={knapS} onClick={() => api(`/api/admin/beskeder/${b.id}/laest`, { method: 'POST' }).then(opdater)}>{b.laest ? 'Markér som ulæst' : 'Markér som læst'}</button>
              <button type="button" className={knapFare} onClick={() => window.confirm('Slet beskeden?') && api(`/api/admin/beskeder/${b.id}`, { method: 'DELETE' }).then(() => { opdater(); besked('Beskeden er slettet'); })}>Slet</button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

interface Mail {
  id: number;
  til: string;
  emne: string;
  tekst: string;
  status: string;
  oprettet: string;
}

export function Data() {
  const { opdatering, besked, opdater, demo } = useAdmin();
  const idag = kbhTid().dato;
  const [fra, setFra] = useState(plusDage(idag, -365));
  const [til, setTil] = useState(plusDage(idag, 365));
  const [mails, setMails] = useState<Mail[]>([]);
  const [aaben, setAaben] = useState<number | null>(null);
  const [slet, setSlet] = useState({ email: '', telefon: '' });
  const [sletFejl, setSletFejl] = useState('');
  useEffect(() => {
    api<{ mails: Mail[] }>('/api/admin/udbakke').then((d) => setMails(d.mails));
  }, [opdatering]);

  return (
    <div className="space-y-6">
      <h1 className="text-[2.2rem]">Data</h1>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel titel="Eksportér bookinger">
          <p className="text-[0.93rem] text-graa">Hent bookinger som CSV-fil, der kan åbnes i Excel eller Numbers.</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div><label className="etiket" htmlFor="ex-fra">Fra</label><input id="ex-fra" type="date" className={feltA} value={fra} onChange={(e) => setFra(e.target.value)} /></div>
            <div><label className="etiket" htmlFor="ex-til">Til</label><input id="ex-til" type="date" className={feltA} value={til} onChange={(e) => setTil(e.target.value)} /></div>
          </div>
          <a className={`${knapP} mt-4`} href={`/api/admin/eksport?fra=${fra}&til=${til}`} download><Ikon navn="download" className="h-4 w-4" /> Hent CSV</a>
          <p className="mt-3 text-[0.82rem] text-graa">Filen indeholder personoplysninger. Opbevar den sikkert og slet den, når du ikke længere har brug for den.</p>
        </Panel>
        <Panel titel="Slet en kundes oplysninger">
          <p className="text-[0.93rem] text-graa">Hvis en kunde beder om at blive slettet: angiv e-mail eller telefonnummer. Alle kundens bookinger anonymiseres, og beskeder slettes.</p>
          <form className="mt-4 space-y-3" onSubmit={async (e) => {
            e.preventDefault();
            setSletFejl('');
            if (!window.confirm('Slet kundens oplysninger permanent?')) return;
            try {
              const r = await api<{ bookinger: number; beskeder: number }>('/api/admin/slet-kunde', { method: 'POST', json: slet });
              besked(`Slettet: ${r.bookinger} booking(er) og ${r.beskeder} besked(er)`);
              setSlet({ email: '', telefon: '' });
              opdater();
            } catch (err) {
              setSletFejl(err instanceof ApiFejl ? err.message : 'Fejl');
            }
          }}>
            <div className="grid gap-3 sm:grid-cols-2">
              <input type="email" className={feltA} placeholder="E-mail" value={slet.email} onChange={(e) => setSlet({ ...slet, email: e.target.value })} aria-label="Kundens e-mail" />
              <input type="tel" className={feltA} placeholder="Telefon" value={slet.telefon} onChange={(e) => setSlet({ ...slet, telefon: e.target.value })} aria-label="Kundens telefon" />
            </div>
            <button type="submit" className={knapFare}>Slet kundens oplysninger</button>
            {sletFejl && <p className="feltfejl">{sletFejl}</p>}
          </form>
        </Panel>
      </div>
      <Panel titel="Udbakke – e-mails til kunder">
        {demo && (
          <p className="mb-4 rounded-xl bg-[#fbf1dc] px-4 py-3 text-[0.93rem] text-[#6b5229]">
            Demo: Ingen e-mails bliver sendt. Her kan du se de e-mails, som systemet ville sende, når det er sat i drift.
          </p>
        )}
        {mails.length === 0 ? <p className="text-graa">Ingen e-mails endnu.</p> : (
          <ul className="divide-y divide-linje">
            {mails.map((m) => (
              <li key={m.id}>
                <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left" onClick={() => setAaben(aaben === m.id ? null : m.id)} aria-expanded={aaben === m.id}>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{m.emne}</span>
                    <span className="text-[0.85rem] text-graa">Til {m.til} · {tid(m.oprettet)}</span>
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 text-[0.78rem] font-semibold ${m.status === 'sendt' ? 'bg-[#dfeae3] text-groen' : m.status === 'fejl' ? 'bg-[#f5e1e1] text-fejl' : 'bg-[#f6ead2] text-[#7a5e30]'}`}>
                    {m.status === 'sendt' ? 'Sendt' : m.status === 'fejl' ? 'Fejlede' : 'Ikke sendt (demo)'}
                  </span>
                </button>
                {aaben === m.id && <pre className="ind mb-3 whitespace-pre-wrap rounded-xl bg-creme/70 p-4 font-sans text-[0.9rem]">{m.tekst}</pre>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
