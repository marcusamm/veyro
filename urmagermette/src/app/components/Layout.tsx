import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { DEMO } from '../demo';
import { VIRKSOMHED } from '../../shared/virksomhed';
import { Ikon } from './Ikon';

export function Logo({ lys = false }: { lys?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg viewBox="0 0 40 40" className="h-9 w-9 shrink-0" aria-hidden="true">
        <circle cx="20" cy="20" r="18.5" fill="none" stroke={lys ? '#c8a96f' : '#a9844c'} strokeWidth="1.3" />
        <circle cx="20" cy="20" r="14.5" fill="none" stroke={lys ? '#f7f3ea' : '#1f3a2e'} strokeWidth="1" opacity=".5" />
        {Array.from({ length: 12 }, (_, i) => (
          <line key={i} x1="20" y1="7.2" x2="20" y2={i % 3 === 0 ? '9.6' : '8.4'} stroke={lys ? '#f7f3ea' : '#1f3a2e'} strokeWidth={i % 3 === 0 ? 1.4 : 0.9} transform={`rotate(${i * 30} 20 20)`} />
        ))}
        <path d="M20 20V11.5M20 20l5.5 3.6" stroke={lys ? '#f7f3ea' : '#1f3a2e'} strokeWidth="1.6" strokeLinecap="round" fill="none" />
        <circle cx="20" cy="20" r="1.6" fill={lys ? '#c8a96f' : '#a9844c'} />
      </svg>
      <span className={`font-serif text-[1.55rem] leading-none tracking-[0.01em] ${lys ? 'text-creme' : 'text-groen'}`}>
        Urmager<span className="italic text-messing">Mette</span>
      </span>
    </span>
  );
}

export function DemoBanner() {
  if (!DEMO) return null;
  return (
    <div className="bg-groen-moerk px-4 py-2 text-center text-[0.85rem] leading-snug text-creme/90">
      <strong className="font-semibold text-messing-lys">Uofficiel demo.</strong> Denne side er et forslag og ikke UrmagerMettes officielle hjemmeside.
      Bookinger og beskeder er kun til test og sendes ikke videre.
    </div>
  );
}

const MENU = [
  { til: '/', tekst: 'Forside' },
  { til: '/ydelser', tekst: 'Ydelser' },
  { til: '/saadan-foregaar-det', tekst: 'Sådan foregår det' },
  { til: '/om', tekst: 'Om værkstedet' },
  { til: '/faq', tekst: 'Spørgsmål' },
  { til: '/kontakt', tekst: 'Kontakt' },
];

