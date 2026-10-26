// Startdata for StyleByBrothers. Behandlinger, frisører, tider og regler gemmes på serveren og ændres i admin (#/admin).
// Priser og åbningstider er fra salonen. Varighederne er et skøn, som salonen kan rette i admin.

export const SALON = {
  name: 'StyleByBrothers',
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

// Faste billeder fra salonen. De ændres i koden, ikke i admin.
export const PHOTOS = {
  hero: { src: 'img/salonen.jpg', note: 'Salonen indefra' },
  salon: { src: 'img/kroeller-taper.jpg', note: 'Klipning med krøller og taper fade' },
};
// Billede på hvert behandlingskort på forsiden.
export const SERVICE_PHOTOS = {
  herreklip: 'img/taper-tekstur.jpg',
  skaeg: 'img/mid-fade-skaeg.jpg',
  haarvask: 'img/slick-back.jpg',
  bryllupsklip: 'img/high-fade-skaeg.jpg',
};

const ALL = ['herreklip', 'skaeg', 'haarvask', 'bryllupsklip'];

export function defaultState() {
  return {
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
      // Kunden vælger ikke frisør; hver "stol" er en kalender, så to kunder kan klippes samtidig.
      chooseBarber: false,
      notifyEmails: [],
      externalBookingUrl: '',
    },
    services: [
      { id: 'herreklip', name: 'Herreklip', desc: 'Med saks eller maskine, også fades.', duration: 30, price: 250, active: true },
      { id: 'skaeg', name: 'Skæg', desc: 'Trim og kontur.', duration: 20, price: 100, active: true },
      { id: 'haarvask', name: 'Hårvask', desc: 'Kan lægges oven i et klip.', duration: 10, price: 50, active: true },
      { id: 'bryllupsklip', name: 'Bryllupsklip', desc: 'Klip og skæg til den store dag.', duration: 90, price: 1000, active: true },
    ],
    barbers: [
      { id: 'b1', name: 'Stol 1', role: '', active: true, serviceIds: ALL, hours: hours(), absences: [] },
      { id: 'b2', name: 'Stol 2', role: '', active: true, serviceIds: ALL, hours: hours(), absences: [] },
    ],
    bookings: [],
  };
}
