import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { BILLEDER, type BilledNavn } from '../billeder';
import { FAQ, PROCES, type YdelseTekst } from '../indhold';
import { VIRKSOMHED } from '../../shared/virksomhed';
import { Ikon } from './Ikon';

export function Foto({ navn, className = '', prioritet = false, sizes = '(min-width: 1024px) 50vw, 100vw' }: { navn: BilledNavn; className?: string; prioritet?: boolean; sizes?: string }) {
  const b = BILLEDER[navn];
  return (
    <img
      src={b.src}
      srcSet={`${b.src.replace('.jpg', '-800.jpg')} 800w, ${b.src} ${b.b}w`}
      sizes={sizes}
      alt={b.alt}
      width={b.b}
      height={b.h}
      loading={prioritet ? 'eager' : 'lazy'}
      fetchPriority={prioritet ? 'high' : 'auto'}
      decoding="async"
      className={`h-full w-full object-cover ${className}`}
    />
  );
}

export function SektionHoved({ over, titel, tekst, center = false, id }: { over?: string; titel: ReactNode; tekst?: ReactNode; center?: boolean; id?: string }) {
  return (
    <div className={`frem max-w-2xl ${center ? 'mx-auto text-center' : ''}`}>
      {over && <p className={`overtekst ${center ? 'ornament justify-center' : ''}`}>{over}</p>}
      <h2 id={id} className="mt-3 text-[2.3rem] sm:text-[2.9rem]">{titel}</h2>
      {tekst && <p className="mt-4 text-[1.08rem] text-graa">{tekst}</p>}
    </div>
  );
}

export function YdelseKort({ y, kompakt = false }: { y: YdelseTekst; kompakt?: boolean }) {
  return (
    <article className="frem kort group flex flex-col overflow-hidden transition-all duration-500 ease-blid hover:-translate-y-1 hover:shadow-[0_24px_50px_-30px_rgba(31,58,46,0.45)]">
      <div className="billede-zoom aspect-[4/3] overflow-hidden bg-sand">
        <Foto navn={y.billede} sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw" />
      </div>
      <div className="flex flex-1 flex-col p-6 sm:p-7">
        <h3 className="text-[1.75rem]">{y.navn}</h3>
        <p className="mt-2 text-graa">{kompakt ? y.kort : y.lang}</p>
        {!kompakt && (
          <ul className="mt-4 space-y-1.5 text-[0.97rem]">
            {y.punkter.map((p) => (
              <li key={p} className="flex gap-2.5">
                <Ikon navn="tjek" className="mt-1 h-4 w-4 shrink-0 text-messing" strøg={2} /> {p}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-6">
          <span className="text-[0.92rem] font-semibold text-graa">Pris efter vurdering</span>
          <Link to={`/bestil?ydelse=${y.id}`} className="knap-lille bg-groen text-creme hover:bg-groen-moerk" aria-label={`Bestil tid: ${y.navn}`}>
            Bestil tid <Ikon navn="pil" className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </article>
  );
}

export function Proces({ lys = false }: { lys?: boolean }) {
  return (
    <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {PROCES.map((t, i) => (
        <li key={t.titel} className={`frem relative rounded-2xl border p-7 ${lys ? 'border-creme/15 bg-creme/[0.04]' : 'border-linje bg-papir'}`} style={{ transitionDelay: `${i * 90}ms` }}>
          <span className={`font-serif text-[3.2rem] leading-none ${lys ? 'text-messing-lys' : 'text-messing'}`}>{i + 1}</span>
          <h3 className={`mt-4 text-[1.55rem] ${lys ? '!text-creme' : ''}`}>{t.titel}</h3>
          <p className={`mt-2 ${lys ? 'text-creme/75' : 'text-graa'}`}>{t.tekst}</p>
          {i < PROCES.length - 1 && (
            <Ikon navn="pil" className={`absolute right-6 top-9 hidden h-5 w-5 lg:block ${lys ? 'text-creme/30' : 'text-messing/50'}`} />
          )}
        </li>
      ))}
    </ol>
  );
}

export function FaqListe({ emner }: { emner?: ('booking' | 'indlevering' | 'vurdering')[] }) {
  const liste = emner ? FAQ.filter((f) => emner.includes(f.emne)) : FAQ;
  return (
    <div className="divide-y divide-linje border-y border-linje">
      {liste.map((f) => (
        <FaqPunkt key={f.spoergsmaal} spoergsmaal={f.spoergsmaal} svar={f.svar} />
      ))}
    </div>
  );
}

function FaqPunkt({ spoergsmaal, svar }: { spoergsmaal: string; svar: string }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 text-left [&::-webkit-details-marker]:hidden">
        <span className="font-serif text-[1.4rem] leading-snug text-groen sm:text-[1.5rem]">{spoergsmaal}</span>
        <span className="mt-1 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-linje text-messing transition-transform duration-300 group-open:rotate-45">
          <Ikon navn="plus" className="h-4 w-4" strøg={2} />
        </span>
      </summary>
      <p className="max-w-3xl pb-6 pr-12 text-graa">{svar}</p>
    </details>
  );
}

export function CtaBaand({ titel = 'Klar til at få set på dit ur?', tekst = 'Bestil en tid til indlevering eller vurdering – det tager kun et par minutter, og du behøver ikke oprette en bruger.' }: { titel?: string; tekst?: string }) {
  return (
    <section className="beholder py-20 sm:py-24">
      <div className="frem relative overflow-hidden rounded-[2rem] bg-groen px-7 py-14 text-center sm:px-14 sm:py-16">
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full border border-messing/25" />
        <div className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full border border-messing/15" />
        <p className="overtekst ornament justify-center !text-messing-lys">UrmagerMette i Slagelse</p>
        <h2 className="mx-auto mt-4 max-w-2xl text-[2.3rem] !text-creme sm:text-[3rem]">{titel}</h2>
        <p className="mx-auto mt-4 max-w-xl text-creme/75">{tekst}</p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Link to="/bestil" className="knap-messing">
            <Ikon navn="kalender" /> Bestil tid
          </Link>
          <a href={VIRKSOMHED.telefonLink} className="knap-lys">
            <Ikon navn="telefon" /> {VIRKSOMHED.telefon}
          </a>
        </div>
      </div>
    </section>
  );
}

export function SideHero({ over, titel, tekst, children }: { over: string; titel: ReactNode; tekst?: ReactNode; children?: ReactNode }) {
  return (
    <section className="border-b border-linje bg-papir">
      <div className="beholder py-14 sm:py-20">
        <p className="overtekst">{over}</p>
        <h1 className="mt-3 max-w-3xl text-[2.7rem] sm:text-[3.6rem]">{titel}</h1>
        {tekst && <p className="mt-5 max-w-2xl text-[1.12rem] text-graa">{tekst}</p>}
        {children}
      </div>
    </section>
  );
}
