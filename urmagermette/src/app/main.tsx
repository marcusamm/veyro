import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router';
import { useEffect } from 'react';
import { App } from './App';
import { SEO } from './seo';
import './styles.css';

/** Opdaterer sidetitlen ved navigation i browseren (de forudrenderede sider har den allerede). */
function Titel() {
  const { pathname } = useLocation();
  useEffect(() => {
    const m = SEO[pathname.replace(/\/$/, '') || '/'];
    if (m) document.title = m.titel;
  }, [pathname]);
  return null;
}

const rod = document.getElementById('root')!;
const app = (
  <StrictMode>
    <BrowserRouter>
      <Titel />
      <App />
    </BrowserRouter>
  </StrictMode>
);
if (rod.firstElementChild) hydrateRoot(rod, app);
else createRoot(rod).render(app);
