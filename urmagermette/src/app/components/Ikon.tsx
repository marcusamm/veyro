// Enkle stregikoner (egne tegninger)
const STIER = {
  ur: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3.5 2',
  kalender: 'M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v10a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-10ZM4 10h16M8 3v4M16 3v4',
  telefon: 'M5 4.5C5 3.7 5.7 3 6.5 3h2.1c.6 0 1.2.4 1.4 1l.9 2.8c.2.6 0 1.2-.5 1.6L9 9.6a11 11 0 0 0 5.4 5.4l1.2-1.4c.4-.5 1-.7 1.6-.5l2.8.9c.6.2 1 .8 1 1.4v2.1c0 .8-.7 1.5-1.5 1.5C11.4 19 5 12.6 5 4.5Z',
  mail: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11Zm.5.5 7.5 6 7.5-6',
  sted: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  pil: 'M5 12h14m-5-5 5 5-5 5',
  pilVenstre: 'M19 12H5m5-5-5 5 5 5',
  tjek: 'm5 12.5 4.5 4.5L19 7.5',
  luk: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  rute: 'M5 19 19 5m0 0h-9m9 0v9',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5v-5m0-3h.01',
  billede: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11Zm0 9 4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01',
  lup: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Zm5.5-2 5 5',
  vaerktoej: 'M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5Zm0 0L17 4M5 4l4 4M4 5l1-1',
  hjem: 'M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5V11Z',
  liste: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  indstillinger: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  besked: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4V5.5Z',
  download: 'M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14',
  ud: 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4m-4 4h10',
  slet: 'M5 7h14M10 11v6m4-6v6M6.5 7l1 12.5h9l1-12.5M9.5 7V4.5h5V7',
  noter: 'M6 3.5h9l4 4V20a.5.5 0 0 1-.5.5h-12A.5.5 0 0 1 6 20V3.5Zm9 0V8h4M9 12h6m-6 4h6',
  hjerte: 'M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.2 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z',
  tradition: 'M12 3 4 7v2h16V7l-8-4ZM6 10v7m4-7v7m4-7v7m4-7v7M4 20h16',
} as const;

export type IkonNavn = keyof typeof STIER;

export function Ikon({ navn, className = 'h-5 w-5', strøg = 1.6 }: { navn: IkonNavn; className?: string; strøg?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strøg} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={STIER[navn]} />
    </svg>
  );
}
