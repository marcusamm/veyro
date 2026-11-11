import { icon } from './icons.js';
// Public shop and owner tools. Prices, stock and payment are authoritative on the server.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(Number(value || 0) / 100);
const safeImage = url => typeof url === 'string' && (/^\/api\/shop\/images\/[a-zA-Z0-9-]+$/.test(url) || /^https:\/\//.test(url)) ? url : '';
const productImages = p => [...new Set((Array.isArray(p.images) && p.images.length ? p.images : [p.imageUrl]).map(safeImage).filter(Boolean))].slice(0, 6);
const image = (p, index = 0, extra = '') => productImages(p)[index] ? `<img src="${esc(productImages(p)[index])}" alt="${esc(p.name)}${index ? `, billede ${index + 1}` : ''}" loading="lazy" decoding="async" ${extra}>` : '<span class="shop-no-image">Billede på vej</span>';
const failure = err => esc(err?.message || 'Der skete en fejl. Prøv igen.');
const CART_KEY = 'sbb-shop-cart-v1';
const MAX_CART_ITEMS = 20, MAX_QUANTITY = 20;
function readCart() { try { const data = JSON.parse(sessionStorage.getItem(CART_KEY) || '[]'); return Array.isArray(data) ? data.filter(i => typeof i.productId === 'string' && Number.isInteger(i.quantity) && i.quantity > 0).slice(0, MAX_CART_ITEMS) : []; } catch { return []; } }
function saveCart(cart) { try { sessionStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* In-memory cart remains usable in private mode. */ } }
// Keep a checkout's capability across redirects. Resuming reuses the server's reserved order.
const ATTEMPT_KEY = 'sbb-shop-checkout-v1';
function readAttempt() {
  try {
    const value = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || 'null');
    if (!value || !/^[a-f0-9-]{36}$/i.test(value.key) || !Array.isArray(value.items) || !value.items.length || value.items.length > MAX_CART_ITEMS) return null;
    if (value.items.some(i => typeof i.productId !== 'string' || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > MAX_QUANTITY)) return null;
    if (new Set(value.items.map(i => i.productId)).size !== value.items.length) return null;
    return { ...value, products: Array.isArray(value.products) ? value.products : [] };
  } catch { return null; }
}
function saveAttempt(value) { try { if (value) sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(value)); else sessionStorage.removeItem(ATTEMPT_KEY); } catch { /* Server still enforces idempotency for this page. */ } }
const cartFingerprint = items => JSON.stringify(items.map(i => ({ productId: i.productId, quantity: i.quantity })).sort((a, b) => a.productId.localeCompare(b.productId)));
const listingState = { category: 'Alle', scrollY: 0, restore: false };
const demoNote = products => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && products.some(p => p.description?.includes('DEMONSTRATIONSPRODUKT')) ? '<p class="shop-preview-note">Designpreview · Demonstrationsvarer med salonfotos. Navne, priser og lager er testdata. Varerne er ikke til salg.</p>' : '';
const productHref = p => `#/shop/produkt/${encodeURIComponent(p.id)}`;
const normalClick = e => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

function cardHTML(p, { featured = false } = {}) {
  const images = productImages(p);
  return `<article class="shop-product${featured ? ' shop-product-featured' : ''}">
    <a class="shop-product-image" href="${productHref(p)}" data-product-route="${esc(p.id)}" aria-label="Se ${esc(p.name)}${images.length > 1 ? ', flere billeder på produktsiden' : ''}">
      ${image(p)}${images[1] ? `<span class="shop-product-image-second" aria-hidden="true"><img src="${esc(images[1])}" alt="" loading="lazy" decoding="async"></span>` : ''}
      <span class="shop-image-action">Se produkt ${icon('arrow')}</span>${p.stock < 1 ? '<span class="shop-stock-tag">Udsolgt</span>' : ''}
    </a>
    <div class="shop-product-meta"><span>${esc(p.category || 'Pleje & styling')}</span><span>${p.stock > 0 ? 'På lager' : 'Udsolgt'}</span></div>
    <div class="shop-product-title"><h${featured ? '3' : '2'}><a href="${productHref(p)}" data-product-route="${esc(p.id)}">${esc(p.name)}</a></h${featured ? '3' : '2'}><span>${money(p.priceOre)}</span></div>
    ${featured ? `<a class="shop-text-link" href="${productHref(p)}">Se produkt ${icon('arrow')}</a>` : `<button type="button" class="shop-add" data-add="${esc(p.id)}" ${p.stock < 1 ? 'disabled' : ''}><span>${p.stock > 0 ? 'Læg i kurv' : 'Ikke på lager'}</span>${icon('plus')}</button>`}
  </article>`;
}

export async function mountFeaturedProducts(root, { api, productIds = [], limit = 3 }) {
  root.classList.add('sbb-shop-featured');
  root.innerHTML = '<p class="shop-featured-note" role="status">Henter produkter…</p>';
  try {
    const data = await api('shop/products');
    if (!root.isConnected) return;
    const catalogue = data.products || [];
    const ordered = productIds.length ? productIds.map(id => catalogue.find(p => p.id === id)).filter(Boolean) : catalogue;
    const selected = ordered.slice(0, Math.max(1, Math.min(12, Number(limit) || 3)));
    root.innerHTML = selected.length ? `${demoNote(selected)}<div class="shop-grid shop-featured-grid">${selected.map(p => cardHTML(p, { featured: true })).join('')}</div>` : '<p class="shop-featured-note">Vi er ved at gøre webshoppen klar. Spørg os om produkterne, næste gang du er i salonen.</p>';
  } catch {
    if (root.isConnected) root.innerHTML = '<p class="shop-featured-note">Produkterne kunne ikke hentes lige nu. <a href="#/shop">Prøv i webshoppen</a>.</p>';
  }
}