function Header() {
  const [aaben, setAaben] = useState(false);
  const [rullet, setRullet] = useState(false);
  const loc = useLocation();
  useEffect(() => setAaben(false), [loc.pathname]);
  useEffect(() => {
    const f = () => setRullet(window.scrollY > 12);
    f();
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  useEffect(() => {
    document.body.style.overflow = aaben ? 'hidden' : '';
  }, [aaben]);
  return (
    <header className={`sticky top-0 z-40 border-b transition-all duration-300 ${rullet ? 'border-linje bg-creme/95 shadow-[0_6px_30px_-20px_rgba(0,0,0,0.35)] backdrop-blur' : 'border-transparent bg-creme'}`}>
      <div className="beholder flex h-[4.6rem] items-center justify-between gap-6">
        <Link to="/" aria-label="UrmagerMette – til forsiden" className="shrink-0">
          <Logo />
        </Link>
        <nav aria-label="Hovedmenu" className="hidden lg:block">
          <ul className="flex items-center gap-1">
            {MENU.slice(1).map((m) => (
              <li key={m.til}>
                <NavLink
                  to={m.til}
                  className={({ isActive }) =>
                    `relative rounded-full px-3.5 py-2 text-[0.95rem] font-medium transition-colors hover:text-groen ${isActive ? 'text-groen after:absolute after:inset-x-3.5 after:-bottom-0.5 after:h-px after:bg-messing' : 'text-koks/80'}`
                  }
                >
                  {m.tekst}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex items-center gap-2">
          <Link to="/bestil" className="knap-primaer hidden !min-h-[2.8rem] !px-5 sm:inline-flex">
            <Ikon navn="kalender" className="h-[1.1rem] w-[1.1rem]" /> Bestil tid
          </Link>
          <button
            type="button"
            className="inline-flex h-12 w-12 items-center justify-center rounded-full text-groen hover:bg-groen/5 lg:hidden"
            aria-expanded={aaben}
            aria-controls="mobilmenu"
            aria-label={aaben ? 'Luk menu' : 'Åbn menu'}
            onClick={() => setAaben(!aaben)}
          >
            <Ikon navn={aaben ? 'luk' : 'menu'} className="h-7 w-7" />
          </button>
        </div>
      </div>
      {aaben && (
        <div id="mobilmenu" className="ind fixed inset-x-0 bottom-0 top-[4.6rem] z-40 overflow-y-auto bg-creme lg:hidden">
          <nav aria-label="Mobilmenu" className="beholder py-6">
            <ul className="divide-y divide-linje border-y border-linje">
              {MENU.map((m) => (
                <li key={m.til}>
                  <NavLink to={m.til} className={({ isActive }) => `flex items-center justify-between py-4 font-serif text-[1.7rem] ${isActive ? 'text-messing' : 'text-groen'}`}>
                    {m.tekst} <Ikon navn="pil" className="h-5 w-5 text-messing" />
                  </NavLink>
                </li>
              ))}
            </ul>
            <Link to="/bestil" className="knap-primaer mt-8 w-full">
              <Ikon navn="kalender" /> Bestil tid
            </Link>
            <a href={VIRKSOMHED.telefonLink} className="knap-sekundaer mt-3 w-full">
              <Ikon navn="telefon" /> Ring {VIRKSOMHED.telefon}
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="bg-groen text-creme/85">
      <div className="beholder grid gap-12 py-16 md:grid-cols-[1.4fr_1fr_1fr] md:py-20">
        <div>
          <Logo lys />
          <p className="mt-5 max-w-sm text-creme/75">Reparation og service af store og små ure i Slagelse – fra armbåndsure og lommeure til bornholmerure og stueure.</p>
          <Link to="/bestil" className="knap-messing mt-7">
            <Ikon navn="kalender" /> Bestil tid
          </Link>
        </div>
        <div>
          <h2 className="font-sans text-[0.78rem] font-semibold uppercase tracking-[0.2em] text-messing-lys">Kontakt</h2>
          <address className="mt-5 space-y-3 not-italic">
            <p className="flex gap-3">
              <Ikon navn="sted" className="mt-1 h-5 w-5 shrink-0 text-messing-lys" />
              <span>
                {VIRKSOMHED.navn}
                <br />
                {VIRKSOMHED.adresse}
                <br />
                {VIRKSOMHED.postnr} {VIRKSOMHED.by}
              </span>
            </p>
            <p>
              <a href={VIRKSOMHED.telefonLink} className="flex items-center gap-3 hover:text-white">
                <Ikon navn="telefon" className="h-5 w-5 text-messing-lys" /> {VIRKSOMHED.telefon}
              </a>
            </p>
            <p>
              <a href={`mailto:${VIRKSOMHED.email}`} className="flex items-center gap-3 break-all hover:text-white">
                <Ikon navn="mail" className="h-5 w-5 shrink-0 text-messing-lys" /> {VIRKSOMHED.email}
              </a>
            </p>
          </address>
        </div>
        <div>
          <h2 className="font-sans text-[0.78rem] font-semibold uppercase tracking-[0.2em] text-messing-lys">Siderne</h2>
          <ul className="mt-5 space-y-2.5">
            {[...MENU, { til: '/bestil', tekst: 'Bestil tid' }].map((m) => (
              <li key={m.til}>
                <Link to={m.til} className="hover:text-white">
                  {m.tekst}
                </Link>
              </li>
            ))}
          </ul>
          <h2 className="mt-8 font-sans text-[0.78rem] font-semibold uppercase tracking-[0.2em] text-messing-lys">Åbningstider</h2>
          <p className="mt-3 text-creme/75">Åbningstiderne bekræftes snarest. Ring gerne i forvejen.</p>
        </div>
      </div>
      <div className="border-t border-creme/10">
        <div className="beholder flex flex-col gap-3 py-6 text-[0.85rem] text-creme/60 sm:flex-row sm:items-center sm:justify-between">
          <p>© {VIRKSOMHED.navn}{DEMO ? ' · Uofficiel demo – ikke lanceret' : ''}</p>
          <p className="flex flex-wrap gap-x-5 gap-y-1">
            <Link to="/privatliv" className="hover:text-white">Privatlivspolitik</Link>
            <Link to="/billedkilder" className="hover:text-white">Billedkilder</Link>
            <Link to="/admin" className="hover:text-white" rel="nofollow">Log ind</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}

function MobilBestil() {
  const loc = useLocation();
  if (loc.pathname.startsWith('/bestil')) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-linje bg-creme/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur sm:hidden">
      <div className="flex gap-2">
        <Link to="/bestil" className="knap-primaer flex-1">
          <Ikon navn="kalender" /> Bestil tid
        </Link>
        <a href={VIRKSOMHED.telefonLink} className="knap-sekundaer !px-4" aria-label={`Ring til ${VIRKSOMHED.navn}`}>
          <Ikon navn="telefon" />
        </a>
      </div>
    </div>
  );
}

/** Blide animationer: kun elementer under folden skjules og glider frem. */
function useFrem(noegle: string) {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const obs = new IntersectionObserver(
      (poster) => {
        for (const p of poster) {
          if (p.isIntersecting) {
            p.target.classList.remove('skjult');
            obs.unobserve(p.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    document.querySelectorAll('.frem').forEach((el) => {
      if (el.getBoundingClientRect().top > window.innerHeight * 0.92) {
        el.classList.add('skjult');
        obs.observe(el);
      }
    });
    return () => obs.disconnect();
  }, [noegle]);
}

export function Layout({ children }: { children: ReactNode }) {
  const loc = useLocation();
  useFrem(loc.pathname);
  useEffect(() => {
    if (!loc.hash) window.scrollTo(0, 0);
  }, [loc.pathname, loc.hash]);
  return (
    <>
      <a href="#indhold" className="sr-only z-50 rounded bg-groen px-4 py-2 text-creme focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
        Spring til indhold
      </a>
      <DemoBanner />
      <Header />
      <main id="indhold" className="pb-24 sm:pb-0">{children}</main>
      <Footer />
      <MobilBestil />
    </>
  );
}
