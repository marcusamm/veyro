// Installerbar app (PWA): begge portaler kan lægges på telefonens eller tablettens hjemmeskærm.
// Der gemmes ingen lager- eller jobdata offline; sider hentes altid fra serveren.

import type { Settings } from '../lib/settings';
import { accentOf } from './layout';

const BG = '#F4F2EC';

export function manifest(s: Settings): string {
  const short = s.company_name.length > 12 ? s.company_name.slice(0, 12).trim() : s.company_name;
  return JSON.stringify({
    id: '/',
    name: `${s.company_name} – lager og job`,
    short_name: short,
    description: 'Lagerstyring, vareforbrug på job og indkøb',
    lang: 'da',
    start_url: '/?app=1',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: BG,
    theme_color: BG,
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Job', url: '/job', icons: [{ src: '/icons/192.png', sizes: '192x192' }] },
      { name: 'Lager', url: '/lager', icons: [{ src: '/icons/192.png', sizes: '192x192' }] },
    ],
  });
}

export function iconColors(s: Settings): [bg: string, dot: string] {
  return [accentOf(s), '#0F0F0D'];
}

export const SERVICE_WORKER = `
const CACHE = 'ls-v1';
const STATIC = ['/static/app.css?v=1', '/static/app.js?v=1', '/static/inter-tight.woff2', '/offline', '/icons/192.png'];
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
