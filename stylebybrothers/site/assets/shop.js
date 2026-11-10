// SBB shop: catalog and owner tools. Prices, stock and payment are authoritative on the server.
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK' }).format(Number(value || 0) / 100);
const safeImage = url => typeof url === 'string' && (/^\/api\/shop\/images\/[a-zA-Z0-9-]+$/.test(url) || /^https:\/\//.test(url)) ? url : '';
const image = p => safeImage(p.imageUrl) ? `<img src="${esc(p.imageUrl)}" alt="${esc(p.name)}" loading="lazy" decoding="async">` : '<span class="shop-no-image" aria-label="Intet produktbillede">S/B</span>';
const CART_KEY = 'sbb-shop-cart-v1';
function readCart() { try { const data = JSON.parse(sessionStorage.getItem(CART_KEY) || '[]'); return Array.isArray(data) ? data.filter(i => typeof i.productId === 'string' && Number.isInteger(i.quantity) && i.quantity > 0).slice(0,30) : []; } catch { return []; } }
function saveCart(cart) { try { sessionStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* private browser mode: in-memory cart still works */ } }
const failure = err => esc(err?.message || 'Der skete en fejl. Prøv igen.');

export async function mountShop(root, { api }) {
  root.classList.add('sbb-shop');
  root.innerHTML = '<div class="shop-loading" role="status">Vi henter hylden…</div>';
  let products, settings;
  try { ({ products, settings } = await api('shop/products')); } catch (err) {
    root.innerHTML = `<div class="shop-empty"><h2>Hylden kunne ikke hentes.</h2><p>${failure(err)}</p><button class="shop-btn" data-retry>Prøv igen</button></div>`;
    root.querySelector('[data-retry]').onclick = () => mountShop(root, { api }); return;
  }
  if (!root.isConnected) return;
  products ||= []; settings ||= {};
  let cart = readCart().filter(i => products.some(p => p.id === i.productId && p.stock > 0)).map(i => ({...i, quantity:Math.min(i.quantity, products.find(p=>p.id===i.productId).stock)}));
  let category = 'Alle', checkoutBusy = false, checkoutKey = crypto.randomUUID(), message = '';
  const categories = ['Alle', ...new Set(products.map(p => p.category).filter(Boolean))];
  const params = new URLSearchParams((location.hash.split('?')[1] || ''));
  if (params.has('order')) message = 'Tak. Vi afventer betalingsbekræftelsen. Din ordre er først betalt, når betalingen er gennemført hos Stripe.';
  if (params.has('cancelled')) message = 'Betalingen blev ikke gennemført. Du kan fortsætte herfra, når du er klar.';
  const total = () => cart.reduce((sum, i) => sum + (products.find(p => p.id === i.productId)?.priceOre || 0) * i.quantity, 0);
  const count = () => cart.reduce((sum, i) => sum + i.quantity, 0);
  const render = () => {
    const shown = category === 'Alle' ? products : products.filter(p => p.category === category);
    root.innerHTML = `<section class="shop-intro"><div><p class="shop-label">StyleByBrothers / Produkter</p><h1>Den gode stil.<br><span>Også derhjemme.</span></h1></div><div class="shop-intro-note"><p>Hår, skæg og det sidste finish. Find din næste favorit på salonens hylde.</p><span>Levering i Danmark · Priser inkl. moms</span></div></section>
      ${message ? `<p class="shop-notice" role="status">${esc(message)}</p>` : ''}
      <div class="shop-toolbar"><div class="shop-filters" aria-label="Produktkategorier">${categories.map(c=>`<button data-category="${esc(c)}" aria-pressed="${c===category}">${esc(c)}</button>`).join('')}</div><button class="shop-cart-link" data-cart>Din kurv <span>${count()}</span> ↗</button></div>
      ${products.length ? `<div class="shop-grid">${shown.map(p => `<article class="shop-product"><button class="shop-product-image" data-detail="${esc(p.id)}" aria-label="Se ${esc(p.name)}">${image(p)}${p.stock < 1 ? '<span class="shop-stock-tag">Udsolgt</span>' : ''}</button><div class="shop-product-meta"><p class="shop-label">${esc(p.category || 'Fra salonen')}</p><span>${money(p.priceOre)}</span></div><h2><button data-detail="${esc(p.id)}">${esc(p.name)}</button></h2><button class="shop-add" data-add="${esc(p.id)}" ${p.stock < 1 ? 'disabled' : ''}>${p.stock < 1 ? 'Udsolgt' : 'Læg i kurv'} <span aria-hidden="true">+</span></button></article>`).join('')}</div>` : `<div class="shop-empty"><span class="shop-empty-mark" aria-hidden="true">S/B</span><div><p class="shop-label">Snart på hylden</p><h2>Gode produkter<br>er værd at vente på.</h2><p>Vi gør webshoppen klar. Spørg os i salonen om pleje og styling, der passer til dit hår.</p><a class="shop-btn" href="#/booking">Book en tid ↗</a></div></div>`}
      <div class="shop-service-note"><p><strong>Brug for et godt råd?</strong><br>Vi hjælper dig med at finde den rigtige pleje.</p><a href="tel:+4561707044">Ring på 61 70 70 44 ↗</a></div><div class="shop-live sr-only" aria-live="polite"></div>`;
    root.querySelectorAll('[data-category]').forEach(button => button.onclick = () => { category = button.dataset.category; render(); root.querySelector(`[data-category="${CSS.escape(category)}"]`)?.focus(); });
    root.querySelectorAll('[data-detail]').forEach(button => button.onclick = () => detail(button.dataset.detail, button));
    root.querySelectorAll('[data-add]').forEach(button => button.onclick = () => add(button.dataset.add));
    root.querySelector('[data-cart]').onclick = () => cartDialog();
  };
  const add = id => {
    const p = products.find(p => p.id === id); if (!p || p.stock < 1) return;
    const item = cart.find(i => i.productId === id);
    if (item && item.quantity >= p.stock) { announce('Du har allerede lagt det tilgængelige antal i kurven.'); return; }
    if (item) item.quantity++; else cart.push({ productId:id, quantity:1 });
    checkoutKey = crypto.randomUUID(); saveCart(cart);
    const badge = root.querySelector('.shop-cart-link span'); if (badge) badge.textContent = count();
    announce(`${p.name} er lagt i kurven.`);
  };
  const announce = text => { const el = root.querySelector('.shop-live'); if (el) el.textContent = text; const button = root.querySelector('.shop-cart-link'); if (button) button.classList.add('has-items'); };
  function dialog(html, returnTo) {
    root.querySelector('dialog')?.remove();
    const d = document.createElement('dialog'); d.className = 'shop-dialog'; d.innerHTML = `<button class="shop-close" aria-label="Luk" data-close>×</button>${html}`;
    root.append(d); d.showModal(); d.querySelector('[data-close]').onclick = () => d.close();
    d.addEventListener('click', event => { if (event.target === d) { const r=d.getBoundingClientRect(); if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)d.close(); } });
    d.addEventListener('close', () => { d.remove(); if(returnTo?.isConnected)returnTo.focus(); }); return d;
  }
  function detail(id, returnTo) {
    const p = products.find(p => p.id === id); if (!p) return;
    const d = dialog(`<div class="shop-detail"><div class="shop-detail-image">${image(p)}</div><div><p class="shop-label">${esc(p.category || 'Fra salonen')}</p><h2 id="shop-detail-title">${esc(p.name)}</h2><p class="shop-detail-description">${esc(p.description)}</p><p class="shop-detail-price">${money(p.priceOre)} <small>inkl. moms</small></p><p class="shop-availability">${p.stock > 0 ? 'På lager' : 'Udsolgt'}</p><button class="shop-btn" data-detail-add ${p.stock < 1 ? 'disabled' : ''}>Læg i kurv +</button><p class="shop-detail-delivery">${settings.shippingEnabled ? `Levering i Danmark${settings.shippingDays ? ' · '+esc(settings.shippingDays) : ''}. Fragt ${money(settings.shippingFeeOre)}.` : 'Webshoppen klargøres til levering.'}</p><p class="shop-detail-feedback" role="status"></p></div></div>`,returnTo);
    d.setAttribute('aria-labelledby','shop-detail-title');
    d.querySelector('[data-detail-add]').onclick = () => { add(p.id); d.querySelector('.shop-detail-feedback').textContent='Kurven er opdateret.'; };
  }
  function cartDialog() {
    const d = dialog('<div class="shop-cart-content"></div>',root.querySelector('[data-cart]')); d.setAttribute('aria-label','Din kurv');
    const content = d.querySelector('.shop-cart-content');
    const draw = () => {
      content.innerHTML = `<p class="shop-label">Det sidste finish</p><h2>Din kurv <span>(${count()})</span></h2>${cart.length ? `<div class="shop-cart-items">${cart.map(i=>{const p=products.find(p=>p.id===i.productId);return `<article class="shop-cart-item"><div class="shop-cart-image">${image(p)}</div><div><h3>${esc(p.name)}</h3><p>${money(p.priceOre)}</p><label class="shop-quantity">Antal <input type="number" min="1" max="${p.stock}" step="1" value="${i.quantity}" ${checkoutBusy?'disabled':''} data-quantity="${esc(p.id)}" aria-label="Antal ${esc(p.name)}"></label><button class="shop-remove" ${checkoutBusy?'disabled':''} data-remove="${esc(p.id)}">Fjern</button></div><strong>${money(p.priceOre*i.quantity)}</strong></article>`;}).join('')}</div><dl class="shop-totals"><div><dt>Varer</dt><dd>${money(total())}</dd></div><div><dt>Levering i Danmark</dt><dd>${settings.shippingEnabled ? money(settings.shippingFeeOre) : 'Ikke åbnet endnu'}</dd></div><div class="shop-total"><dt>I alt, inkl. moms</dt><dd>${money(total() + (settings.shippingEnabled ? settings.shippingFeeOre || 0 : 0))}</dd></div></dl><p class="shop-checkout-note">${settings.checkoutEnabled ? `Du indtaster leveringsadresse og betaler sikkert hos Stripe.${settings.shippingDays ? ' Forventet levering: '+esc(settings.shippingDays)+'.' : ''}` : 'Onlinebetaling er ikke åbnet endnu. Kontakt salonen, hvis du har spørgsmål til produkterne.'}</p>${settings.termsUrl && /^https:\/\//.test(settings.termsUrl) ? `<p><a href="${esc(settings.termsUrl)}" target="_blank" rel="noopener">Læs handelsbetingelserne ↗</a></p>` : ''}<button class="shop-btn shop-checkout" data-checkout ${!settings.checkoutEnabled||checkoutBusy ? 'disabled' : ''}>${checkoutBusy?'Åbner betaling…':'Til sikker betaling ↗'}</button><p class="shop-checkout-error" role="alert"></p>` : '<p class="shop-cart-empty">Din kurv er tom. Find noget godt til hår og skæg på hylden.</p><button class="shop-btn" data-continue>Tilbage til produkterne</button>'}`;
      content.querySelector('[data-continue]')?.addEventListener('click',()=>d.close());
      content.querySelectorAll('[data-quantity]').forEach(input=>input.onchange=()=>{const i=cart.find(i=>i.productId===input.dataset.quantity),p=products.find(p=>p.id===i.productId); i.quantity=Math.max(1,Math.min(p.stock,Math.floor(Number(input.value)||1))); checkoutKey=crypto.randomUUID();saveCart(cart);draw();root.querySelector('.shop-cart-link span').textContent=count();});
      content.querySelectorAll('[data-remove]').forEach(button=>button.onclick=()=>{cart=cart.filter(i=>i.productId!==button.dataset.remove);checkoutKey=crypto.randomUUID();saveCart(cart);draw();root.querySelector('.shop-cart-link span').textContent=count();});
      content.querySelector('[data-checkout]')?.addEventListener('click',async()=>{if(checkoutBusy)return;checkoutBusy=true;draw();try{const r=await api('shop/checkout',{method:'POST',body:{items:cart,idempotencyKey:checkoutKey}});const u=new URL(r.url);if(u.protocol!=='https:'||u.hostname!=='checkout.stripe.com')throw new Error('Betalingslinket kunne ikke bekræftes. Kontakt salonen.');try{sessionStorage.setItem('sbb-shop-payment-order',r.orderId);}catch{}if(root.isConnected)location.assign(u.href);}catch(err){checkoutBusy=false;draw();content.querySelector('.shop-checkout-error').textContent=err.message;}});
    }; draw();
  }
  saveCart(cart); render();
  const returnOrder=params.get('order');
  if(returnOrder && /^[a-f0-9-]{36}$/i.test(returnOrder)) {
    let attempts=0;
    const checkPayment=async()=>{
      if(!root.isConnected)return;
      try {
        const result=await api('shop/orders/'+encodeURIComponent(returnOrder));
        if(!root.isConnected)return;
        if(['paid','fulfilled'].includes(result.status)) {
          message='Tak for din ordre. Betalingen er bekræftet. Vi gør dine produkter klar til levering.';
          try{if(sessionStorage.getItem('sbb-shop-payment-order')===returnOrder){cart=[];saveCart(cart);sessionStorage.removeItem('sbb-shop-payment-order');}}catch{}
          render();return;
        }
        if(result.status==='expired') {message='Betalingssessionen er udløbet. Der er ikke gennemført en betaling for denne ordre. Du kan prøve igen fra din kurv.';render();return;}
      } catch { /* Payment may still be arriving; never imply successful payment. */ }
      if(++attempts<8)setTimeout(checkPayment,1500);
      else{message='Betalingen er endnu ikke bekræftet her. Hvis du har betalt, skal du ikke betale igen. Kontakt os på 61 70 70 44, hvis du er i tvivl.';render();}
    };
    checkPayment();
  }
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
    root.innerHTML=`<div class="shop-admin-heading"><div><p class="shop-label">Din webshop</p><h1>Produkter</h1><p>Tilføj dine egne produkter, billeder og priser. Kladder vises kun her.</p></div><button class="btn" data-new-product>Nyt produkt +</button></div>${notice?`<p class="notice ok" role="status">${esc(notice)}</p>`:''}
      <div class="shop-admin-layout"><section class="shop-admin-list" aria-label="Produkter">${products.length?products.map(p=>`<button class="shop-admin-product ${selected===p.id?'selected':''}" data-edit="${esc(p.id)}"><span class="shop-admin-thumb">${image(p)}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.category||'Uden kategori')} · ${money(p.priceOre)}</small></span><span><small>${p.published?'Publiceret':'Kladde'}</small><small>${p.stock} på lager</small></span></button>`).join(''):'<div class="shop-admin-empty"><h2>Start med din første vare.</h2><p>Du bestemmer sortimentet. Opret en kladde, tilføj et billede, og publicér, når produktet er klar.</p></div>'}</section><section class="shop-editor-panel" aria-label="Produkteditor">${editorHTML(products.find(p=>p.id===selected))}</section></div>
      <details class="shop-settings" ${products.length?'':'open'}><summary>Levering og betaling</summary><p>Onlinebetaling åbnes først, når salonens betalingskonto og handelsbetingelser er klar.</p><p class="shop-config-state">${settings.checkoutEnabled?'Onlinebetaling er klar.':'Onlinebetaling er ikke aktiveret.'}</p><form id="shop-settings-form" class="shop-fields"><label>Fragtpris, inkl. moms (kr.)<input name="shippingFee" inputmode="decimal" type="number" min="0" step="0.01" value="${Number(settings.shippingFeeOre||0)/100}" required></label><label>Forventet leveringstid<input name="shippingDays" maxlength="80" value="${esc(settings.shippingDays||'')}" placeholder="Fx 2–5 hverdage" required></label><label class="shop-span">Link til handelsbetingelser<input name="termsUrl" type="url" value="${esc(settings.termsUrl||'')}" placeholder="https://…" ${settings.shippingEnabled?'required':''}></label><label class="shop-check shop-span"><input name="shippingEnabled" type="checkbox" ${settings.shippingEnabled?'checked':''}> Åbn for levering i Danmark</label><button class="btn" type="submit">Gem leveringsindstillinger</button><p class="shop-form-error" role="alert"></p></form></details>`;
    root.querySelector('[data-new-product]').onclick=()=>{selected=null;notice='';renderProducts();root.querySelector('[name="name"]').focus();};
    root.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{selected=b.dataset.edit;notice='';renderProducts();root.querySelector('[name="name"]').focus();});
    bindEditor();
    root.querySelector('[name="shippingEnabled"]').onchange=e=>{root.querySelector('[name="termsUrl"]').required=e.target.checked;};
    root.querySelector('#shop-settings-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),button=form.querySelector('button');button.disabled=true;try{await api('admin/shop/settings',{method:'PUT',body:{shippingFeeOre:Math.round(Number(f.get('shippingFee'))*100),shippingDays:f.get('shippingDays'),termsUrl:f.get('termsUrl'),shippingEnabled:f.has('shippingEnabled')}});await refresh();notice='Leveringsindstillingerne er gemt.';renderProducts();}catch(err){form.querySelector('.shop-form-error').textContent=err.message;button.disabled=false;}};
  }
  function editorHTML(p) {
    return `<h2>${p?'Redigér produkt':'Nyt produkt'}</h2><form id="shop-product-form" class="shop-fields"><label class="shop-span">Produktnavn<input name="name" value="${esc(p?.name||'')}" maxlength="100" required placeholder="Fx styling clay, 100 ml"></label><label class="shop-span">Beskrivelse<textarea name="description" rows="4" maxlength="1200" placeholder="Hvad gør produktet, og hvordan bruges det?">${esc(p?.description||'')}</textarea></label><label>Kategori<input name="category" value="${esc(p?.category||'')}" maxlength="60" placeholder="Fx Styling"></label><label>Pris inkl. moms (kr.)<input name="price" type="number" min="1" step="0.01" inputmode="decimal" value="${p?Number(p.priceOre)/100:''}" required></label><label>Tilgængeligt lager<input name="stock" type="number" min="0" max="100000" step="1" value="${p?.stock??0}" required><small>Ekskl. reserverede varer</small></label><label class="shop-check"><input type="checkbox" name="published" ${p?.published?'checked':''}> Publicér på webshoppen</label><div class="shop-span"><label for="shop-image-file">Produktbillede</label><div class="shop-upload-preview">${p?.imageUrl?image(p):'<span>Tilføj dit eget produktbillede</span>'}</div><input id="shop-image-file" name="imageFile" type="file" accept="image/jpeg,image/png,image/webp"><p class="small muted">JPG, PNG eller WebP. Billedet tilpasses automatisk til webshoppen.</p><input name="imageUrl" type="hidden" value="${esc(p?.imageUrl||'')}"><p class="shop-upload-status" role="status"></p></div><div class="shop-editor-actions shop-span"><button class="btn" type="submit">${p?'Gem ændringer':'Opret produkt'}</button>${p?'<button class="btn btn-line" type="button" data-archive>Fjern fra webshop</button>':''}</div><p class="shop-form-error shop-span" role="alert"></p></form>`;
  }
  function bindEditor() {
    const form=root.querySelector('#shop-product-form'); let uploading=false;
    form.querySelector('[name="imageFile"]').onchange=async e=>{
      const file=e.target.files[0];if(!file)return;const status=form.querySelector('.shop-upload-status');uploading=true;status.textContent='Tilpasser og gemmer billede…';form.querySelector('[type="submit"]').disabled=true;
      try{const blob=await prepareProductImage(file);const response=await fetch('/api/admin/shop/images',{method:'POST',credentials:'same-origin',headers:{'Content-Type':blob.type},body:blob});const result=await response.json();if(!response.ok)throw new Error(result.error||'Billedet kunne ikke gemmes.');if(!safeImage(result.imageUrl))throw new Error('Ugyldigt billedlink.');form.elements.imageUrl.value=result.imageUrl;form.querySelector('.shop-upload-preview').innerHTML=image({name:'Produktbillede',imageUrl:result.imageUrl});status.textContent='Billedet er gemt. Gem produktet for at knytte det til varen.';}catch(err){status.textContent=err.message;}finally{uploading=false;form.querySelector('[type="submit"]').disabled=false;}
    };
    form.onsubmit=async e=>{e.preventDefault();if(uploading)return;const f=new FormData(form),button=form.querySelector('[type="submit"]');button.disabled=true;try{const body={revision:data.products.find(p=>p.id===selected)?.revision,name:f.get('name'),description:f.get('description'),category:f.get('category'),priceOre:Math.round(Number(f.get('price'))*100),stock:Number(f.get('stock')),published:f.has('published'),imageUrl:f.get('imageUrl')};const r=await api(`admin/shop/products${selected?'/'+encodeURIComponent(selected):''}`,{method:selected?'PUT':'POST',body});selected=r.product?.id||selected;await refresh();notice='Produktet er gemt.';renderProducts();}catch(err){const error=form.querySelector('.shop-form-error');error.textContent=err.message;button.disabled=false;if(err.status===409){const reload=document.createElement('button');reload.type='button';reload.className='btn btn-line';reload.textContent='Genindlæs seneste produkt';reload.onclick=async()=>{await refresh();notice='Produktet er genindlæst. Kontrollér lagerantal og dine ændringer før du gemmer.';renderProducts();};error.append(document.createElement('br'),reload);}}};
    form.querySelector('[data-archive]')?.addEventListener('click',async()=>{const b=form.querySelector('[data-archive]');b.disabled=true;try{await api('admin/shop/products/'+encodeURIComponent(selected),{method:'DELETE'});await refresh();notice='Produktet er fjernet fra webshoppen og gemt som kladde.';renderProducts();}catch(err){form.querySelector('.shop-form-error').textContent=err.message;b.disabled=false;}});
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
