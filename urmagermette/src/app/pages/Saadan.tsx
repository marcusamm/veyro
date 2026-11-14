import { Link } from 'react-router';
import { CtaBaand, FaqListe, Foto, Proces, SektionHoved, SideHero } from '../components/Dele';
import { Ikon } from '../components/Ikon';

export default function Saadan() {
  return (
    <>
      <SideHero
        over="Sådan foregår det"
        titel="Sådan foregår en reparation"
        tekst="Det skal være let at få hjælp til sit ur. Her kan du se, hvad der sker fra du bestiller tid, til du kan hente dit ur igen."
      />
      <section className="beholder py-16 sm:py-24">
        <Proces />
      </section>
      <section className="bg-papir py-16 sm:py-24">
        <div className="beholder grid items-center gap-12 lg:grid-cols-2">
          <div className="frem aspect-[4/3] overflow-hidden rounded-[2rem] bg-sand">
            <Foto navn="vaerksted" />
          </div>
          <div className="frem">
            <p className="overtekst">Om tidsbestillingen</p>
            <h2 className="mt-3 text-[2.3rem] sm:text-[2.8rem]">Tiden er til indlevering og vurdering</h2>
            <div className="prose-um mt-5 text-graa">
              <p>
                Når du bestiller tid, er det som udgangspunkt en tid til at indlevere dit ur, få en konsultation eller en vurdering. Det er ikke
                nødvendigvis tidspunktet, hvor selve reparationen bliver udført.
              </p>
              <p>
                Din bestilling bliver først sendt som en anmodning. Tidspunktet er holdt til dig, mens anmodningen afventer godkendelse, og du får
                besked, når tiden er bekræftet.
              </p>
            </div>
            <Link to="/bestil" className="knap-primaer mt-8">
              <Ikon navn="kalender" /> Bestil tid
            </Link>
          </div>
        </div>
      </section>
      <section className="beholder py-16 sm:py-24">
        <SektionHoved over="Spørgsmål" titel="Om indlevering og vurdering" />
        <div className="frem mt-8">
          <FaqListe emner={['indlevering', 'vurdering']} />
        </div>
      </section>
      <CtaBaand />
    </>
  );
}
