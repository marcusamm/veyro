export const js = String.raw`
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day = (date) => new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Copenhagen', year:'numeric', month:'2-digit', day:'2-digit' }).format(date);
  const today = day(new Date());
  const maxDate = day(new Date(Date.now() + 89*86400000));
  const dateText = (iso) => new Intl.DateTimeFormat('da-DK', {timeZone:'Europe/Copenhagen', weekday:'long', day:'numeric', month:'long', year:'numeric'}).format(new Date(iso));
  const timeText = (iso) => new Intl.DateTimeFormat('da-DK', {timeZone:'Europe/Copenhagen', hour:'2-digit', minute:'2-digit'}).format(new Date(iso));
  async function api(path, data, privateToken) {
    const response = await fetch('/api' + path, {method:data === undefined ? 'GET' : 'POST', credentials:'same-origin', headers: {...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(privateToken ? {'X-AJ-Token':privateToken} : {})}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
    let value;
    try { value = await response.json(); } catch { throw new Error('Vi kunne ikke få kontakt til systemet. Prøv igen, eller ring på 60 64 41 43.'); }
    if (!response.ok) throw new Error(value.error || value.message || 'Handlingen kunne ikke gennemføres. Prøv igen.');
    return value;
  }
  function errorIn(root, message) {
    let node = root.querySelector('.form-status');
    if (!node) { node = document.createElement('div'); node.className = 'form-status'; root.prepend(node); }
    node.classList.add('error'); node.setAttribute('role','alert'); node.textContent = message;
  }
  const menu = $('.menu-toggle');
  if (menu) menu.addEventListener('click', () => { const expanded = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(expanded)); $('#navigation').classList.toggle('is-open', expanded); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') { menu.click(); menu.focus(); } });
  let configPromise;
  const config = () => configPromise ||= api('/config');
  async function campaign() {
    const nodes = [$('#home-campaign'), $('#services-campaign')].filter(Boolean);
    if (!nodes.length) return;
    try {
      const {campaign:c} = await config();
      if (!c) return;
      nodes.forEach(node => {
        node.className='campaign'; node.hidden=false;
        node.innerHTML='<p class="eyebrow">Aktuel kampagne</p><strong>'+esc(c.title)+' · '+esc(new Intl.NumberFormat('da-DK',{style:'currency',currency:'DKK',maximumFractionDigits:0}).format(c.priceOre/100))+'</strong><p>Inklusive motorolie og oliefilter. Gælder til '+esc(dateText(c.expiresOn+'T12:00:00Z'))+'. Kontakt os om en tid til din bil.</p>';
      });
    } catch { /* Core content stays available when the optional campaign cannot be loaded. */ }
  }
  campaign();
  const contact = $('#contact-form');
  if (contact) contact.addEventListener('submit', async (event) => {
    event.preventDefault(); if (!contact.reportValidity()) return;
    const button = contact.querySelector('button[type=submit]'); const status = $('#contact-status');
    button.disabled=true; status.className='form-status'; status.textContent='Gemmer din besked…';
    try {
      const result = await api('/contact', Object.fromEntries(new FormData(contact)));
      status.textContent = result.notificationStatus === 'sent' ? 'Tak. Din besked er gemt og sendt til AJ Auto.' : result.notificationStatus === 'not_configured' ? 'Din besked er gemt, men AJ Auto kan endnu ikke modtage beskeder på e-mail. Ring på 60 64 41 43, hvis du ønsker kontakt nu.' : 'Din besked er gemt. Mailen til AJ Auto afventer afsendelse. Ring på 60 64 41 43, hvis det haster.';
      contact.reset();
    } catch (error) { status.classList.add('error'); status.textContent=error.message; }
    finally { button.disabled=false; }
  });
  let token = new URLSearchParams(location.hash.slice(1)).get('token') || new URLSearchParams(location.search).get('token');
  if (token && location.search.includes('token=')) history.replaceState(null, '', location.pathname+'#token='+encodeURIComponent(token));
  let bookingRoot = $('#booking-root');
  let manageRoot = $('#manage-root');
  if (bookingRoot && token) { manageRoot=bookingRoot; bookingRoot=null; const steps=$('.booking-steps'); if (steps) steps.hidden=true; }
  const summary = b => '<dl class="booking-summary"><div><dt>Ydelse</dt><dd>'+esc(b.serviceName || b.service?.name)+'</dd></div><div><dt>Tidspunkt</dt><dd>'+esc(dateText(b.startAt))+'<br>kl. '+esc(timeText(b.startAt))+' (dansk tid)</dd></div><div><dt>Kalender</dt><dd>'+esc(b.staffName)+'</dd></div><div><dt>Navn</dt><dd>'+esc(b.name)+'</dd></div><div><dt>E-mail</dt><dd>'+esc(b.email)+'</dd></div><div><dt>Telefon</dt><dd>'+esc(b.phone)+'</dd></div>'+(b.registration?'<div><dt>Nummerplade</dt><dd>'+esc(b.registration)+'</dd></div>':'')+(b.note?'<div><dt>Bemærkning</dt><dd>'+esc(b.note)+'</dd></div>':'')+'</dl>';
  const empty = '<div class="empty-state"><h2>Vi finder en tid<br>sammen.</h2><p>Onlinebooking åbner snart. Ring til os på 60 64 41 43, så aftaler vi en tid til din bil.</p><a class="button" href="tel:+4560644143">Ring til AJ Auto</a></div>';
  if (bookingRoot) {
    const state = {step:0,service:null,slot:null,date:today,details:{},slots:[]};
    let cfg;
    function step(n) {
      state.step=n;
      document.querySelectorAll('.booking-steps li').forEach((node,index) => { if(index===n) node.setAttribute('aria-current','step'); else node.removeAttribute('aria-current'); });
    }
    function chooseService() {
      step(0);
      bookingRoot.innerHTML='<h2>Hvad kan vi hjælpe med?</h2><p class="booking-context">Vælg den ydelse, du vil bestille.</p>'+cfg.services.filter(s=>s.active && s.durationMinutes).map(s=>'<button type="button" class="choice" data-service="'+s.id+'"><span><strong>'+esc(s.name)+'</strong><small>'+esc(s.description)+'</small><small>'+s.durationMinutes+' min. · Pris aftales med værkstedet</small></span></button>').join('');
      bookingRoot.querySelectorAll('[data-service]').forEach(button=>button.onclick=()=>{state.service=cfg.services.find(s=>String(s.id)===button.dataset.service);state.slot=null;chooseTime();});
    }
    async function chooseTime() {
      step(1);
      bookingRoot.innerHTML='<h2>Find din tid</h2><p class="booking-context">'+esc(state.service.name)+' · '+state.service.durationMinutes+' min.</p><div class="form-grid"><label>Dato<input id="booking-date" type="date" min="'+today+'" max="'+maxDate+'" value="'+state.date+'" required></label><label>Kalender<select id="booking-staff"><option value="">Første ledige</option>'+cfg.staff.map(s=>'<option value="'+s.id+'">'+esc(s.name)+'</option>').join('')+'</select></label></div><div id="slot-results" aria-live="polite"></div><div class="booking-controls"><button class="back-button" id="back-service" type="button">Tilbage til ydelser</button><button class="button" id="next-details" type="button" disabled>Fortsæt</button></div>';
      $('#back-service').onclick=chooseService;
      $('#next-details').onclick=details;
      let requestNumber=0;
      async function slots() {
        const seq=++requestNumber;
        const result=$('#slot-results'); const date=$('#booking-date').value;
        state.slot=null; $('#next-details').disabled=true;
        if (!date || !$('#booking-date').checkValidity()) {result.innerHTML='<p class="form-status">Vælg en dato inden for de næste 90 dage.</p>';return;}
        state.date=date; result.innerHTML='<p class="loading">Henter ledige tider…</p>';
        try {
          const data=await api('/slots?serviceId='+state.service.id+'&date='+date+'&staffId='+$('#booking-staff').value);
          if (seq!==requestNumber || state.step!==1) return;
          state.slots=data.slots;
          result.innerHTML=data.slots.length?'<p class="fineprint">'+esc(dateText(date+'T12:00:00Z'))+' · dansk tid</p><div class="slots">'+data.slots.map((s,i)=>'<button class="slot" type="button" data-slot="'+i+'" aria-pressed="false">'+esc(timeText(s.startAt))+'<small>'+esc(s.staffName)+'</small></button>').join('')+'</div>':'<p class="form-status">Der er ingen ledige tider på denne dato. Prøv en anden dag, eller ring til os.</p>';
          result.querySelectorAll('[data-slot]').forEach(button=>button.onclick=()=>{state.slot=state.slots[Number(button.dataset.slot)];result.querySelectorAll('[data-slot]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});$('#next-details').disabled=false;});
        } catch(error){if(seq===requestNumber) result.innerHTML='<p class="form-status error" role="alert">'+esc(error.message)+'</p>';}
      }
      $('#booking-date').onchange=slots; $('#booking-staff').onchange=slots; await slots();
    }
    function details() {
      if(!state.slot)return;
      step(2); const v=k=>esc(state.details[k] || '');
      bookingRoot.innerHTML='<h2>Lidt om dig og din bil</h2><p class="booking-context">'+esc(state.service.name)+' · '+esc(dateText(state.slot.startAt))+' kl. '+esc(timeText(state.slot.startAt))+'</p><form id="details-form"><label>Fulde navn<input name="name" autocomplete="name" required maxlength="100" value="'+v('name')+'"></label><div class="form-grid"><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254" value="'+v('email')+'"></label><label>Telefon<input name="phone" type="tel" autocomplete="tel" required maxlength="30" minlength="6" value="'+v('phone')+'"></label></div><label>Nummerplade <span class="fineprint">Valgfrit</span><input name="registration" maxlength="15" value="'+v('registration')+'"></label><label>Kort bemærkning <span class="fineprint">Valgfrit. Undlad følsomme oplysninger.</span><textarea name="note" rows="3" maxlength="1000">'+v('note')+'</textarea></label><p class="fineprint">Vi bruger dine oplysninger til at administrere din aftale. <a href="/kontakt#personoplysninger" target="_blank" rel="noopener">Om personoplysninger</a>.</p><div class="booking-controls"><button class="back-button" type="button" id="back-time">Tilbage til tidspunkt</button><button class="button" type="submit">Gennemse</button></div></form>';
      $('#back-time').onclick=()=>{state.details=Object.fromEntries(new FormData($('#details-form')));chooseTime();};
      $('#details-form').onsubmit=e=>{e.preventDefault();state.details=Object.fromEntries(new FormData(e.currentTarget));review();};
    }
    function review() {
      step(3);
      const b={...state.details,...state.slot,serviceName:state.service.name};
      bookingRoot.innerHTML='<h2>Ser det rigtigt ud?</h2><p class="booking-context">Din tid bliver først bestilt, når du bekræfter nedenfor.</p>'+summary(b)+'<p class="fineprint">Prisen aftales med AJ Auto. Du får et personligt link til at flytte eller aflyse.</p><div class="form-status" role="status"></div><div class="booking-controls"><button class="back-button" type="button" id="back-details">Ret oplysninger</button><button class="button" type="button" id="confirm-booking">Bekræft booking</button></div>';
      $('#back-details').onclick=details;
      $('#confirm-booking').onclick=async()=>{
        const button=$('#confirm-booking'); const back=$('#back-details');button.disabled=true;back.disabled=true;
        try {
          const result=await api('/bookings',{...state.details,serviceId:state.service.id,staffId:state.slot.staffId,startAt:state.slot.startAt});
          bookingRoot.innerHTML='<div class="success-mark" aria-hidden="true">✓</div><h2>Din tid er booket.</h2><p class="booking-context">Vi ses hos AJ Auto på Sorøvej 5kl, Slagelse.</p>'+summary(result.booking || b)+'<p class="form-status">'+(result.notificationStatus==='sent'?'Bekræftelsen er sendt på e-mail til dig og værkstedet.':'Din booking er gemt. Bekræftelsesmailen afventer afsendelse. Gem dit personlige link nedenfor.')+'</p>'+(result.manageUrl?'<a class="saved-link" href="'+esc(result.manageUrl)+'">Se, flyt eller aflys din aftale</a>':'')+'<p class="fineprint">Dit link er personligt. Del det ikke med andre.</p>';
        } catch(error){errorIn(bookingRoot,error.message);button.disabled=false;back.disabled=false;}
      };
    }
    config().then(data=>{cfg=data;if(!data.bookingReady) bookingRoot.innerHTML=empty;else chooseService();}).catch(error=>{bookingRoot.innerHTML='<h2>Vi kunne ikke hente tiderne</h2><p class="form-status error">'+esc(error.message)+'</p><a class="text-link" href="tel:+4560644143">Ring til os</a>';});
  }
  if (manageRoot) {
    let current;
    async function show(message) {
      if(!token){manageRoot.innerHTML='<h2>Åbn dit personlige link</h2><p>Brug linket i din bookingbekræftelse for at se din aftale. Har du brug for hjælp, så ring på <a href="tel:+4560644143">60 64 41 43</a>.</p>';return;}
      try {
        current=await api('/manage', undefined, token); const b=current.booking;
        manageRoot.innerHTML='<h2>'+(b.status==='cancelled'?'Din aftale er aflyst.':'Din aftale hos AJ Auto')+'</h2>'+(message?'<p class="form-status">'+esc(message)+'</p>':'')+summary(b)+(b.status==='confirmed'?'<div class="manage-actions"><button type="button" class="button" id="move-booking">Flyt aftalen</button><button type="button" class="button button-secondary danger" id="cancel-booking">Aflys aftalen</button></div>':'<a class="button" href="/booking">Book en ny tid</a>');
        if(b.status==='confirmed') {$('#move-booking').onclick=move;$('#cancel-booking').onclick=cancel;}
      } catch(error){manageRoot.innerHTML='<h2>Linket kunne ikke åbnes</h2><p class="form-status error">'+esc(error.message)+'</p><a class="text-link" href="tel:+4560644143">Ring på 60 64 41 43</a>';}
    }
    function cancel() {
      manageRoot.innerHTML='<h2>Vil du aflyse din aftale?</h2><p>'+esc(dateText(current.booking.startAt))+' kl. '+esc(timeText(current.booking.startAt))+'. Tiden bliver ledig for andre.</p><div class="form-status"></div><div class="manage-actions"><button class="button button-secondary" id="keep-booking" type="button">Behold aftalen</button><button class="button" id="confirm-cancel" type="button">Ja, aflys aftalen</button></div>';
      $('#keep-booking').onclick=()=>show();
      $('#confirm-cancel').onclick=async()=>{const button=$('#confirm-cancel');button.disabled=true;try{const r=await api('/manage/cancel',{token});await show(r.notificationStatus==='sent'?'Aflysningen er gemt. Du og værkstedet har fået besked på mail.':'Aflysningen er gemt. Mailen afventer afsendelse.');}catch(error){errorIn(manageRoot,error.message);button.disabled=false;}};
    }
    function move() {
      let chosen=null;let requestNumber=0;
      manageRoot.innerHTML='<h2>Vælg et nyt tidspunkt</h2><p class="booking-context">Din nuværende tid bevares, indtil flytningen er gemt.</p><label>Ny dato<input type="date" id="move-date" min="'+today+'" max="'+maxDate+'" value="'+today+'"></label><div id="move-slots" aria-live="polite"></div><div class="form-status"></div><div class="booking-controls"><button class="back-button" id="back-manage" type="button">Tilbage til aftalen</button><button class="button" id="confirm-move" type="button" disabled>Bekræft flytning</button></div>';
      $('#back-manage').onclick=()=>show();
      async function getSlots(){const date=$('#move-date').value;const seq=++requestNumber;chosen=null;$('#confirm-move').disabled=true;if(!date||!$('#move-date').checkValidity())return;$('#move-slots').innerHTML='<p class="loading">Henter tider…</p>';try{const data=await api('/slots?serviceId='+current.booking.serviceId+'&date='+date, undefined, token);if(seq!==requestNumber||!$('#move-slots'))return;$('#move-slots').innerHTML=data.slots.length?'<div class="slots">'+data.slots.map((s,i)=>'<button type="button" class="slot" data-move="'+i+'" aria-pressed="false">'+esc(timeText(s.startAt))+'<small>'+esc(s.staffName)+'</small></button>').join('')+'</div>':'<p class="form-status">Ingen ledige tider. Vælg en anden dato.</p>';manageRoot.querySelectorAll('[data-move]').forEach(button=>button.onclick=()=>{chosen=data.slots[Number(button.dataset.move)];manageRoot.querySelectorAll('[data-move]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});$('#confirm-move').disabled=false;});}catch(error){errorIn(manageRoot,error.message);}}
      $('#move-date').onchange=getSlots;getSlots();
      $('#confirm-move').onclick=async()=>{if(!chosen)return;const button=$('#confirm-move');button.disabled=true;try{const r=await api('/manage/reschedule',{token,startAt:chosen.startAt,staffId:chosen.staffId});await show(r.notificationStatus==='sent'?'Din aftale er flyttet. Du og værkstedet har fået besked på mail.':'Din aftale er flyttet og gemt. Mailen afventer afsendelse.');}catch(error){errorIn(manageRoot,error.message);button.disabled=false;}};
    }
    show();
  }
})();`;
