import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import Forside from './pages/Forside';
import Ydelser from './pages/Ydelser';
import Saadan from './pages/Saadan';
import Om from './pages/Om';
import Faq from './pages/Faq';
import Kontakt from './pages/Kontakt';
import Bestil from './pages/Bestil';
import Privatliv from './pages/Privatliv';
import Billedkilder from './pages/Billedkilder';
import IkkeFundet from './pages/IkkeFundet';
import BookingStatus from './pages/BookingStatus';

const Admin = lazy(() => import('./admin/Admin'));

export function App() {
  return (
    <Routes>
      <Route
        path="/admin/*"
        element={
          <Suspense fallback={<div className="flex min-h-screen items-center justify-center text-graa">Indlæser …</div>}>
            <Admin />
          </Suspense>
        }
      />
      <Route path="*" element={<Offentlig />} />
    </Routes>
  );
}

function Offentlig() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Forside />} />
        <Route path="/ydelser" element={<Ydelser />} />
        <Route path="/saadan-foregaar-det" element={<Saadan />} />
        <Route path="/om" element={<Om />} />
        <Route path="/faq" element={<Faq />} />
        <Route path="/kontakt" element={<Kontakt />} />
        <Route path="/bestil" element={<Bestil />} />
        <Route path="/privatliv" element={<Privatliv />} />
        <Route path="/billedkilder" element={<Billedkilder />} />
        <Route path="/booking/:token" element={<BookingStatus />} />
        <Route path="*" element={<IkkeFundet />} />
      </Routes>
    </Layout>
  );
}