export async function mountShop(root, { api }) {
  root.classList.add('sbb-shop');
  let disposed = false, dialog = null, previousOverflow = '', dialogOpener = null;
  const timers = new Set();
  const later = (fn, delay) => { const id = setTimeout(() => { timers.delete(id); if (!disposed && root.isConnected) fn(); }, delay); timers.add(id); return id; };
  const originalHash = location.hash;
  const routePath = originalHash.split('?')[0].replace(/^#/, '');
  const isDetail = routePath.startsWith('/shop/produkt/');
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root.getAnimations?.({ subtree: true }).forEach(animation => animation.cancel());
    for (const id of timers) clearTimeout(id);
    timers.clear();
    if (dialog) { dialog.remove(); document.body.style.overflow = previousOverflow; dialog = null; }
    root.querySelector('.shop-toast')?.remove();
    window.removeEventListener('hashchange', onHashChange);
  };
  const onHashChange = () => {
    if (isDetail && /^#\/shop(?:\?|$)/.test(location.hash)) listingState.restore = true;
    dispose();
  };
  window.addEventListener('hashchange', onHashChange);
  root.innerHTML = '<div class="shop-loading" role="status"><span class="shop-label">StyleByBrothers / Webshop</span><p>Vi henter produkterne.</p><div class="shop-loading-grid" aria-hidden="true"><span></span><span></span><span></span></div></div>';
  let products, settings;
  try { ({ products = [], settings = {} } = await api('shop/products')); }
  catch (err) {
    if (disposed || !root.isConnected) return dispose;
    root.innerHTML = `<section class="shop-state"><p class="shop-label">Webshop</p><h1>Vi kunne ikke<br>hente produkterne.</h1><p>${failure(err)}</p><button class="shop-btn" data-retry>Prøv igen ${icon('arrow')}</button></section>`;
    root.querySelector('[data-retry]').onclick = () => { dispose(); mountShop(root, { api }); };
    return dispose;
  }
  if (disposed || !root.isConnected) { dispose(); return dispose; }
  let activeAttempt = readAttempt(), verifiedAttemptTotal = null, previousPaymentMessage = '';
  if (activeAttempt?.orderId && /^[a-f0-9-]{36}$/i.test(activeAttempt.orderId)) {
    try {
      const previousOrder = await api('shop/orders/' + encodeURIComponent(activeAttempt.orderId));
      if (['paid', 'fulfilled'].includes(previousOrder.status)) {
        if (cartFingerprint(readCart()) === cartFingerprint(activeAttempt.items)) saveCart([]);
        try { if (sessionStorage.getItem('sbb-shop-payment-order') === activeAttempt.orderId) sessionStorage.removeItem('sbb-shop-payment-order'); } catch {}
        saveAttempt(null); activeAttempt = null; previousPaymentMessage = 'Din seneste betaling er bekræftet. Tak for din ordre.';
      } else if (['expired', 'cancelled'].includes(previousOrder.status)) {
        saveAttempt(null); activeAttempt = null; previousPaymentMessage = 'Den tidligere betaling er udløbet eller annulleret. Du kan starte en ny fra kurven.';
      } else verifiedAttemptTotal = previousOrder.totalOre;
    } catch { /* Preserve uncertain reservations until the server confirms their state. */ }
  }
  if (disposed || !root.isConnected) { dispose(); return dispose; }
  let cart = activeAttempt ? activeAttempt.items.map(i => ({ ...i })) : readCart().filter(i => products.some(p => p.id === i.productId && p.stock > 0)).map(i => ({ ...i, quantity: Math.min(MAX_QUANTITY, i.quantity, products.find(p => p.id === i.productId).stock) }));
  let checkoutBusy = false, checkoutKey = activeAttempt?.key || crypto.randomUUID(), navigationBusy = false;
  let category = listingState.category;
  const productForCart = id => (activeAttempt?.products || []).find(p => p.id === id) || products.find(p => p.id === id) || { id, name: 'Produkt fra din igangværende betaling', priceOre: 0, stock: 0 };
  const categories = ['Alle', ...new Set(products.map(p => p.category).filter(Boolean))];
  if (!categories.includes(category)) category = 'Alle';
  const params = new URLSearchParams(originalHash.split('?')[1] || '');
  const total = () => cart.reduce((sum, i) => sum + (productForCart(i.productId)?.priceOre || 0) * i.quantity, 0);
  const shippingFee = () => activeAttempt ? Number(activeAttempt.shippingFeeOre || 0) : Number(settings.shippingFeeOre || 0);
  const grandTotal = () => activeAttempt && Number.isInteger(verifiedAttemptTotal) ? verifiedAttemptTotal : total() + ((activeAttempt || settings.shippingEnabled) ? shippingFee() : 0);
  const count = () => cart.reduce((sum, i) => sum + i.quantity, 0);
  const cartButton = () => `<button class="shop-cart-link${count() ? ' has-items' : ''}" type="button" data-cart aria-label="Åbn kurv, ${count()} varer">${icon('bag')} Kurv <span data-cart-count>${count()}</span></button>`;
  const deliveryHTML = () => settings.shippingEnabled ? `<p>Levering i Danmark${settings.shippingDays ? ` · ${esc(settings.shippingDays)}` : ''}</p><p>Fragt ${money(settings.shippingFeeOre)} · Priser inkl. moms</p>` : '<p>Levering er endnu ikke åbnet.</p><p>Priser inkl. moms</p>';
  const initialNotice = previousPaymentMessage || (params.has('order') ? 'Vi afventer bekræftelsen på din betaling. Start ikke en ny betaling, hvis du allerede har betalt.' : activeAttempt ? 'Du har en igangværende betaling. Åbn kurven for at fortsætte eller annullere den, før du ændrer varerne.' : params.has('cancelled') ? 'Betalingen blev ikke gennemført. Du kan fortsætte fra din kurv, når du er klar.' : '');
  const noticeHTML = `<p class="shop-notice" data-payment-status role="status" ${initialNotice ? '' : 'hidden'}>${esc(initialNotice)}</p>`;

  function navigate(href, e) {
    if (e && !normalClick(e)) return;
    e?.preventDefault();
    if (navigationBusy) return;
    navigationBusy = true;
    if (!isDetail) { listingState.scrollY = window.scrollY; listingState.category = category; }
    else if (href === '#/shop') listingState.restore = true;
    root.classList.add('shop-leaving');
    later(() => { location.hash = href.slice(1); }, reduced() ? 0 : 120);
  }
  function bindRoutes(container = root) {
    container.querySelectorAll('[data-product-route], [data-shop-back]').forEach(a => a.addEventListener('click', e => navigate(a.getAttribute('href'), e)));
  }
  function updateCount() {
    root.querySelectorAll('[data-cart-count]').forEach(el => el.textContent = count());
    root.querySelectorAll('[data-cart]').forEach(b => { b.classList.toggle('has-items', count() > 0); b.setAttribute('aria-label', `Åbn kurv, ${count()} varer`); });
  }
  function announce(text) {
    const live = root.querySelector('[data-shop-live]');
    if (live) { live.textContent = ''; later(() => live.textContent = text, 30); }
  }
  function feedback(text) {
    let toast = root.querySelector('.shop-toast');
    if (!toast) {
      toast = document.createElement('div'); toast.className = 'shop-toast';
      toast.innerHTML = `${icon('check')}<span data-toast-text></span><button type="button" data-toast-cart>Se kurv ${icon('arrow')}</button><button type="button" data-toast-close aria-label="Skjul beskeden">${icon('close')}</button>`;
      root.append(toast); toast.querySelector('[data-toast-cart]').onclick = openCart; toast.querySelector('[data-toast-close]').onclick = () => toast.classList.remove('is-visible');
    }
    toast.querySelector('[data-toast-text]').textContent = text;
    toast.classList.add('is-visible');
    announce(text);
  }
  function add(id, quantity = 1, button) {
    if (activeAttempt) { feedback('Fortsæt eller annullér din igangværende betaling i kurven først.'); return; }
    const p = products.find(p => p.id === id);
    if (!p || p.stock < 1) return;
    const row = cart.find(i => i.productId === id);
    if (!row && cart.length >= MAX_CART_ITEMS) { feedback('Du kan bestille op til 20 forskellige produkter ad gangen.'); return; }
    const available = Math.min(MAX_QUANTITY, p.stock) - (row?.quantity || 0);
    if (available < 1) { feedback(row?.quantity >= MAX_QUANTITY ? 'Du kan bestille op til 20 af samme produkt ad gangen.' : 'Du har allerede lagt det tilgængelige antal i kurven.'); return; }
    const amount = Math.min(available, Math.max(1, Math.floor(Number(quantity) || 1)));
    if (row) row.quantity += amount; else cart.push({ productId: id, quantity: amount });
    checkoutKey = crypto.randomUUID(); saveCart(cart); updateCount();
    feedback(`${amount} × ${p.name} er lagt i kurven.`);
    if (button) {
      const html = button.innerHTML; button.classList.add('is-added'); button.innerHTML = `<span>Lagt i kurv</span>${icon('check')}`;
      button.disabled = true;
      later(() => { if (button.isConnected) { button.innerHTML = html; button.classList.remove('is-added'); button.disabled = p.stock < 1; } }, 1400);
    }
  }
  function bindAdds(container = root) { container.querySelectorAll('[data-add]').forEach(b => b.onclick = () => add(b.dataset.add, 1, b)); }
  function renderGrid() {
    const shown = category === 'Alle' ? products : products.filter(p => p.category === category);
    root.querySelector('[data-product-grid]').innerHTML = shown.map(p => cardHTML(p)).join('');
    root.querySelector('[data-result-count]').textContent = `${shown.length} ${shown.length === 1 ? 'produkt' : 'produkter'}`;
    root.querySelectorAll('[data-category]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.category === category)));
    bindAdds(); bindRoutes();
  }
  function renderListing() {
    root.innerHTML = `<div class="shop-route-content"><section class="shop-intro"><div><p class="shop-label">StyleByBrothers / Webshop</p><h1>Pleje<br><span>& styling.</span></h1></div><div class="shop-intro-note"><p>Produkter til hår og skæg.<br>Vælg det, der passer til din rutine.</p><div>${deliveryHTML()}</div></div></section>${demoNote(products)}${noticeHTML}
      <div class="shop-toolbar"><div class="shop-filters" aria-label="Produktkategorier">${categories.map(c => `<button type="button" data-category="${esc(c)}" aria-pressed="${c === category}">${esc(c)}</button>`).join('')}</div>${cartButton()}</div>
      ${products.length ? `<div class="shop-result-line"><span data-result-count></span><span>Alle priser inkl. moms</span></div><div class="shop-grid" data-product-grid></div>` : `<section class="shop-empty"><div><span class="shop-empty-number" aria-hidden="true">01—</span><h2>Vi gør<br>hylden klar.</h2></div><div><p>Salonen er åben. Webshoppen er på vej.</p><p>Vi tilføjer produkterne her, så snart de er klar til at blive bestilt. Indtil da hjælper vi dig gerne med at finde den rette pleje i salonen.</p><a href="tel:+4561707044" class="shop-text-link">Spørg os om et produkt ${icon('arrow')}</a></div></section>`}
      <aside class="shop-service-note"><p>Er du i tvivl om, hvad dit hår har brug for?</p><a href="tel:+4561707044" class="shop-text-link">Ring til salonen ${icon('arrow')}</a></aside></div><span class="shop-sr-only" data-shop-live role="status" aria-live="polite"></span>`;
    if (products.length) renderGrid();
    root.querySelectorAll('[data-category]').forEach(b => b.onclick = () => { category = b.dataset.category; listingState.category = category; if (products.length) renderGrid(); announce(`Viser ${category === 'Alle' ? 'alle produkter' : category}.`); });
    if (listingState.restore) {
      listingState.restore = false;
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!disposed && root.isConnected) window.scrollTo({ top: listingState.scrollY, behavior: 'instant' }); }));
    }
  }
  function renderDetail(p) {
    if (!p) {
      root.innerHTML = `<section class="shop-state"><p class="shop-label">Webshop</p><h1>Produktet er<br>ikke tilgængeligt.</h1><p>Det kan være taget af hylden. Se resten af sortimentet i webshoppen.</p><a class="shop-btn" href="#/shop" data-shop-back>Til webshoppen ${icon('arrow')}</a></section>`;
      bindRoutes(); return;
    }
    document.title = `${p.name} · StyleByBrothers`;
    const images = productImages(p); let currentImage = 0;
    root.innerHTML = `<div class="shop-route-content"><div class="shop-detail-nav"><a class="shop-text-link" href="#/shop" data-shop-back>${icon('left')} Alle produkter</a>${cartButton()}</div>${demoNote([p])}
      <article class="shop-detail"><div class="shop-gallery"><div class="shop-detail-image" data-gallery-stage tabindex="0" role="group" aria-label="Produktbilleder. Brug piletasterne for at skifte billede.">${images.length ? `<img data-main-image src="${esc(images[0])}" alt="${esc(p.name)}, billede 1 af ${images.length}" fetchpriority="high" decoding="async">` : '<span class="shop-no-image">Billede på vej</span>'}${images.length > 1 ? `<div class="shop-gallery-controls"><button class="shop-icon-button" data-gallery-prev aria-label="Forrige produktbillede">${icon('chevronLeft')}</button><span data-gallery-count aria-live="polite">1 / ${images.length}</span><button class="shop-icon-button" data-gallery-next aria-label="Næste produktbillede">${icon('chevronRight')}</button></div>` : ''}</div>
      ${images.length > 1 ? `<div class="shop-thumbnails" aria-label="Vælg produktbillede">${images.map((url, i) => `<button type="button" data-image-index="${i}" aria-label="Vis billede ${i + 1} af ${images.length}" aria-pressed="${i === 0}"><img src="${esc(url)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}</div>
      <div class="shop-detail-copy"><p class="shop-label">${esc(p.category || 'Pleje & styling')}</p><h1>${esc(p.name)}</h1><div class="shop-detail-price"><span>${money(p.priceOre)}</span><small>Inkl. moms</small></div><p class="shop-availability${p.stock < 1 ? ' is-sold-out' : ''}"><span aria-hidden="true"></span>${p.stock > 0 ? 'På lager' : 'Midlertidigt udsolgt'}</p>
      ${p.description ? `<div class="shop-detail-description">${esc(p.description)}</div>` : ''}
      <form class="shop-buy-form"><label for="shop-detail-quantity">Antal</label><div class="shop-purchase-row"><div class="shop-quantity-control"><button type="button" data-detail-minus aria-label="Vælg én færre" ${p.stock < 1 ? 'disabled' : ''}>${icon('minus')}</button><input id="shop-detail-quantity" name="quantity" aria-label="Antal" type="number" inputmode="numeric" min="1" max="${Math.max(1, Math.min(MAX_QUANTITY, p.stock))}" step="1" value="1" required ${p.stock < 1 ? 'disabled' : ''}><button type="button" data-detail-plus aria-label="Vælg én mere" ${p.stock < 1 ? 'disabled' : ''}>${icon('plus')}</button></div><button type="submit" class="shop-btn" ${p.stock < 1 ? 'disabled' : ''}><span>${p.stock > 0 ? 'Læg i kurv' : 'Udsolgt'}</span>${icon('plus')}</button></div></form>
      <div class="shop-detail-delivery"><span class="shop-label">Levering</span>${deliveryHTML()}${settings.checkoutEnabled ? '' : '<p>Onlinebetaling er ikke åben endnu. Du kan stadig se produkterne og samle din kurv.</p>'}${/^https:\/\//.test(settings.termsUrl || '') ? `<a href="${esc(settings.termsUrl)}" target="_blank" rel="noopener">Handelsbetingelser</a>` : ''}</div><a href="tel:+4561707044" class="shop-text-link shop-product-help">Spørg salonen om produktet ${icon('arrow')}</a></div></article></div><span class="shop-sr-only" data-shop-live role="status" aria-live="polite"></span>`;
    bindRoutes();
    const input = root.querySelector('[name="quantity"]');
    const changeQuantity = delta => { input.value = Math.max(1, Math.min(MAX_QUANTITY, p.stock, (Number(input.value) || 1) + delta)); };
    root.querySelector('[data-detail-minus]').onclick = () => changeQuantity(-1);
    root.querySelector('[data-detail-plus]').onclick = () => changeQuantity(1);
    root.querySelector('.shop-buy-form').onsubmit = e => { e.preventDefault(); if (e.currentTarget.reportValidity()) add(p.id, input.value, e.currentTarget.querySelector('[type="submit"]')); };
    function showImage(index) {
      if (images.length < 2) return;
      currentImage = (index + images.length) % images.length;
      const img = root.querySelector('[data-main-image]');
      img.src = images[currentImage]; img.alt = `${p.name}, billede ${currentImage + 1} af ${images.length}`;
      root.querySelector('[data-gallery-count]').textContent = `${currentImage + 1} / ${images.length}`;
      root.querySelectorAll('[data-image-index]').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.imageIndex === currentImage)));
      if (!reduced() && img.animate) img.animate([{ opacity: .35, clipPath: 'inset(0 0 12% 0)' }, { opacity: 1, clipPath: 'inset(0)' }], { duration: 350, easing: 'cubic-bezier(.22,.7,.2,1)' });
    }
    root.querySelectorAll('[data-image-index]').forEach(b => b.onclick = () => showImage(+b.dataset.imageIndex));
    root.querySelector('[data-gallery-prev]')?.addEventListener('click', () => showImage(currentImage - 1));
    root.querySelector('[data-gallery-next]')?.addEventListener('click', () => showImage(currentImage + 1));
    const stage = root.querySelector('[data-gallery-stage]');
    stage.onkeydown = e => { if (images.length > 1 && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); showImage(currentImage + (e.key === 'ArrowRight' ? 1 : -1)); } };
    let startX = 0, startY = 0;
    stage.addEventListener('touchstart', e => { startX = e.changedTouches[0].clientX; startY = e.changedTouches[0].clientY; }, { passive: true });
    stage.addEventListener('touchend', e => { const dx = e.changedTouches[0].clientX - startX, dy = e.changedTouches[0].clientY - startY; if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) showImage(currentImage + (dx < 0 ? 1 : -1)); }, { passive: true });
  }

  function closeCart(immediate = false) {
    if (!dialog) return;
    const closing = dialog; closing.classList.add('is-closing');
    const finish = () => { if (dialog !== closing) return; closing.close(); closing.remove(); dialog = null; document.body.style.overflow = previousOverflow; (dialogOpener?.isConnected ? dialogOpener : root.querySelector('[data-cart]'))?.focus({ preventScroll: true }); };
    if (immediate || reduced()) finish(); else later(finish, 300);
  }
  function openCart() {
    if (dialog) return;
    dialogOpener = document.activeElement?.closest('.shop-toast') ? root.querySelector('[data-cart]') : document.activeElement;
    root.querySelector('.shop-toast')?.classList.remove('is-visible');
    dialog = document.createElement('dialog'); dialog.className = 'shop-drawer'; dialog.setAttribute('aria-labelledby', 'shop-cart-title');
    dialog.addEventListener('cancel', e => { e.preventDefault(); closeCart(); });
    dialog.addEventListener('click', e => { if (e.target === dialog && e.clientX < dialog.getBoundingClientRect().left) closeCart(); });
    document.body.append(dialog); previousOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    renderCart(); dialog.showModal(); dialog.querySelector('[data-close-cart]').focus();
  }
  function renderCart(focusKey) {
    if (!dialog) return;
    dialog.innerHTML = `<div class="shop-drawer-heading"><div><span class="shop-label">StyleByBrothers</span><h2 id="shop-cart-title">Din kurv <span>(${count()})</span></h2></div><button class="shop-icon-button" type="button" data-close-cart aria-label="Luk kurven">${icon('close')}</button></div>
      ${cart.length ? `<div class="shop-cart-items">${cart.map(i => { const p = productForCart(i.productId); return `<article class="shop-cart-item"><a class="shop-cart-image" href="${productHref(p)}" aria-label="Se ${esc(p.name)}">${image(p)}</a><div class="shop-cart-item-info"><h3><a href="${productHref(p)}">${esc(p.name)}</a></h3><p>${money(p.priceOre)} / stk.</p><div class="shop-cart-item-actions"><div class="shop-quantity-control"><button type="button" data-decrease="${esc(i.productId)}" aria-label="Fjern én ${esc(p.name)}" ${checkoutBusy || activeAttempt || i.quantity <= 1 ? 'disabled' : ''}>${icon('minus')}</button><input type="number" inputmode="numeric" min="1" max="${activeAttempt ? i.quantity : Math.min(MAX_QUANTITY, p.stock)}" value="${i.quantity}" aria-label="Antal ${esc(p.name)}" data-quantity="${esc(i.productId)}" ${checkoutBusy || activeAttempt ? 'disabled' : ''}><button type="button" data-increase="${esc(i.productId)}" aria-label="Tilføj én ${esc(p.name)}" ${checkoutBusy || activeAttempt || i.quantity >= Math.min(MAX_QUANTITY, p.stock) ? 'disabled' : ''}>${icon('plus')}</button></div><button class="shop-remove" type="button" data-remove="${esc(i.productId)}" ${checkoutBusy || activeAttempt ? 'disabled' : ''}>Fjern</button></div></div><strong>${money(p.priceOre * i.quantity)}</strong></article>`; }).join('')}</div><div class="shop-cart-bottom"><dl class="shop-totals"><div><dt>Varer</dt><dd>${money(total())}</dd></div><div><dt>Fragt til Danmark</dt><dd>${activeAttempt || settings.shippingEnabled ? money(shippingFee()) : 'Ikke åbnet'}</dd></div><div class="shop-total"><dt>I alt <small>inkl. moms</small></dt><dd>${money(grandTotal())}</dd></div></dl>${settings.checkoutEnabled ? `<p class="shop-checkout-note">${esc(settings.shippingDays || 'Levering i Danmark')}. Adresse og betaling angives i næste trin.</p>` : '<p class="shop-checkout-note">Onlinebetaling er ikke åben endnu. Ring til salonen på <a href="tel:+4561707044">61 70 70 44</a>, hvis du har spørgsmål.</p>'}<button class="shop-btn shop-checkout" type="button" data-checkout ${checkoutBusy || !settings.checkoutEnabled ? 'disabled' : ''}><span>${checkoutBusy ? 'Arbejder…' : activeAttempt ? 'Fortsæt betaling' : 'Gå til betaling'}</span>${icon('arrow')}</button>${activeAttempt ? `<p class="shop-pending-note">Varerne er reserveret til denne betaling. Annullér den først, hvis du vil ændre kurven.</p><button type="button" class="shop-text-link shop-cancel-checkout" data-cancel-checkout ${checkoutBusy ? 'disabled' : ''}>Annullér betaling og redigér kurv</button>` : ''}${/^https:\/\//.test(settings.termsUrl || '') ? `<a class="shop-terms-link" href="${esc(settings.termsUrl)}" target="_blank" rel="noopener">Handelsbetingelser</a>` : ''}<p class="shop-checkout-error" role="alert"></p></div>` : `<div class="shop-cart-empty">${icon('bag')}<h3>Plads til din<br>næste favorit.</h3><p>Din kurv er tom. Se produkterne, og find pleje til hår og skæg.</p><button class="shop-btn" type="button" data-close-empty>Se produkterne ${icon('arrow')}</button></div>`}`;
    dialog.querySelector('[data-close-cart]').onclick = () => closeCart();
    dialog.querySelector('[data-close-empty]')?.addEventListener('click', () => { closeCart(); if (isDetail) later(() => navigate('#/shop'), 310); });
    const change = (id, quantity, focusAttribute) => {
      if (checkoutBusy || activeAttempt) return;
      const p = products.find(p => p.id === id), row = cart.find(i => i.productId === id);
      if (!p || !row) return;
      row.quantity = Math.max(1, Math.min(MAX_QUANTITY, p.stock, Math.floor(Number(quantity) || 1)));
      checkoutKey = crypto.randomUUID(); saveCart(cart); updateCount(); renderCart(focusAttribute && `${focusAttribute}="${id}"`); announce('Kurven er opdateret.');
    };
    dialog.querySelectorAll('[data-quantity]').forEach(input => input.onchange = () => change(input.dataset.quantity, input.value, 'data-quantity'));
    dialog.querySelectorAll('[data-decrease]').forEach(b => b.onclick = () => change(b.dataset.decrease, cart.find(i => i.productId === b.dataset.decrease).quantity - 1, 'data-decrease'));
    dialog.querySelectorAll('[data-increase]').forEach(b => b.onclick = () => change(b.dataset.increase, cart.find(i => i.productId === b.dataset.increase).quantity + 1, 'data-increase'));
    dialog.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { if (checkoutBusy || activeAttempt) return; cart = cart.filter(i => i.productId !== b.dataset.remove); checkoutKey = crypto.randomUUID(); saveCart(cart); updateCount(); renderCart(); dialog.querySelector('[data-close-cart]')?.focus(); announce('Produktet er fjernet fra kurven.'); });
    dialog.querySelector('[data-checkout]')?.addEventListener('click', checkout);
    dialog.querySelector('[data-cancel-checkout]')?.addEventListener('click', cancelCheckout);
    if (focusKey) { const target = dialog.querySelector(`[${focusKey}]`); (target?.disabled ? target.closest('.shop-quantity-control')?.querySelector('input') : target)?.focus({ preventScroll: true }); }
    dialog.setAttribute('aria-busy', String(checkoutBusy));
  }
  async function checkout() {
    if (checkoutBusy || !cart.length || !settings.checkoutEnabled) return;
    checkoutBusy = true;
    if (!activeAttempt) { activeAttempt = { key: checkoutKey, items: cart.map(i => ({ ...i })), products: cart.map(i => { const p = products.find(p => p.id === i.productId); return { id: p.id, name: p.name, priceOre: p.priceOre, stock: p.stock, images: productImages(p), imageUrl: p.imageUrl }; }), shippingFeeOre: settings.shippingFeeOre || 0 }; saveAttempt(activeAttempt); }
    renderCart();
    try {
      const result = await api('shop/checkout', { method: 'POST', body: { items: cart.map(i => ({ productId: i.productId, quantity: i.quantity })), idempotencyKey: checkoutKey } });
      if (!/^https:\/\/checkout\.stripe\.com\//.test(result.url || '')) throw new Error('Betalingen kunne ikke åbnes. Prøv igen.');
      activeAttempt.orderId = result.orderId; saveAttempt(activeAttempt);
      try { sessionStorage.setItem('sbb-shop-payment-order', result.orderId); } catch { /* Payment can still proceed. */ }
      if (!disposed) window.location.assign(result.url);
    } catch (err) {
      checkoutBusy = false;
      if (disposed || !dialog) return;
      renderCart();
      const error = dialog.querySelector('.shop-checkout-error'); error.textContent = err.message;
      if (err.status === 409) error.append(document.createTextNode(' Brug annullering ovenfor for at kontrollere den tidligere betaling og frigive kurven.'));
      dialog.querySelector('[data-checkout]')?.focus();
    }
  }
  async function cancelCheckout() {
    if (!activeAttempt || checkoutBusy) return;
    checkoutBusy = true; renderCart();
    try {
      const result = await api('shop/checkout/cancel', { method: 'POST', body: { idempotencyKey: activeAttempt.key } });
      if (disposed) return;
      if (result.cancelled) {
        const latest = await api('shop/products');
        if (disposed) return;
        saveAttempt(null); activeAttempt = null; verifiedAttemptTotal = null; checkoutKey = crypto.randomUUID();
        try { sessionStorage.removeItem('sbb-shop-payment-order'); } catch { /* Optional persistence. */ }
        products = latest.products || []; settings = latest.settings || {};
        cart = cart.filter(i => products.some(p => p.id === i.productId && p.stock > 0)).map(i => ({ ...i, quantity: Math.min(MAX_QUANTITY, i.quantity, products.find(p => p.id === i.productId).stock) }));
        saveCart(cart); checkoutBusy = false;
        if (isDetail) { let id; try { id = decodeURIComponent(routePath.slice('/shop/produkt/'.length)); } catch { id = ''; } renderDetail(products.find(p => p.id === id)); root.querySelectorAll('[data-cart]').forEach(b => b.onclick = openCart); }
        else if (root.querySelector('[data-product-grid]')) renderGrid();
        updateCount(); renderCart();
        const notice = root.querySelector('[data-payment-status]');
        if (notice) { notice.hidden = false; notice.textContent = 'Betalingen er annulleret. Du kan nu ændre din kurv.'; }
        announce('Betalingen er annulleret. Din kurv kan redigeres.');
        dialog?.querySelector('[data-close-cart]')?.focus();
      } else if (['paid', 'fulfilled'].includes(result.status)) {
        cart = []; saveCart(cart); saveAttempt(null); activeAttempt = null; verifiedAttemptTotal = null; checkoutBusy = false; updateCount(); renderCart();
        const notice = root.querySelector('[data-payment-status]');
        if (notice) { notice.hidden = false; notice.textContent = 'Betalingen er gennemført. Din ordre er bekræftet og kan ikke annulleres fra kurven. Kontakt salonen, hvis du har brug for hjælp.'; }
        closeCart(); announce('Betalingen er allerede gennemført. Din ordre er bekræftet.');
      } else {
        checkoutBusy = false; renderCart();
        if (dialog) { dialog.querySelector('.shop-checkout-error').textContent = 'Betalingen behandles stadig. Kurven er fortsat låst for at undgå dobbeltbestilling. Prøv igen om lidt, eller kontakt salonen.'; dialog.querySelector('[data-cancel-checkout]')?.focus(); }
      }
    } catch (err) {
      checkoutBusy = false;
      if (disposed || !dialog) return;
      renderCart(); dialog.querySelector('.shop-checkout-error').textContent = `${err.message} Vi har ikke oprettet en ny betaling.`; dialog.querySelector('[data-cancel-checkout]')?.focus();
    }
  }
  saveCart(cart);
  if (isDetail) { let id; try { id = decodeURIComponent(routePath.slice('/shop/produkt/'.length)); } catch { id = ''; } renderDetail(products.find(p => p.id === id)); }
  else renderListing();
  root.querySelectorAll('[data-cart]').forEach(b => b.onclick = openCart);
  const returnOrder = params.get('order');
  if (returnOrder && /^[a-f0-9-]{36}$/i.test(returnOrder)) {
    let attempts = 0;
    const paymentMessage = text => { const target = root.querySelector('[data-payment-status]'); if (target) { target.hidden = false; target.textContent = text; } };
    const checkPayment = async () => {
      if (disposed || !root.isConnected) return;
      try {
        const result = await api('shop/orders/' + encodeURIComponent(returnOrder));
        if (disposed || !root.isConnected) return;
        if (['paid', 'fulfilled'].includes(result.status)) {
          paymentMessage('Tak for din ordre. Betalingen er bekræftet. Vi gør dine produkter klar til levering.');
          try { if (sessionStorage.getItem('sbb-shop-payment-order') === returnOrder) { cart = []; saveCart(cart); saveAttempt(null); activeAttempt = null; updateCount(); sessionStorage.removeItem('sbb-shop-payment-order'); if (dialog) renderCart(); } } catch { /* Never infer payment from local storage. */ }
          return;
        }
        if (result.status === 'expired') { paymentMessage('Betalingssessionen er udløbet. Ordren er ikke betalt. Du kan prøve igen fra din kurv.'); return; }
      } catch { /* Webhook may still be arriving; never imply successful payment. */ }
      if (++attempts < 8) later(checkPayment, 1500);
      else paymentMessage('Betalingen er endnu ikke bekræftet her. Hvis du har betalt, skal du ikke betale igen. Kontakt os på 61 70 70 44, hvis du er i tvivl.');
    };
    checkPayment();
  }
  return dispose;
}

