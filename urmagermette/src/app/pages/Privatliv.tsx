import { SideHero } from '../components/Dele';
import { DEMO } from '../demo';
import { VIRKSOMHED } from '../../shared/virksomhed';

export default function Privatliv() {
  return (
    <>
      <SideHero over="Privatlivspolitik" titel="Sådan behandler vi dine oplysninger" />
      <section className="beholder max-w-3xl py-14 sm:py-20">
        {DEMO && (
          <p className="mb-10 rounded-2xl border border-messing/30 bg-messing/5 p-5 text-[0.97rem] text-[#6b5229]">
            Udkast til demoen. Teksten skal gennemgås og godkendes af virksomhedens ejer, før hjemmesiden lanceres.
          </p>
        )}
        <div className="space-y-9 text-graa [&_h2]:mb-3 [&_h2]:text-[1.9rem]">
          <div>
            <h2>Dataansvarlig</h2>
            <p>{VIRKSOMHED.navn}, {VIRKSOMHED.adresse}, {VIRKSOMHED.postnr} {VIRKSOMHED.by}. Telefon {VIRKSOMHED.telefon}, e-mail {VIRKSOMHED.email}.</p>
          </div>
          <div>
            <h2>Hvilke oplysninger vi gemmer</h2>
            <p>Når du bestiller tid, gemmer vi dit navn, telefonnummer, e-mail, oplysninger om dit ur, din beskrivelse af problemet og et eventuelt billede af uret. Når du skriver via kontaktformularen, gemmer vi dit navn, din e-mail, dit eventuelle telefonnummer og din besked.</p>
          </div>
          <div>
            <h2>Hvorfor</h2>
            <p>Oplysningerne bruges kun til at behandle din booking eller besvare din henvendelse – fx til at bekræfte, flytte eller aflyse din tid og til at kontakte dig om dit ur. Vi sælger eller videregiver ikke dine oplysninger til markedsføring.</p>
          </div>
          <div>
            <h2>Hvor længe</h2>
            <p>Oplysningerne slettes automatisk, når opbevaringsperioden er udløbet. Perioden fastsættes af værkstedet og kan ses her, når siden lanceres.{DEMO ? ' I demoen slettes oplysninger, som besøgende har indtastet, efter 14 dage.' : ''}</p>
          </div>
          <div>
            <h2>Dine rettigheder</h2>
            <p>Du har ret til at få indsigt i de oplysninger, vi har om dig, og til at få dem rettet eller slettet. Kontakt os på {VIRKSOMHED.email} eller {VIRKSOMHED.telefon}. Du kan også klage til Datatilsynet (datatilsynet.dk).</p>
          </div>
          <div>
            <h2>Cookies og kort</h2>
            <p>Hjemmesiden bruger ikke cookies til statistik eller markedsføring. Administrationen bruger en nødvendig cookie til login. Kortet på kontaktsiden hentes fra Google Maps og vises først, når du selv klikker på det. Valget huskes i din browser.</p>
          </div>
          <div>
            <h2>Databehandlere</h2>
            <p>Hjemmesiden og bookingsystemet drives hos Cloudflare.{DEMO ? '' : ' E-mails sendes via en e-mailudbyder.'}</p>
          </div>
        </div>
      </section>
    </>
  );
}
