// Demodata for StyleByBrothers. Alt herunder kan ændres i adminpanelet (#/admin).
// Priser, varigheder, medarbejdere og åbningstider er IKKE bekræftet af ejeren.

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

// Ugedage: 0 = søndag … 6 = lørdag.
const weekdays = (start, end, breakStart, breakEnd) => ({ start, end, breakStart, breakEnd });

function hours({ off = [] } = {}) {
  const h = {
    0: null,
    1: weekdays('11:30', '17:30', '14:00', '14:30'),
    2: weekdays('11:30', '17:30', '14:00', '14:30'),
    3: weekdays('11:30', '17:30', '14:00', '14:30'),
    4: weekdays('11:30', '17:30', '14:00', '14:30'),
    5: weekdays('11:30', '17:30', '14:00', '14:30'),
    6: weekdays('11:30', '14:30', '', ''),
  };
  for (const d of off) h[d] = null;
  return h;
}

export function defaultState() {
  return {
    version: 3,
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
    services: [
      { id: 'herreklip', name: 'Herreklip', desc: 'Med saks eller maskine.', duration: 30, price: 250, active: true },
      { id: 'skin-fade', name: 'Skin fade', desc: 'Fade helt ned til huden.', duration: 45, price: 300, active: true },
      { id: 'taper-fade', name: 'Taper fade', desc: 'Gradvis overgang ved tindinger og nakke.', duration: 40, price: 280, active: true },
      { id: 'skaeg', name: 'Skægtrimning', desc: 'Trim og kontur med kniv.', duration: 20, price: 150, active: true },
      { id: 'haar-skaeg', name: 'Hår og skæg', desc: 'Klip eller fade og skægtrimning.', duration: 60, price: 380, active: true },
      { id: 'boerneklip', name: 'Børneklip', desc: 'Til børn under 12 år.', duration: 25, price: 180, active: true },
    ],
    // Pladsholdere: navne og billeder leveres af ejeren.
    barbers: [
      { id: 'b1', name: 'Frisør 1', role: 'Fades og skæg', photo: '', active: true, serviceIds: ['herreklip', 'skin-fade', 'taper-fade', 'skaeg', 'haar-skaeg', 'boerneklip'], hours: hours(), absences: [] },
      { id: 'b2', name: 'Frisør 2', role: 'Klassiske klip', photo: '', active: true, serviceIds: ['herreklip', 'taper-fade', 'skaeg', 'haar-skaeg', 'boerneklip'], hours: hours({ off: [1] }), absences: [] },
      { id: 'b3', name: 'Frisør 3', role: 'Skin fades', photo: '', active: true, serviceIds: ['herreklip', 'skin-fade', 'taper-fade', 'haar-skaeg'], hours: hours({ off: [3, 6] }), absences: [] },
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
