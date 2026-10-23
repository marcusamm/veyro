import { Link } from 'react-router';
import { CtaBaand, Proces, SektionHoved, SideHero, YdelseKort } from '../components/Dele';
import { Ikon } from '../components/Ikon';
import { YDELSER } from '../indhold';

export default function Ydelser() {
  return (
    <>
      <SideHero
        over="Ydelser og reparationer"
        titel="Service og reparation af ure i Slagelse"
        tekst="Fra det lille armbåndsur til det store standur. Vælg den type ur, det drejer sig om, og bestil en tid til indlevering eller vurdering."
      >
        <div className="mt-8 flex flex-wrap gap-2">
          {YDELSER.map((y) => (
            <a key={y.id} href={`#${y.id}`} className="rounded-full border border-linje bg-creme px-4 py-2 text-[0.95rem] font-medium text-groen hover:border-messing">
              {y.navn}
            </a>
          ))}
        </div>
      </SideHero>

      <section className="beholder py-16 sm:py-24">
        <div className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
          {YDELSER.map((y) => (
            <div key={y.id} id={y.id} className="scroll-mt-28">
              <YdelseKort y={y} />
            </div>
          ))}
        </div>
        <div className="frem mt-12 flex flex-col items-start gap-5 rounded-2xl border border-messing/30 bg-papir p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9">
          <div className="flex gap-4">
            <Ikon navn="info" className="mt-1 h-6 w-6 shrink-0 text-messing" />
            <div>
              <h2 className="text-[1.6rem]">Priser efter vurdering</h2>
              <p className="mt-1 max-w-2xl text-graa">
                Hvert ur er forskelligt. Derfor bliver prisen fastsat, når uret er undersøgt. Har du et ur, der ikke står på listen, kan du bestille
                en tid under &quot;Anden reparation eller vurdering&quot;.
              </p>
            </div>
          </div>
          <Link to="/bestil?ydelse=andet" className="knap-sekundaer shrink-0">
            Anden reparation <Ikon navn="pil" className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <section className="bg-papir py-16 sm:py-24">
        <div className="beholder">
          <SektionHoved over="Sådan foregår det" titel="Sådan foregår en reparation" />
          <div className="mt-10">
            <Proces />
          </div>
        </div>
      </section>

      <CtaBaand />
    </>
  );
}
