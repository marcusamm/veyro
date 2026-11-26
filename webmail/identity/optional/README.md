# Telefonkoder til Veyro Konto

En Twilio-prøvekonto giver mulighed for at teste leveringen af en SMS med Twilios egen kode fra **Identity → Verify → Overview → Try out Verify**. Den prøve bruger Twilios testskabelon. Veyros produktionsflow genererer selv koderne i authentik og sender dem via Twilio Messaging. Aktivér det, når kontoen understøtter egen SMS-tekst og har en brugbar afsender. WhatsApp kræver også en godkendt afsender og skabelon. [Twilios prøvebegrænsninger](https://www.twilio.com/docs/usage/trials#pre-defined-content)

En medarbejder i gruppen Veyro Mail kan tilføje SMS eller WhatsApp under sine sikkerhedsindstillinger. Ved tilmelding kræver flowet adgangskoden, en eksisterende anden faktor og en kode modtaget på det valgte telefonnummer. Når Authentik har bekræftet koden, kan medarbejderen vælge telefonen som anden faktor ved login.

Hver kanal har sin egen Compose-fil. Grundinstallationen indlæser alene de kanaler, som en administrator udtrykkeligt tilslutter med en ekstra Compose-fil. Aktivér en kanal, når Veyro har aftalt afsender, omkostninger og et testnummer med ejeren.

| Kanal | Opsætning hos udbyderen | Værdier til opsætningsværktøjet |
| --- | --- | --- |
| SMS | Twilio Messaging med en SMS-afsender, der kan levere til medarbejdernes land. | Account SID, kontoens Auth Token og SMS-afsendernummer |
| WhatsApp | En registreret Twilio WhatsApp-afsender og en godkendt dansk `whatsapp/authentication`-skabelon med kopiknap på samme konto. | Account SID, API Key SID, API Key Secret, skabelonens Content SID og WhatsApp-afsendernummer |

Åbn en interaktiv terminal på identitetsserveren, og kør `sudo /usr/local/sbin/veyro-twilio`. Vælg `sms` eller `whatsapp`, og indtast værdierne ved de skjulte felter. Begge afsendernumre angives med plus og landekode. For WhatsApp bruges en Twilio API-nøgle med `twilio/messaging/messages/create` og en skabelon med præfikset `HX`. Værktøjet understøtter også kontoens Auth Token og opretter selv den interne WhatsApp-nøgle. På en ny identitetsserver installeres værktøjet med `sudo install -m 0755 optional/configure_twilio.py /usr/local/sbin/veyro-twilio`.

Værktøjet gemmer kanalernes filer særskilt under `/etc/veyro-identity/phone-secrets/`. Værtsmappen kræver root, og filerne kan læses af containerens gruppe 1000 via de enkelte monteringer. Ved rotation genskabes de berørte containere, så de læser den nye filversion. For WhatsApp gælder det `worker` og `whatsapp-delivery`, for SMS kun `worker`.

Authentik sender WhatsApp-koden til `whatsapp-delivery` på Compose-netværket. Tjenesten bruger Twilios Messages API over HTTPS med skabelonvariablen `1`. Twilios legitimationsoplysninger til WhatsApp monteres alene i leveringstjenesten.

Administratoren aktiverer den ønskede kanal fra identitetsinstallationens mappe. Vælg rækken for den samlede opsætning, og bevar eventuelle øvrige aktive Compose-filer, fx `compose.recovery.yaml`, ved hver opdatering.

| Aktive telefonkanaler | Kommando |
| --- | --- |
| SMS | `docker compose -f compose.yaml -f compose.sms.yaml up -d` |
| WhatsApp | `docker compose -f compose.yaml -f compose.whatsapp.yaml up -d` |
| Begge | `docker compose -f compose.yaml -f compose.sms.yaml -f compose.whatsapp.yaml up -d` |

Ved første idriftsættelse kontrolleres hver kanal med et godkendt testnummer. Bekræft tilmelding, et nyt login og at en forkert eller genbrugt kode afvises. En leverandørs accept af en API-anmodning er alene en kvittering for afsendelsen.

[Authentiks SMS-enheder](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/authenticator_sms/) · [Twilios WhatsApp-skabeloner til engangskoder](https://www.twilio.com/docs/content/whatsappauthentication) · [Twilios Messages API](https://www.twilio.com/docs/messaging/api/message-resource)
