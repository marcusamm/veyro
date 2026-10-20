import { CtaBaand, FaqListe, SideHero } from '../components/Dele';

const GRUPPER = [
  { emne: 'booking' as const, titel: 'Tidsbestilling' },
  { emne: 'indlevering' as const, titel: 'Indlevering' },
  { emne: 'vurdering' as const, titel: 'Vurdering og reparation' },
];

export default function Faq() {
  return (
    <>
      <SideHero over="Spørgsmål og svar" titel="Ofte stillede spørgsmål" tekst="Om tidsbestilling, indlevering og vurdering. Finder du ikke svaret, er du altid velkommen til at ringe eller skrive." />
      <section className="beholder max-w-4xl space-y-16 py-16 sm:py-24">
        {GRUPPER.map((g) => (
          <div key={g.emne} className="frem">
            <h2 className="mb-4 text-[2.1rem]">{g.titel}</h2>
            <FaqListe emner={[g.emne]} />
          </div>
        ))}
      </section>
      <CtaBaand titel="Har du et andet spørgsmål?" tekst="Ring, skriv eller bestil en tid, så kigger vi på dit ur sammen." />
    </>
  );
}
