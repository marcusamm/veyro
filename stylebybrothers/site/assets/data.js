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
    version: 1,
    settings: {
      slotStep: 15,
      minNoticeMinutes: 60,
      maxDaysAhead: 30,
      bufferMinutes: 0,
      cancelNoticeMinutes: 120,
      // Åbningstider til visning. Kilde: salonens Instagram-profil (okt. 2026) — skal bekræftes.
      openingHours: [
        { label: 'Mandag – fredag', value: '11:30 – 17:30' },
        { label: 'Lørdag', value: '11:30 – 14:30' },
        { label: 'Søndag', value: 'Lukket' },
      ],
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
      { id: 'herreklip', name: 'Herreklip', desc: 'Klassisk klip med saks og maskine, vask og styling efter dine ønsker.', duration: 30, price: 250, active: true },
      { id: 'skin-fade', name: 'Skin fade', desc: 'Fade helt ned til huden med skarpe, rene overgange og præcis kontur.', duration: 45, price: 300, active: true },
      { id: 'taper-fade', name: 'Taper fade', desc: 'Diskret, gradvis overgang ved tindinger og nakke. Rent og tidløst.', duration: 40, price: 280, active: true },
      { id: 'skaeg', name: 'Skægtrimning', desc: 'Formning, trim og skarpe linjer med kniv. Afsluttes med skægolie.', duration: 20, price: 150, active: true },
      { id: 'haar-skaeg', name: 'Hår og skæg', desc: 'Den komplette behandling: klip eller fade plus skægtrim og konturer.', duration: 60, price: 380, active: true },
      { id: 'boerneklip', name: 'Børneklip', desc: 'Klip til børn under 12 år. Roligt tempo og samme præcision.', duration: 25, price: 180, active: true },
    ],
    // Pladsholdere: navne og billeder leveres af ejeren.
    barbers: [
      { id: 'b1', name: 'Barber 1', role: 'Fades og skæg', photo: '', active: true, serviceIds: ['herreklip', 'skin-fade', 'taper-fade', 'skaeg', 'haar-skaeg', 'boerneklip'], hours: hours(), absences: [] },
      { id: 'b2', name: 'Barber 2', role: 'Klassiske klip', photo: '', active: true, serviceIds: ['herreklip', 'taper-fade', 'skaeg', 'haar-skaeg', 'boerneklip'], hours: hours({ off: [1] }), absences: [] },
      { id: 'b3', name: 'Barber 3', role: 'Skin fades', photo: '', active: true, serviceIds: ['herreklip', 'skin-fade', 'taper-fade', 'haar-skaeg'], hours: hours({ off: [3, 6] }), absences: [] },
    ],
    gallery: [
      { id: 'g1', category: 'fades', title: 'Skin fade', src: 'img/galleri-skin-fade.jpg' },
      { id: 'g2', category: 'klassisk', title: 'Klassisk side part', src: 'img/galleri-klassisk.jpg' },
      { id: 'g3', category: 'skaeg', title: 'Skægkontur', src: 'img/galleri-skaeg.jpg' },
      { id: 'g4', category: 'styling', title: 'Textured crop', src: 'img/galleri-crop.jpg' },
      { id: 'g5', category: 'fades', title: 'Taper fade', src: 'img/galleri-taper.jpg' },
      { id: 'g6', category: 'foer-efter', title: 'Før og efter', src: 'img/galleri-foer-efter.jpg' },
      { id: 'g7', category: 'styling', title: 'Slick back', src: 'img/galleri-slick.jpg' },
      { id: 'g8', category: 'skaeg', title: 'Fuldskæg', src: 'img/galleri-fuldskaeg.jpg' },
      { id: 'g9', category: 'klassisk', title: 'Gentleman cut', src: 'img/galleri-gentleman.jpg' },
    ],
    bookings: [],
    outbox: [],
  };
}

export const GALLERY_CATEGORIES = [
  { id: 'alle', label: 'Alle' },
  { id: 'fades', label: 'Fades' },
  { id: 'klassisk', label: 'Klassiske klipninger' },
  { id: 'skaeg', label: 'Skæg' },
  { id: 'styling', label: 'Styling' },
  { id: 'foer-efter', label: 'Før og efter' },
];
