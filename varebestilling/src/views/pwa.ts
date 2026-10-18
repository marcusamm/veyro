// Installerbar app (PWA): manifest, service worker og offline-side.
// Kunderne kan lægge bestillingen på hjemmeskærmen og åbne den som en app; medarbejderne kan
// gøre det samme med administrationspanelet. Der gemmes ingen ordre- eller kundedata offline.

import { DEFAULT_ACCENT, isHexColor, type Settings } from '../lib/settings';

const BG = '#F4F2EC';

function accentOf(s: Settings): string {
  return isHexColor(s.accent_color) ? s.accent_color : DEFAULT_ACCENT;
}

export function manifest(s: Settings, kind: 'shop' | 'admin'): string {
  const admin = kind === 'admin';
  const short = s.shop_name.length > 12 ? s.shop_name.slice(0, 12).trim() : s.shop_name;
  return JSON.stringify({
    id: admin ? '/admin' : '/',
    name: admin ? `${s.shop_name} – ordrer og lager` : `${s.shop_name} – bestilling`,
    short_name: admin ? 'Ordrer' : short,
    description: admin ? 'Ordrer, lager og genbestilling' : s.tagline || 'Bestil varer',
    lang: 'da',
    start_url: admin ? '/admin?app=1' : '/?app=1',
    scope: admin ? '/admin' : '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: BG,
    theme_color: BG,
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: admin
      ? [
          { name: 'Ny ordre', url: '/admin/ordrer/ny', icons: [{ src: '/icons/192.png', sizes: '192x192' }] },
          { name: 'Genbestilling', url: '/admin/genbestilling', icons: [{ src: '/icons/192.png', sizes: '192x192' }] },
        ]
      : [{ name: 'Kurv', url: '/kurv', icons: [{ src: '/icons/192.png', sizes: '192x192' }] }],
  });
}

export function iconColors(s: Settings): [bg: string, dot: string] {
  return [accentOf(s), '#0F0F0D'];
}

/**
 * Service worker: statiske filer gemmes, så appen starter hurtigt, og uden net vises en
 * offline-side. Sider og formularer hentes altid fra serveren (lager og priser skal være aktuelle).
 */
export const SERVICE_WORKER = `
const CACHE = 'vb-v2';
const STATIC = ['/static/app.css?v=2', '/static/app.js?v=2', '/static/inter-tight.woff2', '/offline', '/icons/192.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/offline')));
    return;
  }
  if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
  }
});
`;
