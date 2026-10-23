// Mobilvenlig månedskalender, der kun lader kunden vælge dage og tider, som serveren melder ledige.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { Ikon } from './Ikon';
import { datoLang, klok, maanedNavn, plusDage, ugedag } from '../../shared/tid';

interface Props {
  ydelseId: string;
  idag: string;
  sidsteDato: string;
  dato: string;
  start: number | null;
  onDato: (d: string) => void;
  onStart: (m: number) => void;
}

function foersteIMaaned(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

function dageIMaaned(foerste: string): number {
  const [y, m] = foerste.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function naesteMaaned(foerste: string, n: number): string {
  const [y, m] = foerste.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

const UGEDAGE = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];

export function Kalender({ ydelseId, idag, sidsteDato, dato, start, onDato, onStart }: Props) {
  const [maaned, setMaaned] = useState(dato ? foersteIMaaned(dato) : idag ? foersteIMaaned(idag) : '');
  const [ledige, setLedige] = useState<Record<string, number[]>>({});
  const [henter, setHenter] = useState(false);
  const [fejl, setFejl] = useState('');
  const [soegtFrem, setSoegtFrem] = useState(false);

  useEffect(() => {
    if (!maaned && idag) setMaaned(foersteIMaaned(idag));
  }, [idag, maaned]);

  useEffect(() => {
    if (!maaned) return;
    let aktuel = true;
    setHenter(true);
    setFejl('');
    api<{ dage: Record<string, number[]> }>(`/api/ledighed?ydelse=${encodeURIComponent(ydelseId)}&fra=${maaned}&dage=${dageIMaaned(maaned)}`)
      .then((d) => {
        if (!aktuel) return;
        setLedige((l) => ({ ...l, ...d.dage }));
        // Første gang: hop til næste måned, hvis der ingen ledige tider er i denne
        if (!soegtFrem && !dato && !Object.values(d.dage).some((t) => t.length) && naesteMaaned(maaned, 1) <= sidsteDato) {
          setSoegtFrem(true);
          setMaaned(naesteMaaned(maaned, 1));
        } else setSoegtFrem(true);
      })
      .catch((e: Error) => aktuel && setFejl(e.message))
      .finally(() => aktuel && setHenter(false));
    return () => {
      aktuel = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maaned, ydelseId]);

  if (!maaned) return <p className="text-graa">Henter kalender …</p>;

  const antal = dageIMaaned(maaned);
  const forskyd = (ugedag(maaned) + 6) % 7;
  const celler: (string | null)[] = [...Array(forskyd).fill(null), ...Array.from({ length: antal }, (_, i) => plusDage(maaned, i))];
  const [y, m] = maaned.split('-').map(Number) as [number, number];
  const kanTilbage = idag && naesteMaaned(maaned, -1) >= foersteIMaaned(idag);
  const kanFrem = sidsteDato && naesteMaaned(maaned, 1) <= sidsteDato;
  const tider = dato ? ledige[dato] ?? [] : [];
  const formiddag = tider.filter((t) => t < 12 * 60);
  const eftermiddag = tider.filter((t) => t >= 12 * 60);
  const ingenIMaaned = !henter && celler.every((d) => !d || !(ledige[d]?.length));

  return (
    <div className="grid gap-8 lg:grid-cols-[1.15fr_1fr]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <button type="button" className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-linje text-groen transition-colors hover:border-groen disabled:opacity-30" disabled={!kanTilbage} onClick={() => setMaaned(naesteMaaned(maaned, -1))} aria-label="Forrige måned">
            <Ikon navn="pilVenstre" />
          </button>
          <h3 className="font-serif text-[1.65rem] capitalize" aria-live="polite">{maanedNavn(m - 1)} {y}</h3>
          <button type="button" className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-linje text-groen transition-colors hover:border-groen disabled:opacity-30" disabled={!kanFrem} onClick={() => setMaaned(naesteMaaned(maaned, 1))} aria-label="Næste måned">
            <Ikon navn="pil" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[0.8rem] font-semibold uppercase tracking-wider text-graa">
          {UGEDAGE.map((d) => <div key={d} className="py-1.5">{d}</div>)}
        </div>
        <div className={`grid grid-cols-7 gap-1 transition-opacity ${henter ? 'opacity-50' : ''}`} role="grid" aria-label="Vælg dato">
          {celler.map((d, i) => {
            if (!d) return <div key={`t${i}`} />;
            const n = ledige[d]?.length ?? 0;
            const valgt = d === dato;
            const erIdag = d === idag;
            return (
              <button
                key={d}
                type="button"
                disabled={n === 0}
                onClick={() => onDato(d)}
                aria-pressed={valgt}
                aria-label={`${datoLang(d)}${n ? `, ${n} ledige tider` : ', ingen ledige tider'}`}
                className={`relative flex aspect-square min-h-[2.9rem] flex-col items-center justify-center rounded-xl text-[1.02rem] font-semibold transition-all duration-200 ${
                  valgt ? 'bg-groen text-creme shadow-md' : n ? 'bg-creme/70 text-groen hover:bg-groen/10 hover:ring-1 hover:ring-groen/40' : 'cursor-not-allowed text-[#b9b4a8] line-through decoration-[#d8d1c2]'
                } ${erIdag && !valgt ? 'ring-1 ring-messing' : ''}`}
              >
                {Number(d.slice(8))}
                {n > 0 && <span className={`absolute bottom-1.5 h-1 w-1 rounded-full ${valgt ? 'bg-messing-lys' : 'bg-messing'}`} />}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[0.85rem] text-graa">
          <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-messing" /> Ledige tider</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm ring-1 ring-messing" /> I dag</span>
        </div>
        {fejl && <p className="feltfejl" role="alert">{fejl}</p>}
        {ingenIMaaned && !fejl && <p className="mt-4 rounded-xl bg-creme/70 px-4 py-3 text-[0.95rem]">Der er ingen ledige tider i denne måned. {kanFrem ? 'Prøv næste måned.' : ''}</p>}
      </div>
      <div className="rounded-2xl border border-linje bg-papir p-5 sm:p-6" aria-live="polite">
        {!dato ? (
          <div className="flex h-full min-h-[10rem] flex-col items-center justify-center text-center text-graa">
            <Ikon navn="kalender" className="h-9 w-9 text-messing" strøg={1.3} />
            <p className="mt-3">Vælg en dato i kalenderen for at se de ledige tider.</p>
          </div>
        ) : (
          <>
            <p className="font-serif text-[1.45rem] leading-tight text-groen first-letter:uppercase">{datoLang(dato)}</p>
            {tider.length === 0 && <p className="mt-3 text-graa">Der er ikke flere ledige tider denne dag.</p>}
            {[['Formiddag', formiddag], ['Eftermiddag', eftermiddag]].map(([titel, liste]) =>
              (liste as number[]).length ? (
                <div key={titel as string} className="mt-4">
                  <p className="text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-messing">{titel as string}</p>
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
                    {(liste as number[]).map((t) => (
                      <button key={t} type="button" onClick={() => onStart(t)} aria-pressed={start === t}
                        className={`min-h-[3rem] rounded-xl border text-[1.02rem] font-semibold tabular-nums transition-all duration-200 ${start === t ? 'border-groen bg-groen text-creme shadow-md' : 'border-linje bg-white text-groen hover:border-groen'}`}>
                        {klok(t)}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
          </>
        )}
      </div>
    </div>
  );
}
