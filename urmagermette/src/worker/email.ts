// E-mails til kunder og værkstedet. I demotilstand (eller uden RESEND_API_KEY) sendes intet:
// mailen gemmes i "udbakken" med status "ikke sendt", så det kan ses, hvad der ville blive sendt.
import { datoLang, klok } from '../shared/tid';
import { VIRKSOMHED } from '../shared/virksomhed';
import type { Booking } from '../shared/typer';

export interface Mail {
  til: string;
  emne: string;
  tekst: string;
}

const adresse = `${VIRKSOMHED.navn}, ${VIRKSOMHED.adresse}, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}`;

function tid(b: Booking): string {
  return `${datoLang(b.dato)} kl. ${klok(b.start)}`;
}

function bund(link: string): string {
  return `\n\nSe eller afbestil din tid: ${link}\n\nVenlig hilsen\n${VIRKSOMHED.navn}\n${adresse}\nTlf. ${VIRKSOMHED.telefon}\n${VIRKSOMHED.email}`;
}

export function mailAnmodningModtaget(b: Booking, link: string): Mail {
  return {
    til: b.email,
    emne: `Vi har modtaget din anmodning (${b.ref})`,
    tekst:
      `Kære ${b.navn}\n\nTak for din anmodning om en tid hos ${VIRKSOMHED.navn}.\n\n` +
      `Ønsket tid: ${tid(b)}\nYdelse: ${b.ydelseNavn}\nReference: ${b.ref}\n\n` +
      `Bemærk: Tiden er endnu ikke bekræftet. Du får besked, når den er godkendt.\n` +
      `Tiden er til indlevering, konsultation eller vurdering – ikke nødvendigvis selve reparationen.` +
      bund(link),
  };
}

export function mailBekraeftet(b: Booking, link: string): Mail {
  return {
    til: b.email,
    emne: `Din tid er bekræftet: ${tid(b)}`,
    tekst:
      `Kære ${b.navn}\n\nDin tid hos ${VIRKSOMHED.navn} er nu bekræftet.\n\n` +
      `Tid: ${tid(b)}\nAdresse: ${VIRKSOMHED.adresse}, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}\nYdelse: ${b.ydelseNavn}\nReference: ${b.ref}\n\n` +
      `Kan du ikke komme, må du meget gerne afbestille via linket herunder eller ringe på ${VIRKSOMHED.telefon}.` +
      bund(link),
  };
}

export function mailFlyttet(b: Booking, link: string): Mail {
  return {
    til: b.email,
    emne: `Din tid er flyttet: ${tid(b)}`,
    tekst: `Kære ${b.navn}\n\nDin tid hos ${VIRKSOMHED.navn} er flyttet.\n\nNy tid: ${tid(b)}\nAdresse: ${VIRKSOMHED.adresse}, ${VIRKSOMHED.postnr} ${VIRKSOMHED.by}\nReference: ${b.ref}` + bund(link),
  };
}

export function mailAfvist(b: Booking, besked: string): Mail {
  return {
    til: b.email,
    emne: `Vedrørende din anmodning (${b.ref})`,
    tekst:
      `Kære ${b.navn}\n\nDesværre kan vi ikke tilbyde den ønskede tid (${tid(b)}).\n` +
      (besked ? `\n${besked}\n` : '') +
      `\nDu er velkommen til at vælge en anden tid på hjemmesiden eller ringe på ${VIRKSOMHED.telefon}.\n\nVenlig hilsen\n${VIRKSOMHED.navn}`,
  };
}

export function mailAflyst(b: Booking, besked: string, afKunde: boolean): Mail {
  return {
    til: b.email,
    emne: `Din tid er aflyst (${b.ref})`,
    tekst:
      `Kære ${b.navn}\n\n` +
      (afKunde ? `Vi bekræfter, at du har afbestilt din tid ${tid(b)}.\n` : `Din tid ${tid(b)} er desværre aflyst.\n`) +
      (besked ? `\n${besked}\n` : '') +
      `\nVenlig hilsen\n${VIRKSOMHED.navn}\nTlf. ${VIRKSOMHED.telefon}`,
  };
}

export function mailTilVaerksted(b: Booking, til: string, adminLink: string): Mail {
  return {
    til,
    emne: `Ny bookinganmodning: ${tid(b)} (${b.ydelseNavn})`,
    tekst: `Ny anmodning fra ${b.navn} (${b.telefon}, ${b.email}).\n\nYdelse: ${b.ydelseNavn}\nTid: ${tid(b)}\nUrtype: ${b.urtype}${b.maerke ? `, ${b.maerke}` : ''}\n\n${b.beskrivelse}\n\nGodkend eller afvis: ${adminLink}`,
  };
}

export interface MailEnv {
  DEMO_MODE?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
}

/** Sender via Resend. Returnerer status, som gemmes i udbakken. */
export async function sendMail(env: MailEnv, m: Mail): Promise<'sendt' | 'ikke_sendt_demo' | 'fejl'> {
  if (env.DEMO_MODE === '1' || !env.RESEND_API_KEY || !env.EMAIL_FROM) return 'ikke_sendt_demo';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [m.til], subject: m.emne, text: m.tekst, reply_to: VIRKSOMHED.email }),
    });
    return res.ok ? 'sendt' : 'fejl';
  } catch {
    return 'fejl';
  }
}
