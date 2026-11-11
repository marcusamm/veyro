import { icon } from './icons.js';
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function imageMarkup(name,alt,{hero=false,sizes='100vw',cls=''}={}) {
  const small=['mid-fade-skaeg','taper-tekstur'].includes(name);
  const widths=small?[414]:['salonen-forside','salonen-hero'].includes(name)?[480,900,1600]:[480,900,1200];
  return `<img class="${cls}" src="img/optimized/${name}-${widths.at(-1)}.webp" srcset="${widths.map(w=>`img/optimized/${name}-${w}.webp ${w}w`).join(',')}" sizes="${sizes}" alt="${esc(alt)}" ${hero?'fetchpriority="high"':'loading="lazy"'} decoding="async">`;
}
export function homepage({services,bookAttrs,SALON,hours,open,looks,servicePhotos}){
 const money=n=>`${new Intl.NumberFormat('da-DK').format(n)} kr.`;
 return `<main id="main" class="ed-home">
 <section class="ed-opening" aria-labelledby="sbb-title"><div class="ed-stage">
   <figure class="ed-hero-photo">${imageMarkup('high-fade-skaeg','Kort fade med skæg — et klip fra StyleByBrothers',{hero:true})}<figcaption>01 — Fade & skæg</figcaption></figure>
   <div class="ed-hero-scrim" aria-hidden="true"></div>
   <div class="ed-hero-copy"><h1 id="sbb-title"><span>Mere end en</span><span>frisørsalon</span></h1><div class="ed-hero-actions"><a class="sbb-book" ${bookAttrs()}>Book tid</a></div></div>
 </div></section>
 <section class="ed-intro ed-wrap" aria-labelledby="intro-title"><p class="ed-eyebrow">Din lokale barbershop</p><div><h2 id="intro-title">En fade helt tæt. <br>Eller længde på toppen.</h2><div class="ed-intro-bottom"><p>Hos StyleByBrothers klipper vi med saks og maskine og former skægget. Kom med dit faste klip eller et billede af det, du har i tankerne. Du finder os på Sct. Mikkelsgade i Slagelse.</p><a class="ed-line-link" href="#/#galleri">Se vores klip ${icon('arrowUp')}</a></div></div></section>
 <section id="priser" class="ed-treatments ed-wrap" aria-labelledby="priser-titel"><div class="ed-section-top"><p class="ed-eyebrow">Behandlinger & priser</p><h2 id="priser-titel">Dit næste klip.</h2></div><div class="ed-treatment-layout"><div class="ed-treatment-visual" aria-hidden="true">${services.map((s,i)=>{const name=(servicePhotos[s.id]||'img/high-fade-skaeg.jpg').replace('img/','').replace('.jpg','');return `<div class="ed-treatment-frame ${i===0?'is-current':''}" data-service-image="${esc(s.id)}">${imageMarkup(name,'',{sizes:'(max-width:900px) 100vw, 34vw'})}</div>`;}).join('')}<span class="ed-photo-note">Klip fra StyleByBrothers</span></div><div class="ed-treatment-list"><div class="ed-treatment-labels" aria-hidden="true"><span>Behandling</span><span>Tid</span><span>Pris</span><span></span></div>${services.map((s,i)=>`<a class="ed-treatment" data-service-hover="${esc(s.id)}" ${bookAttrs(s.id)}><div><span class="ed-service-number">0${i+1}</span><h3>${esc(s.name)}</h3><p>${esc(s.desc)}</p></div><span class="ed-duration">${s.duration} min.</span><strong>${money(s.price)}</strong>${icon('arrowUp')}</a>`).join('')}<p class="ed-fine">Priser inkl. moms. Betaling i salonen. <br>Har du allerede en tid? <a href="#/min-booking">Flyt eller aflys din booking.</a></p></div></div></section>
 <section id="galleri" class="ed-gallery" aria-labelledby="galleri-titel"><div class="ed-wrap ed-gallery-heading"><div><p class="ed-eyebrow">Udvalgte klip</p><h2 id="galleri-titel">Fra stolen.</h2></div><div><p>Forskellige hår. Forskellige udtryk.</p><div class="ed-gallery-controls"><button data-act="gallery-prev" aria-label="Se forrige klip">${icon('arrowLeft')}</button><span>01 — ${String(looks.length).padStart(2,'0')}</span><button data-act="gallery-next" aria-label="Se flere klip">${icon('arrow')}</button></div></div></div><div class="sbb-gallery__track ed-gallery-track" role="region" aria-label="Galleri med salonens klipninger. Brug pilene til at bladre." tabindex="0">${looks.map((look,i)=>`<button class="sbb-look ed-look ed-look--${i}" type="button" data-act="look-open" data-index="${i}" aria-label="Se større billede: ${esc(look.title)}"><span class="ed-look-image">${imageMarkup(look.src.replace('img/','').replace('.jpg',''),look.title,{sizes:'(max-width:600px) 82vw, 50vw'})}<span class="ed-zoom" aria-hidden="true">${icon('plus')}</span></span><span class="ed-look-caption"><span>${esc(look.title)}</span><span>0${i+1}</span></span></button>`).join('')}</div><div class="ed-wrap ed-gallery-bottom"><span>Swipe, træk eller brug pilene. Klik for at se tættere på.</span><a class="ed-line-link" href="${SALON.instagram}" target="_blank" rel="noopener">Flere klip på Instagram ${icon('arrowUp')}</a></div><dialog class="sbb-lightbox" aria-labelledby="look-title"><div class="sbb-lightbox__top"><p id="look-title"></p><button type="button" data-act="look-close" aria-label="Luk billedet">Luk ${icon('close')}</button></div><img src="${looks[0].src}" alt="${esc(looks[0].title)}" loading="lazy"><div class="sbb-lightbox__bottom"><button type="button" data-act="look-prev" aria-label="Forrige billede">${icon('arrowLeft')}</button><span data-look-counter>1 / ${looks.length}</span><button type="button" data-act="look-next" aria-label="Næste billede">${icon('arrow')}</button></div></dialog></section>
 <section id="salonen" class="ed-salon ed-wrap" aria-labelledby="salonen-titel"><div class="ed-salon-copy"><p class="ed-eyebrow">Salonen</p><h2 id="salonen-titel">Midt i <br>Slagelse.</h2><p>Spejle, barberstole og plads til dit næste klip. Her arbejder vi med overgange, længder og konturer — fra den korte fade til et klassisk klip med saks.</p><a class="ed-line-link" ${bookAttrs()}>Find en ledig tid ${icon('arrowUp')}</a></div><figure class="ed-salon-photo">${imageMarkup('salonen-forside','Salonen i Slagelse med barberstole, spejle og produkthylder',{sizes:'(max-width:800px) 100vw, 65vw'})}<figcaption>StyleByBrothers / Slagelse</figcaption></figure></section>
 <section class="ed-featured ed-wrap" aria-labelledby="ed-products-title"><div class="ed-featured-head"><div><p class="ed-eyebrow">Pleje & styling</p><h2 id="ed-products-title">Med hjem.</h2></div><p>Spørg os om pleje og styling til dit hår. <br>Se det aktuelle udvalg i webshoppen.</p><a class="ed-line-link" href="#/shop">Alle produkter ${icon('arrowUp')}</a></div><div id="featured-products" aria-live="polite"><p class="ed-fine">Henter udvalget…</p></div></section>
 <section id="find-os" class="ed-visit" aria-labelledby="find-titel"><div class="ed-wrap ed-visit-grid"><div><p class="ed-eyebrow">Besøg os</p><h2 id="find-titel">Kom forbi.</h2><address>${SALON.street} <br>${SALON.city}</address><a class="ed-line-link" href="${SALON.maps}" target="_blank" rel="noopener">Vis vej ${icon('arrowUp')}</a><a class="ed-phone" href="${SALON.phoneHref}">${SALON.phone.replace('+45 ','')} ${icon('arrowUp')}</a></div><div class="ed-hours"><h3>Åbningstider</h3><p class="ed-fine">${esc(open.text)}</p><table><tbody>${hours.map(h=>`<tr><th scope="row">${esc(h.label)}</th><td>${esc(h.text)}</td></tr>`).join('')}</tbody></table><p class="ed-fine">Book online, eller ring til os for at aftale en tid.</p><div class="ed-social"><a href="${SALON.instagram}" target="_blank" rel="noopener">Instagram ${icon('arrowUp')}</a><a href="${SALON.facebook}" target="_blank" rel="noopener">Facebook ${icon('arrowUp')}</a></div></div></div></section>
 <section class="ed-closing ed-wrap" aria-labelledby="closing-title"><p class="ed-eyebrow">Din næste tid</p><a ${bookAttrs()} aria-label="Book din næste tid"><h2 id="closing-title">Vi ses <br>i stolen.</h2><span class="ed-closing-arrow">${icon('arrowUp')}</span></a><div><span>Vælg behandling. Find en tid.</span><span>Ingen konto nødvendig.</span></div></section>
 </main><a class="ed-mobile-book" ${bookAttrs()}>Book din næste tid ${icon('arrowUp')}</a>`;
}

