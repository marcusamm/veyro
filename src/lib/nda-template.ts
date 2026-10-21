/**
 * Standardskabelonen for Veyros gensidige fortrolighedsaftale (NDA).
 *
 * Teksten er hentet fra "Veyro_fortrolighedsaftale.docx" (version 1). Nye versioner oprettes i admin
 * og gemmes i tabellen nda_templates. Hver aftaleversion gemmer en fuld kopi af teksten, så en ny
 * skabelon aldrig ændrer en eksisterende aftale.
 *
 * Opmærkning (én linje pr. element):
 *   "# Overskrift"   afsnitsoverskrift
 *   "- tekst"        punkt i en liste
 *   "[PROJEKT]"      her indsættes beskrivelsen af det konkrete projekt
 *   tom linje        adskiller afsnit; øvrige linjer er brødtekst
 * Parternes oplysninger og godkendelserne indsættes automatisk før og efter teksten.
 */

export const NDA_TITLE = 'Fortrolighedsaftale';
export const NDA_SUBTITLE = 'Gensidig aftale om oplysninger delt ved udvikling og drift af digitale løsninger';

export const DEFAULT_TEMPLATE_BODY = `Aftalen beskytter begge parters fortrolige oplysninger i det nedenfor beskrevne samarbejde. Aftalen omfatter både indledende drøftelser og et eventuelt efterfølgende samarbejde.

Parterne kaldes samlet "Parterne". Den part, der deler oplysninger, kaldes "Afgiver", og den part, der modtager dem, kaldes "Modtager". Begge parter kan have begge roller.

# 1 Formål
Formålet er at vurdere, planlægge og gennemføre et samarbejde om hjemmesidedesign, udvikling, integration, vedligeholdelse eller drift af digitale løsninger. Det kan omfatte lagerstyring, vareforbrug, job- og ordrestyring, indkøbslister, prisestimering, bilag og faktureringsgrundlag, i det omfang det indgår i det konkrete projekt.

[PROJEKT]

Oplysninger må alene anvendes til dette formål. Aftalen forpligter ikke Parterne til at købe eller levere ydelser. Leverancer, priser, brugsrettigheder og eventuel fuldmagt aftales særskilt.

# 2 Pligt til fortrolighed
Fortrolige oplysninger er ikke-offentlige oplysninger, som Afgiver deler i forbindelse med formålet, og som er markeret fortrolige, eller som Modtager efter deres karakter eller omstændighederne med rimelighed bør forstå er fortrolige. Beskyttelsen gælder uanset, om oplysningerne deles mundtligt, skriftligt, digitalt eller gennem adgang til et system.

For Veyro omfatter det eksempelvis kildekode, systemarkitektur, ikke-offentliggjorte design og prototyper, integrationsmetoder, udviklingsplaner, tilbud og interne priser. For kunden omfatter det eksempelvis kundelister, leverandøraftaler, indkøbspriser, lagerdata, joboplysninger, bilag og interne arbejdsgange. Loginoplysninger, API-nøgler og oplysninger om sikkerhed er også omfattet.

Modtager skal beskytte oplysningerne med mindst samme omhu som egne fortrolige oplysninger og altid med rimelig omhu. Adgang skal begrænses til det nødvendige, og oplysningerne skal opbevares og overføres forsvarligt.

Modtager må kun give adgang til medarbejdere og ledelse, som har et konkret behov for oplysningerne til formålet, og som er bundet af tilsvarende fortrolighed. Nødvendige rådgivere samt hosting- og andre underleverandører må alene få relevante oplysninger under tilsvarende fortrolighedsforpligtelser. Modtager er ansvarlig for disse personers og leverandørers overholdelse af aftalen.

Anden videregivelse kræver Afgivers forudgående skriftlige samtykke. Fortrolige oplysninger må ikke lægges i offentlige kodearkiver eller bruges til offentlig markedsføring, kundecases eller træning af generelle AI-modeller uden særskilt skriftlig tilladelse. Brug af eksterne AI-tjenester til behandling af oplysninger kræver Afgivers forudgående skriftlige godkendelse af tjenesten og anvendelsen.

Modtager skal uden unødigt ophold underrette Afgiver om konstateret uautoriseret adgang, brug eller videregivelse og medvirke til at begrænse følgerne.

Aftalen overdrager ikke ejerskab, ophavsret eller andre immaterielle rettigheder. Den giver alene adgang til at bruge oplysningerne til formålet. Eventuelle rettigheder til kode, design og leverancer aftales særskilt.

Aftalen erstatter ikke en databehandleraftale. Hvor Veyro behandler personoplysninger som databehandler, skal den nødvendige databehandleraftale være indgået, før behandlingen påbegyndes. Den regulerer blandt andet instrukser, sikkerhed, underdatabehandlere og sletning og går ved modstrid forud for denne aftale for så vidt angår behandlingen af personoplysninger.

# 3 Undtagelser fra fortrolighedspligten
Fortrolighedspligten omfatter ikke oplysninger, som Modtager kan dokumentere:

- var offentligt tilgængelige ved modtagelsen eller senere bliver det uden brud på aftalen;
- allerede var i Modtagers lovlige besiddelse uden en fortrolighedsforpligtelse;
- lovligt er modtaget fra tredjemand uden fortrolighedspligt og uden kendt brud på andres forpligtelser; eller
- er udviklet selvstændigt uden brug af Afgivers fortrolige oplysninger.

Afgiver kan skriftligt tillade en nærmere angivet brug eller videregivelse. Lovpligtig videregivelse og videregivelse efter gyldig myndigheds- eller domstolsafgørelse er tilladt i nødvendigt omfang. Afgiver skal, hvis det er lovligt, orienteres før videregivelsen eller ellers snarest muligt. Aftalen begrænser ikke lovligt beskyttede indberetninger om ulovlige forhold.

# 4 Varighed og håndtering ved ophør
Aftalen træder i kraft ved den sidste underskrift. Hver part kan skriftligt afslutte aftalen for fremtidig udveksling af oplysninger. For allerede modtagne oplysninger gælder fortroligheds- og anvendelsesbegrænsningerne under samarbejdet og i fem år efter det seneste af samarbejdets ophør eller aftalens ophør. Hvis et samarbejde ikke indledes, regnes de fem år fra aftalens ophør.

For oplysninger, der udgør forretningshemmeligheder efter gældende ret, fortsætter beskyttelsen, så længe oplysningerne har denne karakter. Undtagelserne i punkt 3 gælder fortsat. Ophør af en fuldmagt eller sletning af aftalen i en portal ophæver ikke disse forpligtelser.

Efter Afgivers skriftlige anmodning eller ved samarbejdets ophør skal Modtager uden unødigt ophold returnere eller slette oplysninger og kopier efter Afgivers valg. Oplysninger må dog beholdes, så længe det er nødvendigt for udtrykkeligt aftalte, fortsatte opgaver, lovpligtig opbevaring eller fastlæggelse, udøvelse eller forsvar af retskrav. Adgangen skal begrænses, og oplysningerne må ikke bruges til andre formål.

Kopier i rutinemæssige sikkerhedskopier, som ikke kan slettes enkeltvis på forsvarlig vis, slettes ved den dokumenterede backupcyklus og må ikke anvendes aktivt. Ved gendannelse skal den aftalte sletning genanvendes. Modtager skal på anmodning bekræfte håndteringen og oplyse om eventuelle tilbageholdte kopier, begrundelsen og slettefristen. Fortroligheden gælder, så længe sådanne kopier beholdes. Personoplysninger håndteres efter gældende regler og en eventuel databehandleraftale.

# 5 Overtrædelse af aftalen
Overtrædelse kan medføre erstatning og andre misligholdelsesbeføjelser efter dansk rets almindelige regler. Der er ikke aftalt en fast bod. Betaling af erstatning giver ikke ret til at fortsætte en overtrædelse. Den berørte part kan anmode retten om midlertidigt forbud eller påbud, når lovens betingelser er opfyldt.

# 6 Lovvalg og tvister
Aftalen er underlagt dansk ret, dog undtaget de danske lovvalgsregler. Parterne skal først forsøge at løse en uenighed ved forhandling. Hvis dette ikke lykkes, kan tvisten indbringes for de kompetente danske domstole efter retsplejelovens regler. Forhandling er ikke en betingelse for at søge midlertidigt forbud eller påbud.

# 7 Underskrifter
Underskriverne bekræfter at være bemyndigede til at indgå aftalen på deres virksomheds vegne. Aftalen kan underskrives fysisk eller elektronisk, og begge parter skal modtage en kopi.`;

