// Titler og beskrivelser til søgemaskiner (lokal SEO: urmager Slagelse m.m.)
export interface SideMeta {
  titel: string;
  beskrivelse: string;
}

export const SEO: Record<string, SideMeta> = {
  '/': {
    titel: 'Urmager i Slagelse – reparation og service af ure | UrmagerMette',
    beskrivelse: 'UrmagerMette på Holbækvej i Slagelse: reparation og service af armbåndsure, vintageure, lommeure, bornholmerure, taffelure og stueure. Bestil tid online.',
  },
  '/ydelser': {
    titel: 'Urreparation i Slagelse – ydelser | UrmagerMette',
    beskrivelse: 'Urreparation i Slagelse: service og reparation af armbåndsure, vintageure og lommeure samt reparation af bornholmerure, taffelure og stueure. Pris efter vurdering.',
  },
  '/saadan-foregaar-det': {
    titel: 'Sådan foregår en urreparation | UrmagerMette, Slagelse',
    beskrivelse: 'Fra tidsbestilling til afhentning: Sådan foregår indlevering, vurdering og reparation af dit ur hos UrmagerMette i Slagelse.',
  },
  '/om': {
    titel: 'Om værkstedet | UrmagerMette, urmager i Slagelse',
    beskrivelse: 'Et lokalt urmagerværksted i Slagelse med omsorg for gamle og nye ure og respekt for håndværket.',
  },
  '/faq': {
    titel: 'Spørgsmål om tidsbestilling og reparation | UrmagerMette',
    beskrivelse: 'Svar på spørgsmål om tidsbestilling, indlevering, vurdering og pris på reparation af ure hos UrmagerMette i Slagelse.',
  },
  '/kontakt': {
    titel: 'Kontakt og find værkstedet | UrmagerMette, Holbækvej 54, Slagelse',
    beskrivelse: 'Find UrmagerMette på Holbækvej 54, 4200 Slagelse. Ring på +45 61 67 77 06, skriv til urmagermette@gmail.com, eller bestil tid online.',
  },
  '/bestil': {
    titel: 'Bestil tid hos urmageren i Slagelse | UrmagerMette',
    beskrivelse: 'Bestil tid online til indlevering eller vurdering af dit ur – armbåndsur, lommeur, bornholmerur, stueur m.m. Ingen brugeroprettelse.',
  },
  '/privatliv': { titel: 'Privatlivspolitik | UrmagerMette', beskrivelse: 'Sådan behandler UrmagerMette dine personoplysninger.' },
  '/billedkilder': { titel: 'Billedkilder | UrmagerMette', beskrivelse: 'Licenser og ophav for billederne på hjemmesiden.' },
  '/404': { titel: 'Siden blev ikke fundet | UrmagerMette', beskrivelse: 'Siden findes ikke.' },
};

export const OFFENTLIGE_SIDER = Object.keys(SEO).filter((s) => s !== '/404');
