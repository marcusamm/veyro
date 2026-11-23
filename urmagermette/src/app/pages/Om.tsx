import { Link } from 'react-router';
import { CtaBaand, Foto, SideHero } from '../components/Dele';
import { Ikon } from '../components/Ikon';
import { VIRKSOMHED } from '../../shared/virksomhed';

export default function Om() {
  return (
    <>
      <SideHero over="Om UrmagerMette" titel="Et lokalt urmagerværksted i Slagelse" tekst="Omsorg for gamle og nye ure – og respekt for det håndværk, der holder dem i gang." />
      <section className="beholder grid gap-12 py-16 sm:py-24 lg:grid-cols-[1fr_1.1fr] lg:gap-20">
        <figure className="frem">
          {/* Plads til ejerens eget billede af Mette og værkstedet */}
          <div className="relative flex aspect-[4/5] flex-col items-center justify-center overflow-hidden rounded-[2rem] border border-dashed border-messing/60 bg-papir text-center">
            <div className="absolute inset-5 rounded-[1.5rem] border border-linje" />
            <Ikon navn="billede" className="h-12 w-12 text-messing" strøg={1.2} />
            <p className="mt-4 max-w-[16rem] font-serif text-[1.5rem] leading-snug text-groen">Plads til billede af Mette i værkstedet</p>
            <p className="mt-2 max-w-[15rem] text-[0.9rem] text-graa">Billedet indsættes, når ejeren har leveret det.</p>
          </div>
        </figure>
        <div className="frem self-center">
          <p className="overtekst">Værkstedet</p>
          <h2 className="mt-3 text-[2.4rem] sm:text-[3rem]">Håndværk med tid til detaljen</h2>
          <div className="prose-um mt-6 text-[1.08rem] text-graa">
            <p>
              Hos UrmagerMette handler det om ure – og om de mennesker, der holder af dem. Nogle ure bruges hver dag, andre er arvestykker, der har
              fulgt en familie i generationer. Fælles for dem er, at de fortjener at blive behandlet med omtanke.
            </p>
            <p>
              Et ur er et lille stykke præcisionsmekanik. Når det skal repareres, kræver det tålmodighed, det rette værktøj og respekt for urets
              konstruktion. Derfor bliver hvert ur undersøgt grundigt, før der tages stilling til, hvad der skal gøres.
            </p>
            <p>
              Værkstedet ligger på {VIRKSOMHED.adresse} i {VIRKSOMHED.by}. Her er du velkommen til at komme forbi med dit ur, fortælle om problemet og
              få en snak om, hvad der kan lade sig gøre.
            </p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {[
              { titel: 'Gamle og nye ure', tekst: 'Fra moderne armbåndsure til klassiske stueure og bornholmerure.' },
              { titel: 'Lokalt i Slagelse', tekst: 'Et værksted, hvor du kan aflevere dit ur personligt.' },
            ].map((p) => (
              <div key={p.titel} className="rounded-2xl border border-linje bg-papir p-5">
                <h3 className="text-[1.4rem]">{p.titel}</h3>
                <p className="mt-1 text-[0.97rem] text-graa">{p.tekst}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Link to="/bestil" className="knap-primaer"><Ikon navn="kalender" /> Bestil tid</Link>
            <Link to="/kontakt" className="knap-sekundaer">Find værkstedet</Link>
          </div>
        </div>
      </section>
      <section className="bg-papir py-16 sm:py-24">
        <div className="beholder grid gap-6 sm:grid-cols-3">
          {(['urvaerk', 'vaerktoej', 'bornholmerur'] as const).map((n) => (
            <div key={n} className="frem aspect-[4/3] overflow-hidden rounded-2xl bg-sand">
              <Foto navn={n} sizes="(min-width: 640px) 33vw, 100vw" />
            </div>
          ))}
        </div>
      </section>
      <CtaBaand />
    </>
  );
}