export const DEFAULT_TEMPLATE_FOOTNOTE =
  'Tilpasset fra Patent- og Varemærkestyrelsens skabelon Fortrolighedserklæring PVS. Denne version er tilpasset Veyro og er ikke godkendt af styrelsen. Udkastet bør vurderes i forhold til det konkrete samarbejde.';

export type Block =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'project' };

/** Opdeler skabelonteksten i blokke. Ukendt opmærkning behandles som almindelig tekst. */
export function parseTemplate(body: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'para', text: para.join(' ') });
    if (bullets.length) blocks.push({ kind: 'bullets', items: bullets });
    para = [];
    bullets = [];
  };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (line.startsWith('# ')) {
      flush();
      blocks.push({ kind: 'heading', text: line.slice(2).trim() });
    } else if (line === '[PROJEKT]') {
      flush();
      blocks.push({ kind: 'project' });
    } else if (/^[-•]\s+/.test(line)) {
      if (para.length) {
        blocks.push({ kind: 'para', text: para.join(' ') });
        para = [];
      }
      bullets.push(line.replace(/^[-•]\s+/, ''));
    } else {
      if (bullets.length) {
        blocks.push({ kind: 'bullets', items: bullets });
        bullets = [];
      }
      para.push(line);
    }
  }
  flush();
  return blocks;
}

/** Overskrifterne i skabelonen (bruges til indholdsfortegnelse og til at kontrollere en ny skabelon). */
export function templateHeadings(body: string): string[] {
  return parseTemplate(body)
    .filter((b): b is { kind: 'heading'; text: string } => b.kind === 'heading')
    .map((b) => b.text);
}