export async function mountShopAdmin(root, { api, tab = 'produkter' }) {
  root.classList.add('shop-admin'); root.innerHTML='<p role="status">Henter webshop…</p>';
  let data;
  try { data=await api('admin/shop'); } catch(err) { root.innerHTML=`<p class="notice danger" role="alert">${failure(err)}</p>`; return; }
  if(!root.isConnected)return;
  let selected = null, notice = '';
  async function refresh() { data=await api('admin/shop'); }
  const render = () => { if(!root.isConnected)return; if(tab==='ordrer')renderOrders();else renderProducts(); };
  function renderProducts() {
    const products = data.products || [], settings=data.settings||{};
    root.innerHTML=`<div class="shop-admin-heading"><div><p class="shop-label">Din webshop</p><h1>Produkter</h1><p>Tilføj dine egne produkter, billeder og priser. Kladder vises kun her.</p></div><button class="btn" data-new-product>Nyt produkt ${icon('plus')}</button></div>${notice?`<p class="notice ok" role="status">${esc(notice)}</p>`:''}
      <div class="shop-admin-layout"><section class="shop-admin-list" aria-label="Produkter">${products.length?products.map(p=>`<button class="shop-admin-product ${selected===p.id?'selected':''}" data-edit="${esc(p.id)}" aria-pressed="${selected===p.id}"><span class="shop-admin-thumb">${image(p)}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.category||'Uden kategori')} · ${money(p.priceOre)}</small></span><span><small>${p.published?'Publiceret':'Kladde'}</small><small>${p.stock} på lager</small></span></button>`).join(''):'<div class="shop-admin-empty"><h2>Start med din første vare.</h2><p>Du bestemmer sortimentet. Opret en kladde, tilføj et billede, og publicér, når produktet er klar.</p></div>'}</section><section class="shop-editor-panel" aria-label="Produkteditor">${editorHTML(products.find(p=>p.id===selected))}</section></div>
      <details class="shop-settings" ${products.length?'':'open'}><summary>Levering og betaling</summary><p>Onlinebetaling åbnes først, når salonens betalingskonto og handelsbetingelser er klar.</p><p class="shop-config-state">${settings.checkoutEnabled?'Onlinebetaling er klar.':'Onlinebetaling er ikke aktiveret.'}</p><form id="shop-settings-form" class="shop-fields"><label>Fragtpris, inkl. moms (kr.)<input name="shippingFee" inputmode="decimal" type="number" min="0" step="0.01" value="${Number(settings.shippingFeeOre||0)/100}" required></label><label>Forventet leveringstid<input name="shippingDays" maxlength="80" value="${esc(settings.shippingDays||'')}" placeholder="Fx 2–5 hverdage" required></label><label class="shop-span">Link til handelsbetingelser<input name="termsUrl" type="url" value="${esc(settings.termsUrl||'')}" placeholder="https://…" ${settings.shippingEnabled?'required':''}></label><label class="shop-check shop-span"><input name="shippingEnabled" type="checkbox" ${settings.shippingEnabled?'checked':''}> Åbn for levering i Danmark</label><button class="btn" type="submit">Gem leveringsindstillinger</button><p class="shop-form-error" role="alert"></p></form></details>`;
    root.querySelector('[data-new-product]').onclick=()=>{selected=null;notice='';renderProducts();root.querySelector('[name="name"]').focus();};
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{selected=b.dataset.edit;notice='';renderProducts();root.querySelector('[name="name"]').focus();});
    bindEditor();
    root.querySelector('[name="shippingEnabled"]').onchange=e=>{root.querySelector('[name="termsUrl"]').required=e.target.checked;};
    root.querySelector('#shop-settings-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),button=form.querySelector('button');button.disabled=true;try{await api('admin/shop/settings',{method:'PUT',body:{shippingFeeOre:Math.round(Number(f.get('shippingFee'))*100),shippingDays:f.get('shippingDays'),termsUrl:f.get('termsUrl'),shippingEnabled:f.has('shippingEnabled')}});await refresh();notice='Leveringsindstillingerne er gemt.';renderProducts();}catch(err){form.querySelector('.shop-form-error').textContent=err.message;button.disabled=false;}};
  }
  function editorHTML(p) {
    return `<h2>${p ? 'Redigér produkt' : 'Nyt produkt'}</h2><form id="shop-product-form" class="shop-fields"><label class="shop-span">Produktnavn<input name="name" value="${esc(p?.name || '')}" maxlength="100" required placeholder="Fx styling clay, 100 ml"></label><label class="shop-span">Beskrivelse<textarea name="description" rows="4" maxlength="1200" placeholder="Hvad gør produktet, og hvordan bruges det?">${esc(p?.description || '')}</textarea></label><label>Kategori<input name="category" value="${esc(p?.category || '')}" maxlength="60" placeholder="Fx Styling"></label><label>Pris inkl. moms (kr.)<input name="price" type="number" min="1" max="100000" step="0.01" inputmode="decimal" value="${p ? Number(p.priceOre) / 100 : ''}" required></label><label>Tilgængeligt lager<input name="stock" type="number" min="0" max="100000" step="1" value="${p?.stock ?? 0}" required><small>Ekskl. reserverede varer</small></label><label class="shop-check"><input type="checkbox" name="published" ${p?.published ? 'checked' : ''}> Publicér på webshoppen</label>
      <fieldset class="shop-image-editor shop-span"><legend>Produktbilleder</legend><p>Op til seks billeder. Det første vises på hylden, og det andet vises, når kunden peger på produktet. Alle billeder kan ses på produktsiden.</p><div class="shop-admin-images" data-editor-images></div><label class="shop-image-add" for="shop-image-file">Tilføj billeder <input id="shop-image-file" name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><input name="replaceImageFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><p class="small muted">JPG, PNG eller WebP, højst 12 MB pr. billede. Vi tilpasser størrelsen automatisk.</p><p class="shop-upload-status" role="status"></p></fieldset>
      <div class="shop-editor-actions shop-span"><button class="btn" type="submit">${p ? 'Gem ændringer' : 'Opret produkt'}</button>${p ? '<button class="btn btn-line" type="button" data-archive>Fjern fra webshop</button>' : ''}</div><p class="shop-form-error shop-span" role="alert"></p></form>`;
  }
  function bindEditor() {
    const form = root.querySelector('#shop-product-form');
    let uploading = false, replacing = null;
    let images = productImages(data.products.find(p => p.id === selected) || {});
    const status = form.querySelector('.shop-upload-status');
    const setUploadLock = busy => {
      uploading = busy;
      form.querySelector('[type="submit"]').disabled = busy;
      form.querySelector('[name="imageFile"]').disabled = busy || images.length >= 6;
      root.querySelectorAll('[data-edit], [data-new-product], [data-archive]').forEach(b => b.disabled = busy);
      form.querySelectorAll('.shop-admin-images button').forEach(b => b.disabled = busy || (b.hasAttribute('data-image-earlier') && +b.dataset.imageEarlier === 0) || (b.hasAttribute('data-image-later') && +b.dataset.imageLater === images.length - 1));
    };
    function renderImages(focusIndex) {
      form.querySelector('[data-editor-images]').innerHTML = images.length ? images.map((url, index) => `<div class="shop-admin-image"><div class="shop-admin-image-frame"><img src="${esc(url)}" alt="Produktbillede ${index + 1}" loading="lazy"><span>${index === 0 ? 'Forsidebillede' : `Billede ${index + 1}`}</span></div><div class="shop-image-actions"><button type="button" data-image-earlier="${index}" class="shop-icon-button" aria-label="Flyt billede ${index + 1} en plads frem" ${index === 0 ? 'disabled' : ''}>${icon('chevronLeft')}</button><button type="button" data-image-later="${index}" class="shop-icon-button" aria-label="Flyt billede ${index + 1} en plads tilbage" ${index === images.length - 1 ? 'disabled' : ''}>${icon('chevronRight')}</button><button type="button" data-image-replace="${index}">Erstat</button><button type="button" data-image-remove="${index}" aria-label="Fjern billede ${index + 1}">${icon('close')}</button></div></div>`).join('') : '<p class="shop-image-placeholder">Tilføj dine egne billeder af produktet. En kladde kan gemmes uden billeder.</p>';
      const move = (from, to) => {
        if (uploading || to < 0 || to >= images.length) return;
        [images[from], images[to]] = [images[to], images[from]];
        renderImages(to); status.textContent = `Billedet er flyttet til plads ${to + 1}. Gem produktet for at beholde rækkefølgen.`;
      };
      form.querySelectorAll('[data-image-earlier]').forEach(b => b.onclick = () => move(+b.dataset.imageEarlier, +b.dataset.imageEarlier - 1));
      form.querySelectorAll('[data-image-later]').forEach(b => b.onclick = () => move(+b.dataset.imageLater, +b.dataset.imageLater + 1));
      form.querySelectorAll('[data-image-remove]').forEach(b => b.onclick = () => { if (uploading) return; images.splice(+b.dataset.imageRemove, 1); renderImages(); status.textContent = 'Billedet er fjernet fra denne kladde. Gem produktet for at beholde ændringen.'; form.querySelector('[name="imageFile"]').focus(); });
      form.querySelectorAll('[data-image-replace]').forEach(b => b.onclick = () => { if (uploading) return; replacing = +b.dataset.imageReplace; form.querySelector('[name="replaceImageFile"]').click(); });
      setUploadLock(uploading);
      if (Number.isInteger(focusIndex)) form.querySelector(`[data-image-replace="${focusIndex}"]`)?.focus();
    }
    async function upload(files, replaceIndex = null) {
      if (!files.length || uploading) return;
      if (replaceIndex === null && files.length > 6 - images.length) { status.textContent = `Der er plads til ${6 - images.length} flere billeder. Vælg færre filer.`; return; }
      setUploadLock(true); let completed = 0;
      try {
        for (const file of files) {
          status.textContent = `Tilpasser og gemmer billede ${completed + 1} af ${files.length}…`;
          const blob = await prepareProductImage(file);
          const response = await fetch('/api/admin/shop/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': blob.type }, body: blob });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Billedet kunne ikke gemmes.');
          if (!safeImage(result.imageUrl)) throw new Error('Ugyldigt billedlink.');
          if (!form.isConnected) return;
          if (replaceIndex === null) images.push(result.imageUrl); else images[replaceIndex] = result.imageUrl;
          completed++; renderImages();
        }
        status.textContent = `${completed === 1 ? 'Billedet er klar.' : `${completed} billeder er klar.`} Gem produktet for at beholde ændringerne.`;
      } catch (err) { status.textContent = `${completed ? `${completed} billeder blev tilføjet. ` : ''}${err.message}`; }
      finally {
        if (form.isConnected) { setUploadLock(false); form.querySelector('[name="imageFile"]').value = ''; form.querySelector('[name="replaceImageFile"]').value = ''; }
      }
    }
    form.querySelector('[name="imageFile"]').onchange = e => upload([...e.target.files]);
    form.querySelector('[name="replaceImageFile"]').onchange = e => { if (Number.isInteger(replacing)) upload([...e.target.files].slice(0, 1), replacing); };
    renderImages();
    form.onsubmit = async e => {
      e.preventDefault(); if (uploading) return;
      const f = new FormData(form), button = form.querySelector('[type="submit"]'); button.disabled = true;
      const error = form.querySelector('.shop-form-error'); error.textContent = '';
      if (f.has('published') && !images.length) { error.textContent = 'Tilføj mindst ét produktbillede, før produktet publiceres.'; button.disabled = false; return; }
      try {
        const body = { revision: data.products.find(p => p.id === selected)?.revision, name: f.get('name'), description: f.get('description'), category: f.get('category'), priceOre: Math.round(Number(f.get('price')) * 100), stock: Number(f.get('stock')), published: f.has('published'), images: [...images], imageUrl: images[0] || '' };
        const r = await api(`admin/shop/products${selected ? '/' + encodeURIComponent(selected) : ''}`, { method: selected ? 'PUT' : 'POST', body });
        if (!form.isConnected) return;
        selected = r.product?.id || selected; await refresh(); notice = 'Produktet er gemt.'; renderProducts();
      } catch (err) {
        error.textContent = err.message; button.disabled = false;
        if (err.status === 409) {
          const reload = document.createElement('button'); reload.type = 'button'; reload.className = 'btn btn-line'; reload.textContent = 'Genindlæs seneste produkt';
          reload.onclick = async () => { reload.disabled = true; try { await refresh(); notice = 'Produktet er genindlæst. Kontrollér lagerantal og dine ændringer før du gemmer.'; renderProducts(); } catch (loadError) { error.textContent = loadError.message; } };
          error.append(document.createElement('br'), reload);
        }
      }
    };
    form.querySelector('[data-archive]')?.addEventListener('click', async () => {
      if (uploading) return;
      const b = form.querySelector('[data-archive]'); b.disabled = true;
      try { await api('admin/shop/products/' + encodeURIComponent(selected), { method: 'DELETE' }); if (!form.isConnected) return; await refresh(); notice = 'Produktet er fjernet fra webshoppen og gemt som kladde.'; renderProducts(); }
      catch (err) { form.querySelector('.shop-form-error').textContent = err.message; b.disabled = false; }
    });
  }
  function renderOrders() {
    const labels={creating:'Opretter betaling',pending:'Afventer betaling',paid:'Betalt – klar til afsendelse',fulfilled:'Afsendt',expired:'Betaling udløbet',cancelled:'Annulleret'};
    root.innerHTML=`<div class="shop-admin-heading"><div><p class="shop-label">Din webshop</p><h1>Ordrer</h1><p>En ordre må først sendes, når betalingen er bekræftet.</p></div><button class="btn btn-line" data-refresh-orders>Opdatér</button></div>${notice?`<p class="notice ok" role="status">${esc(notice)}</p>`:''}<div class="shop-orders">${data.orders?.length?data.orders.map(o=>`<article class="shop-order"><div class="shop-order-head"><div><h2>Ordre ${esc(o.id)}</h2><p>${o.createdAt?esc(new Date(o.createdAt).toLocaleString('da-DK')):''}</p></div><span class="shop-order-status">${esc(labels[o.status]||o.status)}</span></div><div class="shop-order-grid"><div>${(o.lines||o.items||[]).map(i=>`<p>${esc(i.quantity)} × ${esc(i.name||i.productId)} <strong>${money(i.totalOre??(i.priceOre||0)*i.quantity)}</strong></p>`).join('')}<p>Fragt <strong>${money(o.shippingFeeOre)}</strong></p><p class="shop-order-total">I alt <strong>${money(o.totalOre)}</strong></p></div><div>${orderCustomer(o)}</div></div>${o.status==='paid'?`<button class="btn" data-fulfil="${esc(o.id)}">Markér som afsendt</button>`:''}<p class="shop-form-error" role="alert"></p></article>`).join(''):'<div class="shop-admin-empty"><h2>Her lander dine ordrer.</h2><p>Når kunder har bestilt, kan du se betaling, varer og leveringsoplysninger her.</p></div>'}</div>`;
    root.querySelector('[data-refresh-orders]').onclick=async e=>{e.target.disabled=true;try{await refresh();renderOrders();}catch(err){notice='Kunne ikke hente nye ordrer. '+err.message;renderOrders();}};
    root.querySelectorAll('[data-fulfil]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await api('admin/shop/orders/'+encodeURIComponent(b.dataset.fulfil),{method:'PATCH',body:{status:'fulfilled'}});await refresh();notice='Ordren er markeret som afsendt.';renderOrders();}catch(err){b.closest('article').querySelector('.shop-form-error').textContent=err.message;b.disabled=false;}});
  }
  render();
}
function orderCustomer(order) {
  const customer=order.customer||{},shipping=order.shipping||order.shippingDetails||{},address=order.shippingAddress||shipping.address||customer.address||{};
  return `<p><strong>${esc(shipping.name||customer.name||'Leveringsoplysninger vises efter betaling')}</strong></p>${customer.email?`<p>${esc(customer.email)}</p>`:''}${customer.phone?`<p>${esc(customer.phone)}</p>`:''}${address.line1?`<p>${esc(address.line1)}<br>${esc(address.line2||'')}<br>${esc(address.postal_code||address.postalCode||'')} ${esc(address.city||'')}<br>${esc(address.country||'')}</p>`:''}`;
}
async function prepareProductImage(file) {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Vælg et billede i JPG, PNG eller WebP.');
  if(file.size>12*1024*1024)throw new Error('Vælg et billede under 12 MB.');
  const url=URL.createObjectURL(file),img=new Image();
  try{img.src=url;await img.decode();const scale=Math.min(1,1200/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);let blob;for(const quality of [.85,.7,.55,.4]){blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));if(blob&&blob.size<=800000)return blob;}throw new Error('Billedet er for stort. Prøv et mindre billede.');}finally{URL.revokeObjectURL(url);}
}
