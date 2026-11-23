import { Link } from 'react-router';
import { CtaBaand, FaqListe, Foto, Proces, SektionHoved, YdelseKort } from '../components/Dele';
import { Ikon } from '../components/Ikon';
import { YDELSER } from '../indhold';
import { VIRKSOMHED } from '../../shared/virksomhed';

export default function Forside() {
  return (
    <>
      {/* Hero */}
      <section className="relative isolate overflow-hidden bg-groen-moerk">
        <div className="absolute inset-0 -z-10">
          <Foto navn="hero" prioritet sizes="100vw" className="opacity-70" />
          <div className="absolute inset-0 bg-gradient-to-r from-groen-moerk via-groen-moerk/85 to-groen-moerk/20" />
          <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-groen-moerk/70 to-transparent" />
        </div>
        <div className="beholder flex min-h-[min(88vh,52rem)] flex-col justify-center py-20 sm:py-28">
          <div className="ind max-w-2xl">
            <p className="overtekst !text-messing-lys">Urmager i Slagelse</p>
            <h1 className="mt-5 text-[3.1rem] !text-creme sm:text-[4.6rem] lg:text-[5.2rem]">
              Dit ur fortjener <span className="italic text-messing-lys">den rette hånd</span>
            </h1>
            <p className="mt-6 max-w-xl text-[1.15rem] leading-relaxed text-creme/85 sm:text-[1.25rem]">
              Reparation og service af store og små ure i Slagelse. Fra armbåndsure og vintageure til klassiske stueure og bornholmerure.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link to="/bestil" className="knap-messing">
                <Ikon navn="kalender" /> Bestil tid
              </Link>
              <Link to="/ydelser" className="knap-lys">
                Se vores ydelser <Ikon navn="pil" className="h-4 w-4" />
              </Link>
            </div>
            <p className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.95rem] text-creme/70">
              <span className="flex items-center gap-2"><Ikon navn="sted" className="h-4 w-4 text-messing-lys" /> {VIRKSOMHED.adresse}, {VIRKSOMHED.postnr} {VIRKSOMHED.by}</span>
              <a href={VIRKSOMHED.telefonLink} className="flex items-center gap-2 hover:text-creme"><Ikon navn="telefon" className="h-4 w-4 text-messing-lys" /> {VIRKSOMHED.telefon}</a>
            </p>
          </div>
        </div>
      </section>

      {/* Kerneydelser */}
      <section className="beholder py-20 sm:py-28" aria-labelledby="ydelser-titel">
        <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
          <SektionHoved id="ydelser-titel" over="Ydelser" titel="Hjælp til alle slags ure" tekst="Store eller små, nye eller gamle – her kan du få dit ur undersøgt, serviceret og repareret." />
          <Link to="/ydelser" className="frem knap-sekundaer shrink-0">
            Alle ydelser <Ikon navn="pil" className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {YDELSER.map((y) => (
            <YdelseKort key={y.id} y={y} kompakt />
          ))}
        </div>
      </section>

      {/* Et godt ur er værd at passe på */}
      <section className="bg-papir py-20 sm:py-28">
        <div className="beholder grid items-center gap-12 lg:grid-cols-2 lg:gap-20">
          <div className="frem relative">
            <div className="aspect-[4/5] overflow-hidden rounded-[2rem] bg-sand">
              <Foto navn="urvaerk" />
            </div>
            <div className="absolute -bottom-6 -right-3 hidden w-56 overflow-hidden rounded-2xl border-[6px] border-papir shadow-xl sm:block lg:-right-10">
              <div className="aspect-square">
                <Foto navn="vaerktoej" sizes="14rem" />
              </div>
            </div>
          </div>
          <div className="frem">
            <p className="overtekst">Værkstedet</p>
            <h2 className="mt-3 text-[2.4rem] sm:text-[3.1rem]">Et godt ur er værd at passe på</h2>
            <div className="prose-um mt-6 text-[1.08rem] text-graa">
              <p>
                Et ur er mere end en måde at holde styr på tiden. Det kan være en gave, et minde eller et stykke familiehistorie, der er gået i arv
                gennem generationer. Derfor fortjener det at blive behandlet med omhu.
              </p>
              <p>
                Et mekanisk ur består af mange små dele, der skal arbejde præcist sammen. Med tiden tørrer olien ud, dele slides, og støv finder vej
                ind i værket. Regelmæssig vedligeholdelse hjælper uret til at gå godt – og til at holde i mange år endnu.
              </p>
              <p>
                Hos UrmagerMette bliver dit ur undersøgt i ro og mag. Du får en forklaring på, hvad der er galt, og hvad der kan gøres, så du selv
                kan tage stilling, før arbejdet går i gang.
              </p>
            </div>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link to="/om" className="knap-sekundaer">
                Om værkstedet <Ikon navn="pil" className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Værdier */}
      <section className="beholder py-20 sm:py-24">
        <div className="grid gap-10 md:grid-cols-3">
          {[
            { ikon: 'lup' as const, titel: 'Præcision', tekst: 'Fejlfinding og arbejde udført med ro, omhu og øje for detaljen.' },
            { ikon: 'tradition' as const, titel: 'Tradition', tekst: 'Respekt for håndværket og for de ure, der har gået i generationer.' },
            { ikon: 'hjerte' as const, titel: 'Omsorg', tekst: 'Dit ur bliver behandlet med omsorg – uanset om det er et arvestykke eller et hverdagsur.' },
          ].map((v, i) => (
            <div key={v.titel} className="frem text-center" style={{ transitionDelay: `${i * 90}ms` }}>
              <span className="mx-auto inline-flex h-16 w-16 items-center justify-center rounded-full border border-messing/40 text-messing">
                <Ikon navn={v.ikon} className="h-7 w-7" strøg={1.4} />
              </span>
              <h3 className="mt-5 text-[1.8rem]">{v.titel}</h3>
              <p className="mx-auto mt-2 max-w-xs text-graa">{v.tekst}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Sådan foregår det */}
      <section className="bg-groen py-20 text-creme sm:py-28" aria-labelledby="proces-titel">
        <div className="beholder">
          <div className="frem max-w-2xl">
            <p className="overtekst !text-messing-lys">Sådan foregår en reparation</p>
            <h2 id="proces-titel" className="mt-3 text-[2.3rem] !text-creme sm:text-[2.9rem]">Fra bestilling til afhentning</h2>
            <p className="mt-4 text-[1.08rem] text-creme/75">Fire enkle trin. Du ved hele vejen, hvad der sker med dit ur.</p>
          </div>
          <div className="mt-12">
            <Proces lys />
          </div>
          <div className="frem mt-10">
            <Link to="/bestil" className="knap-messing">
              <Ikon navn="kalender" /> Bestil tid
            </Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="beholder grid gap-12 py-20 sm:py-28 lg:grid-cols-[1fr_1.6fr]">
        <div>
          <SektionHoved over="Spørgsmål og svar" titel="Godt at vide" tekst="Svar på det, kunder oftest spørger om, når de bestiller tid." />
          <Link to="/faq" className="frem knap-sekundaer mt-8">
            Flere spørgsmål <Ikon navn="pil" className="h-4 w-4" />
          </Link>
        </div>
        <div className="frem">
          <FaqListe emner={['booking']} />
        </div>
      </section>

      <CtaBaand />
    </>
  );
}
