// Administrationspanel til værkstedet. Kræver login; alle data hentes fra serveren.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router';
import { api, ApiFejl } from '../api';
import { Ikon, type IkonNavn } from '../components/Ikon';
import { Logo } from '../components/Layout';
import { BookingPanel } from './BookingPanel';
import { Kontekst, DemoMaerke } from './faelles';
import { Oversigt } from './Oversigt';
import { KalenderVisning } from './KalenderVisning';
import { Liste } from './Liste';
import { Indstillinger } from './Indstillinger';
import { Beskeder, Data } from './Diverse';

interface Mig {
  email: string;
  navn: string;
  demo: boolean;
}

function Login({ onLoggetInd }: { onLoggetInd: () => void }) {
  const [email, setEmail] = useState('');
  const [adgangskode, setAdgangskode] = useState('');
  const [fejl, setFejl] = useState('');
  const [sender, setSender] = useState(false);
  async function login(e: FormEvent) {
    e.preventDefault();
    setSender(true);
    setFejl('');
    try {
      await api('/api/admin/login', { method: 'POST', json: { email, adgangskode } });
      onLoggetInd();
    } catch (err) {
      setFejl(err instanceof ApiFejl ? err.message : 'Login mislykkedes.');
    } finally {
      setSender(false);
    }
  }
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-creme px-5 py-12">
      <Link to="/" className="mb-8"><Logo /></Link>
      <form onSubmit={login} className="w-full max-w-sm rounded-3xl border border-linje bg-white p-7 shadow-[0_30px_60px_-45px_rgba(31,58,46,0.5)]">
        <h1 className="text-[2rem]">Administration</h1>
        <p className="mt-1 text-[0.95rem] text-graa">Log ind for at se og styre bookinger.</p>
        <label htmlFor="l-email" className="etiket mt-6">E-mail</label>
        <input id="l-email" type="email" autoComplete="username" className="felt" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label htmlFor="l-pw" className="etiket mt-4">Adgangskode</label>
        <input id="l-pw" type="password" autoComplete="current-password" className="felt" value={adgangskode} onChange={(e) => setAdgangskode(e.target.value)} required />
        {fejl && <p className="mt-4 rounded-xl bg-fejl/10 px-4 py-3 text-[0.95rem] font-medium text-fejl" role="alert">{fejl}</p>}
        <button type="submit" className="knap-primaer mt-6 w-full" disabled={sender}>{sender ? 'Logger ind …' : 'Log ind'}</button>
      </form>
      <Link to="/" className="mt-6 text-[0.95rem] text-graa hover:text-groen">← Tilbage til hjemmesiden</Link>
    </div>
  );
}

const NAV: { til: string; tekst: string; ikon: IkonNavn }[] = [
  { til: '/admin', tekst: 'Oversigt', ikon: 'hjem' },
  { til: '/admin/kalender', tekst: 'Kalender', ikon: 'kalender' },
  { til: '/admin/bookinger', tekst: 'Bookinger', ikon: 'liste' },
  { til: '/admin/beskeder', tekst: 'Beskeder', ikon: 'besked' },
  { til: '/admin/indstillinger', tekst: 'Indstillinger', ikon: 'indstillinger' },
  { til: '/admin/data', tekst: 'Data', ikon: 'download' },
];

export default function Admin() {
  const [mig, setMig] = useState<Mig | null | 'ukendt'>('ukendt');
  const [aaben, setAaben] = useState<string | null>(null);
  const [opdatering, setOpdatering] = useState(0);
  const [toast, setToast] = useState('');
  const nav = useNavigate();

  const hentMig = useCallback(() => {
    api<Mig>('/api/admin/mig').then(setMig).catch(() => setMig(null));
  }, []);
  useEffect(() => {
    document.title = 'Administration · UrmagerMette';
    hentMig();
  }, [hentMig]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  if (mig === 'ukendt') return <div className="flex min-h-screen items-center justify-center bg-creme text-graa">Indlæser …</div>;
  if (!mig) return <Login onLoggetInd={hentMig} />;

  async function logUd() {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    setMig(null);
    nav('/admin');
  }

  const ktx = { aabnBooking: setAaben, opdatering, opdater: () => setOpdatering((n) => n + 1), demo: mig.demo, besked: setToast };

  return (
    <Kontekst.Provider value={ktx}>
      <div className="min-h-screen bg-[#f3efe5] pb-24 md:pb-0">
        {mig.demo && (
          <div className="bg-groen-moerk px-4 py-1.5 text-center text-[0.8rem] text-creme/85">
            <strong className="text-messing-lys">Demotilstand:</strong> alle data er test, og der sendes ingen e-mails.
          </div>
        )}
        <header className="sticky top-0 z-30 border-b border-linje bg-creme/95 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6">
            <Link to="/admin" className="flex items-center gap-3">
              <Logo />
              {mig.demo && <DemoMaerke />}
            </Link>
            <nav className="ml-6 hidden flex-1 md:block" aria-label="Administration">
              <ul className="flex gap-1">
                {NAV.map((n) => (
                  <li key={n.til}>
                    <NavLink end={n.til === '/admin'} to={n.til} className={({ isActive }) => `inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-[0.93rem] font-semibold transition-colors ${isActive ? 'bg-groen text-creme' : 'text-koks/75 hover:bg-sand'}`}>
                      <Ikon navn={n.ikon} className="h-4 w-4" /> {n.tekst}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Link to="/" className="hidden rounded-full px-3 py-2 text-[0.9rem] text-graa hover:bg-sand lg:inline-flex">Se hjemmesiden</Link>
              <button type="button" onClick={logUd} className="inline-flex h-10 items-center gap-2 rounded-full px-3 text-[0.9rem] font-semibold text-graa hover:bg-sand" title={`Logget ind som ${mig.email}`}>
                <Ikon navn="ud" className="h-5 w-5" /> <span className="hidden sm:inline">Log ud</span>
              </button>
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <Routes>
            <Route index element={<Oversigt />} />
            <Route path="kalender" element={<KalenderVisning />} />
            <Route path="bookinger" element={<Liste />} />
            <Route path="beskeder" element={<Beskeder />} />
            <Route path="indstillinger" element={<Indstillinger />} />
            <Route path="data" element={<Data />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </main>
        {/* Mobil: fast menu i bunden */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-linje bg-creme/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="Administration (mobil)">
          <ul className="grid grid-cols-6">
            {NAV.map((n) => (
              <li key={n.til}>
                <NavLink end={n.til === '/admin'} to={n.til} className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2.5 text-[0.68rem] font-semibold ${isActive ? 'text-groen' : 'text-graa'}`}>
                  {({ isActive }) => (
                    <>
                      <span className={`inline-flex h-8 w-12 items-center justify-center rounded-full ${isActive ? 'bg-groen/10' : ''}`}><Ikon navn={n.ikon} className="h-5 w-5" /></span>
                      {n.tekst}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        {aaben && <BookingPanel id={aaben} onLuk={() => setAaben(null)} />}
        {toast && (
          <div className="ind fixed bottom-24 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-koks px-5 py-3 text-[0.93rem] font-semibold text-creme shadow-xl md:bottom-8" role="status">
            {toast}
          </div>
        )}
      </div>
    </Kontekst.Provider>
  );
}
