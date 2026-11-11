// Local-only demonstration catalogue. Never creates products on sbb.veyro.dk.
// Run alongside `wrangler dev --local`: node scripts/seed-shop-preview.mjs http://localhost:8788
// Images are salon photographs, explicitly NOT photographs of actual products.
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const folder = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function assertLocalPreview(address, devSettings) {
  const url = new URL(address);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Preview seeding is restricted to a localhost origin.');
  if (!/^DEV_LOGIN\s*=\s*1\s*$/m.test(devSettings)) throw new Error('DEV_LOGIN=1 must be set in local .dev.vars.');
  if (!/^SBB_STRIPE_SECRET_KEY\s*=\s*(?:sk|rk|rkcs)_test_[^\s]+\s*$/m.test(devSettings) || /^SBB_STRIPE_SECRET_KEY\s*=.*(?:sk|rk)_live_/m.test(devSettings)) throw new Error('The local preview must use a Stripe test key, never a live merchant key.');
  return url.origin;
}

export async function seedPreview(address = 'http://localhost:8788') {
  const base = assertLocalPreview(address, await readFile(resolve(folder, '.dev.vars'), 'utf8'));
  let cookie = '';
  async function request(path, { method = 'GET', body, type = 'application/json' } = {}) {
    const res = await fetch(base + '/api/' + path, { method, redirect: 'error', headers: { Origin: base, 'Content-Type': type, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Local preview ${path}: ${res.status} ${data?.error || ''}`);
    return { data, headers: res.headers };
  }
  // A devLink is returned only when the local Worker has development login enabled.
  const login = await request('admin/login', { method: 'POST', body: { email: 'marcus@veyro.dk' } });
  const match = /^\/#\/admin\/login\?t=([a-f0-9]{64})$/.exec(login.data.devLink || '');
  if (!match) throw new Error('The local Worker did not return a development login. No products were changed.');
  const verified = await request('admin/verify', { method: 'POST', body: { token: match[1] } });
  cookie = (verified.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie.startsWith('sbb_admin=')) throw new Error('No local admin session.');

  const catalogue = (await request('admin/shop')).data;
  const examples = [
    { name: 'Demo · Mat styling', category: 'Styling', priceOre: 14900, stock: 8, files: ['salonen.jpg', 'salonen-forside.jpg'] },
    { name: 'Demo · Daglig hårpleje', category: 'Hårpleje', priceOre: 17900, stock: 12, files: ['salonen-forside.jpg', 'salonen-hero.jpg'] },
    { name: 'Demo · Pleje til skægget', category: 'Skægpleje', priceOre: 15900, stock: 0, files: ['salonen-hero.jpg', 'salonen.jpg'] },
  ];
  const uploaded = new Map();
  const results = [];
  for (const example of examples) {
    const existing = catalogue.products.find(product => product.name === example.name && product.description.includes('DEMONSTRATIONSPRODUKT'));
    let images = existing?.images?.length >= 2 ? existing.images.slice(0, 2) : [];
    if (!images.length) {
      for (const filename of example.files) {
        if (!uploaded.has(filename)) {
          const bytes = await readFile(resolve(folder, 'site/img', filename));
          uploaded.set(filename, (await request('admin/shop/images', { method: 'POST', body: bytes, type: 'image/jpeg' })).data.imageUrl);
        }
        images.push(uploaded.get(filename));
      }
    }
    const body = {
      name: example.name, category: example.category, priceOre: example.priceOre, stock: example.stock,
      description: 'DEMONSTRATIONSPRODUKT – IKKE TIL SALG. Kun i denne lokale designpreview. Billederne viser StyleByBrothers’ salon og er ikke billeder af et faktisk produkt. Navn, pris og lagerantal er testdata. Salonens rigtige produktnavne, priser, indhold og produktfotos skal leveres før lancering.',
      images, published: true, ...(existing ? { revision: existing.revision } : {}),
    };
    const saved = await request('admin/shop/products' + (existing ? '/' + existing.id : ''), { method: existing ? 'PUT' : 'POST', body });
    results.push({ id: saved.data.product.id, name: saved.data.product.name, images: saved.data.product.images.length, stock: saved.data.product.stock });
  }
  // Keep checkout closed by default. Only an explicit sandbox QA setup should enable it.
  if (catalogue.settings.shippingEnabled) await request('admin/shop/settings', { method: 'PUT', body: { ...catalogue.settings, shippingEnabled: false } });
  console.log(JSON.stringify({ preview: base + '/#/shop', demonstrationOnly: true, checkoutEnabled: false, products: results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  seedPreview(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
