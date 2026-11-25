/** Shared by booking administrations. Enable iCloud instructions only for an eligible employee. */
export function calendarConnectionGuide(showIcloud = false): string {
  return `<section class="calendar-guide" aria-labelledby="calendar-guide-title">
    <h2 id="calendar-guide-title">Forbind din kalender</h2>
    <details open>
      <summary>Jeg vil se mine kundebookinger på mobilen.</summary>
      <div>
        <p>Åbn <strong>Kalender på mobilen</strong> i bookingadministrationen. På telefonen skal du først trykke på <strong>Vælg side</strong>. Vælg dit eget navn, hvis du kan vælge mellem flere kalendere.</p>
        <p>Tryk på <strong>Opret kalenderkobling</strong> første gang, og vælg <strong>Kopiér link</strong>. Har du allerede gemt dit link, kan du bruge det igen. En ny kobling erstatter det gamle link. Hold linket for dig selv, da det giver adgang til dine kundebookinger.</p>
        <h3>Apple Kalender på iPhone</h3>
        <p>Tryk på <strong>Åbn i kalenderapp</strong>, og bekræft abonnementet. Du kan også åbne Apple Kalender, vælge <strong>Kalendere → Tilføj kalender → Tilføj abonnementskalender</strong> og indsætte dit link.</p>
        <h3>Google Kalender</h3>
        <p>Åbn Google Kalender på en computer med den konto, du bruger på telefonen. Klik på <strong>+</strong> ved <strong>Andre kalendere</strong>, vælg <strong>Fra webadresse</strong>, indsæt linket, og klik på <strong>Tilføj kalender</strong>. Markér kalenderen i mobilappens menu, hvis den er skjult.</p>
        <p>Flyt eller aflys bookinger under <strong>Aftaler</strong> i Veyro. Ændringerne vises, næste gang din kalenderapp henter kalenderen.</p>
      </div>
    </details>
    <details>
      <summary>Jeg vil undgå bookinger, når jeg er optaget.</summary>
      <div>
        <p>Har du en privat aftale kl. 13–14, skal en kunde heller ikke kunne booke dig fra kl. 12.30 til 13.15. Kunden ser kun de ledige tider.</p>
        <p>Dit personlige kalenderlink viser kundebookinger på din telefon. Det giver ikke Veyro adgang til dine private aftaler. En Gmail-kalender i Apples Kalender-app er stadig en Google-kalender.</p>
        ${showIcloud ? `<h3>Brug din iCloud-kalender</h3>
          <ol>
            <li>Tjek under <strong>Kalendere</strong> på din iPhone, at dine private aftaler ligger under <strong>iCloud</strong>.</li>
            <li>Opret en app-specifik adgangskode på din egen Apple-konto. <a href="https://support.apple.com/da-dk/102654" target="_blank" rel="noopener noreferrer">Se Apples vejledning</a>.</li>
            <li>Under <strong>Blokér tider fra din iCloud-kalender</strong> indtaster du din Apple-e-mail og den app-specifikke adgangskode. Vælg <strong>Forbind min iCloud-kalender</strong>. Hold koden for dig selv, og lad din kalender være privat.</li>
            <li>Markér de private kalendere, der skal blokere tider, og tryk på <strong>Gem kalendervalg</strong>. Lad kalenderen med Veyros kundebookinger stå umarkeret. Aftaler markeret som optaget spærrer din tid.</li>
          </ol>
          <p>Du kan stoppe forbindelsen med <strong>Frakobl iCloud</strong> og derefter tilbagekalde adgangskoden hos Apple. Bruger du Google til dine private aftaler, kan du blokere tiden manuelt nedenfor.</p>` : ''}
        <h3>Blokér tid manuelt</h3>
        <ol>
          <li>Åbn <strong>Bookingtider og pauser</strong>, og gå til <strong>Blokeret tid</strong>. Vælg dit navn under <strong>Medarbejder</strong>, hvis du får et valg.</li>
          <li>Vælg aftalens dato i både <strong>Fra</strong> og <strong>Til</strong>. Angiv fx kl. 13.00 og 14.00, og tryk på <strong>Blokér tid</strong>. Du kan lade <strong>Intern bemærkning</strong> stå tom.</li>
          <li>Tjek, at tidsrummet står under <strong>Blokeret tid</strong>. Flyttes aftalen, så opret den nye blokering først, og vælg <strong>Fjern</strong> ved den gamle. Bliver aftalen aflyst, kan du fjerne blokeringen med det samme.</li>
        </ol>
        <p>Er der allerede en kundebooking i tidsrummet, skal du flytte eller aflyse den særskilt under <strong>Aftaler</strong>.</p>
      </div>
    </details>
  </section>`;
}

export const calendarConnectionGuideCss = `
.calendar-guide{margin:2rem 0;max-width:46rem;line-height:1.6}
.calendar-guide h2{margin-bottom:1rem}
.calendar-guide details{border-top:1px solid #ddd6e8}
.calendar-guide details:last-child{border-bottom:1px solid #ddd6e8}
.calendar-guide summary{cursor:pointer;padding:.95rem .2rem;font-size:1rem;font-weight:650;line-height:1.5}
.calendar-guide details>div{padding:.2rem .2rem 1rem;max-width:65ch}
.calendar-guide p,.calendar-guide ol{margin:0 0 .9rem}
.calendar-guide ol{padding-inline-start:1.5rem}
.calendar-guide li+li{margin-top:.45rem}
.calendar-guide h3{margin:1.15rem 0 .3rem}
.calendar-guide a{color:inherit;text-decoration:underline;text-underline-offset:.15em}
`;
