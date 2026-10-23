// Vælg dato og tid i adminpanelet. Viser ledige tider, men værkstedet kan også vælge en tid manuelt.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { klok, tilMin } from '../../shared/tid';
import { feltA, knapP } from './faelles';

interface Props {
  ydelseId: string;
  ignorer?: string;
  startDato: string;
  knapTekst: string;
  arbejder: boolean;
  ekstra?: ReactNode;
  onVaelg: (dato: string, start: number, tving: boolean) => void;
}

export function TidVaelger({ ydelseId, ignorer, startDato, knapTekst, arbejder, ekstra, onVaelg }: Props) {
  const [dato, setDato] = useState(startDato);
  const [tider, setTider] = useState<number[] | null>(null);
  const [valgt, setValgt] = useState<number | null>(null);
  const [manuel, setManuel] = useState(false);
  const [manuelTid, setManuelTid] = useState('');
  const [fejl, setFejl] = useState('');

  useEffect(() => {
    if (!dato || !ydelseId) return;
    setTider(null);
    setValgt(null);
    setFejl('');
    api<{ dage: Record<string, number[]> }>(`/api/admin/ledighed?ydelse=${encodeURIComponent(ydelseId)}&fra=${dato}&dage=1${ignorer ? `&ignorer=${ignorer}` : ''}`)
      .then((d) => setTider(d.dage[dato] ?? []))
      .catch((e: Error) => setFejl(e.message));
  }, [dato, ydelseId, ignorer]);

  const manuelMin = tilMin(manuelTid);
  return (
    <div className="space-y-3">
      <div>
        <label className="etiket" htmlFor="tv-dato">Dato</label>
        <input id="tv-dato" type="date" className={feltA} value={dato} onChange={(e) => setDato(e.target.value)} />
      </div>
      {fejl && <p className="feltfejl">{fejl}</p>}
      {!manuel && (
        <div>
          <p className="etiket">Ledige tider</p>
          {tider === null ? (
            <p className="text-[0.9rem] text-graa">Henter …</p>
          ) : tider.length === 0 ? (
            <p className="text-[0.9rem] text-graa">Ingen ledige tider denne dag (lukket, blokeret eller optaget).</p>
          ) : (
            <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
              {tider.map((t) => (
                <button key={t} type="button" onClick={() => setValgt(t)} className={`min-h-[2.6rem] rounded-lg border text-[0.93rem] font-semibold tabular-nums ${valgt === t ? 'border-groen bg-groen text-creme' : 'border-linje bg-white hover:border-groen'}`}>
                  {klok(t)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <label className="flex items-center gap-2 text-[0.9rem] text-graa">
        <input type="checkbox" className="h-4 w-4 accent-[#1f3a2e]" checked={manuel} onChange={(e) => setManuel(e.target.checked)} />
        Vælg et andet tidspunkt manuelt (også uden for åbningstid eller oven i en anden aftale)
      </label>
      {manuel && (
        <div>
          <label className="etiket" htmlFor="tv-tid">Tidspunkt</label>
          <input id="tv-tid" type="time" className={feltA} value={manuelTid} onChange={(e) => setManuelTid(e.target.value)} step={300} />
        </div>
      )}
      {ekstra}
      <button
        type="button"
        className={knapP}
        disabled={arbejder || (manuel ? manuelMin === null : valgt === null)}
        onClick={() => (manuel ? manuelMin !== null && onVaelg(dato, manuelMin, true) : valgt !== null && onVaelg(dato, valgt, false))}
      >
        {knapTekst}
      </button>
    </div>
  );
}