export function mountEditorial(root){
 const abort=new AbortController();const signal=abort.signal;
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 let serviceId='',revealToken=0;
 const frames=[...root.querySelectorAll('.ed-treatment-frame')];
 root.querySelectorAll('[data-service-hover]').forEach(link=>{
   const reveal=async()=>{
     const nextId=link.dataset.serviceHover;if(serviceId===nextId)return;serviceId=nextId;const token=++revealToken;
     const next=frames.find(f=>f.dataset.serviceImage===nextId);if(!next)return;
     await next.querySelector('img').decode().catch(()=>{});if(signal.aborted||token!==revealToken)return;
     frames.forEach(f=>f.classList.toggle('is-current',f===next));
   };
   link.addEventListener('pointerenter',reveal,{signal});link.addEventListener('focus',reveal,{signal});
 });
 const track=root.querySelector('.ed-gallery-track');
 track?.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();track.scrollTo({left:e.key==='Home'?0:e.key==='End'?track.scrollWidth:track.scrollLeft+(e.key==='ArrowRight'?1:-1)*track.clientWidth*.7,behavior:reduced()?'instant':'smooth'});}},{signal});
 const mobile=document.querySelector('.ed-mobile-book');
 const stage=root.querySelector('.ed-stage');
 const observer=new IntersectionObserver(([entry])=>mobile?.classList.toggle('is-visible',!entry.isIntersecting),{threshold:0});if(stage)observer.observe(stage);
 // Normal document flow: no pin, scroll timeline, hidden headings or delayed reveals.
 const cleanup=()=>{abort.abort();observer.disconnect();};
 cleanup.ready=document.fonts.ready;return cleanup;
}
