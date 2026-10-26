// Demodata for StyleByBrothers. Alt herunder kan ændres i adminpanelet (#/admin).
// Priser og åbningstider er fra salonen. Varigheder og medarbejdere er IKKE bekræftet.

export const SALON = {
  name: 'StyleByBrothers',
  legalName: 'StyleByBrothers ApS',
  street: 'Sct. Mikkelsgade 26A',
  city: '4200 Slagelse',
  phone: '+45 61 70 70 44',
  phoneHref: 'tel:+4561707044',
  cvr: '45956989',
  facebook: 'https://www.facebook.com/StyleByBrothers/',
  instagram: 'https://www.instagram.com/stylebybrothers/',
  maps: 'https://www.google.com/maps/search/?api=1&query=Sct.+Mikkelsgade+26A,+4200+Slagelse',
};

// Ugedage: 0 = søndag … 6 = lørdag. Salonens åbningstider: man–ons 11–18, tor–fre 10–18, lør 9–15, søn lukket.
const day = (start, end) => ({ start, end, breakStart: '', breakEnd: '' });

function hours({ off = [] } = {}) {
  const h = {
    0: null,
    1: day('11:00', '18:00'),
    2: day('11:00', '18:00'),
    3: day('11:00', '18:00'),
    4: day('10:00', '18:00'),
    5: day('10:00', '18:00'),
    6: day('09:00', '15:00'),
  };
  for (const d of off) h[d] = null;
  return h;
}

export function defaultState() {
  return {
    version: 4,
    settings: {
      slotStep: 15,
      minNoticeMinutes: 60,
      maxDaysAhead: 30,
      bufferMinutes: 0,
      cancelNoticeMinutes: 120,
      closedDates: [
        { date: '2026-12-24', note: 'Juleaften' },
        { date: '2026-12-25', note: 'Juledag' },
        { date: '2026-12-26', note: '2. juledag' },
        { date: '2026-12-31', note: 'Nytårsaften' },
        { date: '2027-01-01', note: 'Nytårsdag' },
      ],
      bookingProvider: 'demo',
    },
    // Priser fra salonen. Varighederne er et skøn og skal bekræftes.
    services: [
      { id: 'herreklip', name: 'Herreklip', desc: 'Med saks eller maskine, også fades.', duration: 30, price: 250, active: true },
      { id: 'skaeg', name: 'Skæg', desc: 'Trim og kontur.', duration: 20, price: 100, active: true },
      { id: 'haarvask', name: 'Hårvask', desc: 'Kan lægges oven i et klip.', duration: 10, price: 50, active: true },
      { id: 'bryllupsklip', name: 'Bryllupsklip', desc: 'Klip og skæg til den store dag.', duration: 90, price: 1000, active: true },
    ],
    // Pladsholdere: navne og billeder leveres af ejeren.
    barbers: [
      { id: 'b1', name: 'Frisør 1', role: 'Fades og skæg', photo: '', active: true, serviceIds: ['herreklip', 'skaeg', 'haarvask', 'bryllupsklip'], hours: hours(), absences: [] },
      { id: 'b2', name: 'Frisør 2', role: 'Klassiske klip', photo: '', active: true, serviceIds: ['herreklip', 'skaeg', 'haarvask', 'bryllupsklip'], hours: hours(), absences: [] },
      { id: 'b3', name: 'Frisør 3', role: 'Skin fades', photo: '', active: true, serviceIds: ['herreklip', 'skaeg', 'haarvask', 'bryllupsklip'], hours: hours(), absences: [] },
    ],
    // Billedpladser. Salonen uploader sine egne billeder under Admin → Billeder.
    photos: {
      hero: { src: 'img/kroeller-taper.jpg', note: 'Foto fra salonen: en frisør i gang ved stolen' },
      salon: { src: 'img/salonen.jpg', note: 'Salonen indefra' },
      facade: { src: '', note: 'Facaden på Sct. Mikkelsgade 26A' },
    },
    // Salonens egne billeder (fra Facebook). Ejeren skal godkende brugen, før siden går live.
    gallery: [
      { id: 'g1', title: 'High fade med skæg', src: 'img/high-fade-skaeg.jpg' },
      { id: 'g2', title: 'Slick back med lav fade', src: 'img/slick-back.jpg' },
      { id: 'g3', title: 'Mid fade med skæg', src: 'img/mid-fade-skaeg.jpg' },
      { id: 'g4', title: 'Taper fade', src: 'img/taper-tekstur.jpg' },
    ],
    bookings: [],
    outbox: [],
  };
}
