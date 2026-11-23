// Billeder på siden. Alle er frit licenserede (se /billedkilder) og forestiller ikke Mette eller hendes værksted.
export interface Billede {
  src: string;
  alt: string;
  b: number;
  h: number;
}

const B = (navn: string, alt: string, b = 1600, h = 1067): Billede => ({ src: `/billeder/${navn}.jpg`, alt, b, h });

export const BILLEDER = {
  hero: B('hero', 'Nærbillede af skiven på et klassisk taffelur med blå visere og synligt urværk', 2000, 1200),
  urvaerk: B('urvaerk', 'Makrofoto af tandhjul og juveler i et mekanisk urværk', 1200, 1500),
  vaerktoej: B('vaerktoej', 'Værket fra et ældre standur med slagværk og klokker', 1200, 1200),
  armbaandsur: B('armbaandsur', 'Mekanisk armbåndsur på et træbord', 1200, 900),
  vintageur: B('vintageur', 'Ældre armbåndsur med firkantet kasse', 1200, 900),
  lommeur: B('lommeur', 'Åbent lommeur, hvor urværket ses', 1200, 900),
  bornholmerur: B('bornholmerur', 'Skiven på et bornholmerur med forgyldt ramme', 1200, 900),
  taffelur: B('taffelur', 'Forgyldt skive på et klassisk taffelur', 1200, 900),
  stueur: B('stueur', 'Skiven på et standur i mahognikasse', 1200, 900),
  vaerksted: B('vaerksted', 'Arbejdsbord med værktøj i et urmagerværksted', 1600, 1200),
} satisfies Record<string, Billede>;

export type BilledNavn = keyof typeof BILLEDER;
