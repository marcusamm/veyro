# Veyro Mail til iPhone

En SwiftUI-app til iOS 17 og nyere. Log ind med en eksisterende Veyro-postkasse på `mail.veyro.dk`. Appen bruger den samme mailserver og de samme mapper som webmailen.

## Kør appen

1. Åbn `VeyroMail.xcodeproj` på en Mac med Xcode 16 eller nyere og en installeret iOS-simulator.
2. Vælg ordningen **VeyroMail** og en iPhone i Xcodes liste over enheder.
3. Tryk **⌘R** for at bygge og starte appen. **⌘U** kører testene med fiktive postkasser.

Vil du installere appen på din egen iPhone, skal du tilslutte den til Mac’en. Tilføj din Apple-konto i Xcode, vælg dit team under **VeyroMail → Signing & Capabilities**, og vælg telefonen som kørselsmål. Følg telefonens anvisning om Developer Mode, hvis den vises. Projektets bundle-id er `dk.veyro.mail`. Til en personlig test kan du vælge et unikt bundle-id, hvis Xcode oplyser, at dit team ikke kan registrere det. [Apples vejledning til simulator og iPhone](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)

## Brug

- Åbn en mappe, og søg efter mails. Når du åbner en mail, kan du svare, videresende den eller gemme en vedhæftet fil i Arkiver. Stryg på en mail i listen for at markere den som læst eller ulæst, arkivere den eller flytte den til papirkurven.
- Skriv og send mail fra din egen postkasse. Hvis forbindelsen afbrydes under afsendelse, kan du tjekke mappen Sendt. Prøver du igen fra den åbne kladde med samme indhold, genbruger appen afsendelsesnøglen, så mailserveren kan genkende forsøget.
- Brug **Glemt adgangskode?** på loginskærmen til en konto med en tilknyttet gendannelsesmail. En virksomhedsadministrator kan også nulstille medarbejderens adgangskode.

Appen gemmer sessionens adgangsnøgle i iPhones nøglering. Mailserveren bestemmer, hvornår sessionen udløber. Appen kræver netforbindelse for at hente og sende mail.
