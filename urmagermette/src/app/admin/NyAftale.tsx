// Værkstedet opretter selv en aftale, fx når en kunde ringer.
import { useEffect, useState } from 'react';
import { api, ApiFejl } from '../api';
import type { Ydelse } from '../../shared/typer';
import { URTYPER } from '../../shared/virksomhed';
import { Modal, feltA, useAdmin } from './faelles';
import { TidVaelger } from './TidVaelger';

export function NyAftale({ onLuk, dato }: { onLuk: () => void; dato: string }) {
  const { opdater, besked, aabnBooking, demo } = useAdmin();
  const [ydelser, setYdelser] = useState<Ydelse[]>([]);
  const [v, setV] = useState({ ydelse: '', navn: '', telefon: '', email: '', urtype: 'Andet', maerke: '', beskrivelse: '' });
  const [sendMail, setSendMail] = useState(false);
  const [felter, setFelter] = useState<Record<string, string>>({});
  const [fejl, setFejl] = useState('');
  const [arbejder, setArbejder] = useState(false);

  useEffect(() => {
    api<{ ydelser: Ydelse[] }>('/api/admin/indstillinger').then((d) => {
      setYdelser(d.ydelser);
      setV((x) => ({ ...x, ydelse: d.ydelser.find((y) => y.aktiv)?.id ?? '' }));
    });
  }, []);

  async function opret(d: string, start: number, tving: boolean) {
    setArbejder(true);
    setFejl('');
    try {
      const r = await api<{ booking: { id: string } }>('/api/admin/bookinger', { method: 'POST', json: { ...v, dato: d, start, tving, sendMail } });
      opdater();
      besked('Aftalen er oprettet');
      onLuk();
      aabnBooking(r.booking.id);
    } catch (e) {
      if (e instanceof ApiFejl) {
        setFelter(e.felter);
        setFejl(e.message);
      }
    } finally {
      setArbejder(false);
    }
  }
  const s = (k: keyof typeof v) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  return (
    <Modal titel="Ny aftale" onLuk={onLuk} bred>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="etiket" htmlFor="na-y">Service</label>
            <select id="na-y" className={feltA} value={v.ydelse} onChange={s('ydelse')}>
              {ydelser.map((y) => <option key={y.id} value={y.id}>{y.navn}{y.aktiv ? '' : ' (deaktiveret)'}</option>)}
            </select>
          </div>
          <div>
            <label className="etiket" htmlFor="na-navn">Navn</label>
            <input id="na-navn" className={feltA} value={v.navn} onChange={s('navn')} aria-invalid={!!felter.navn} />
            {felter.navn && <p className="feltfejl">{felter.navn}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="etiket" htmlFor="na-tlf">Telefon</label>
              <input id="na-tlf" type="tel" className={feltA} value={v.telefon} onChange={s('telefon')} aria-invalid={!!felter.telefon} />
              {felter.telefon && <p className="feltfejl">{felter.telefon}</p>}
            </div>
            <div>
              <label className="etiket" htmlFor="na-ut">Urtype</label>
              <select id="na-ut" className={feltA} value={v.urtype} onChange={s('urtype')}>
                {URTYPER.map((u) => <option key={u}>{u}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="etiket" htmlFor="na-mail">E-mail <span className="font-normal text-graa">(valgfrit)</span></label>
            <input id="na-mail" type="email" className={feltA} value={v.email} onChange={s('email')} aria-invalid={!!felter.email} />
            {felter.email && <p className="feltfejl">{felter.email}</p>}
          </div>
          <div>
            <label className="etiket" htmlFor="na-m">Mærke/model</label>
            <input id="na-m" className={feltA} value={v.maerke} onChange={s('maerke')} />
          </div>
          <div>
            <label className="etiket" htmlFor="na-b">Beskrivelse</label>
            <textarea id="na-b" className={`${feltA} min-h-[5rem]`} value={v.beskrivelse} onChange={s('beskrivelse')} />
          </div>
        </div>
        <div>
          {v.ydelse && (
            <TidVaelger
              ydelseId={v.ydelse}
              startDato={dato}
              knapTekst="Opret aftale"
              arbejder={arbejder}
              ekstra={v.email ? <label className="flex items-center gap-2 text-[0.9rem]"><input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={sendMail} onChange={(e) => setSendMail(e.target.checked)} /> {demo ? 'Gem bekræftelse i udbakken (demo: sendes ikke)' : 'Send bekræftelse til kunden'}</label> : null}
              onVaelg={opret}
            />
          )}
          {fejl && <p className="mt-3 rounded-xl bg-fejl/10 px-4 py-3 text-[0.93rem] font-medium text-fejl" role="alert">{fejl}</p>}
        </div>
      </div>
    </Modal>
  );
}
