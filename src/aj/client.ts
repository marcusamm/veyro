import { bookingTimingNote } from './types';

export const js = String.raw`
(() => {
    'use strict';
    const $ = (selector, root = document) => root.querySelector(selector);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const phoneLink = '<a class="button" href="tel:+4560644143">Ring og aftal en tid</a>';
    const day = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    const today = day(new Date());
    const maxDate = day(new Date(Date.now() + 89 * 86400000));
    const dateText = value => new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value));
    const timeText = value => new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    let bookingReady = document.body.dataset.bookingReady === 'true';
    function availability(ready) {
        bookingReady = ready === true;
        document.body.dataset.bookingReady = String(bookingReady);
        document.querySelectorAll('[data-booking-cta]').forEach(link => {
            link.href = bookingReady ? '/booking' : 'tel:+4560644143';
            link.textContent = bookingReady ? 'Book tid' : 'Ring og aftal en tid';
        });
        document.querySelectorAll('[data-booking-phone]').forEach(node => {
            const replacement = document.createElement(bookingReady ? 'a' : 'span');
            replacement.setAttribute('data-booking-phone', '');
            replacement.className = bookingReady ? 'phone-link' : 'action-phone';
            replacement.textContent = bookingReady ? 'Ring 60 64 41 43' : '60 64 41 43';
            if (bookingReady)
                replacement.href = 'tel:+4560644143';
            node.replaceWith(replacement);
        });
    }
    async function api(path, data, privateToken) {
        let response;
        try {
            response = await fetch('/api' + path, { method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(privateToken ? { 'X-AJ-Token': privateToken } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        }
        catch {
            const error = new Error('Vi kunne ikke få forbindelse. Prøv igen, eller ring på 60 64 41 43.');
            error.status = 0;
            throw error;
        }
        let value;
        try {
            value = await response.json();
        }
        catch {
            const error = new Error('Vi kunne ikke læse svaret. Prøv igen, eller ring på 60 64 41 43.');
            error.status = response.status;
            error.uncertain = true;
            throw error;
        }
        if (!response.ok) {
            const error = new Error(value.error || value.message || 'Det lykkedes ikke. Prøv igen.');
            error.status = response.status;
            throw error;
        }
        return value;
    }
    function focusHeading(root) { const node = $('h2', root) || root; node.setAttribute('tabindex', '-1'); node.focus({ preventScroll: false }); }
    function status(root, text, error = false, focus = false) {
        let node = $('.form-status', root);
        if (!node) {
            node = document.createElement('p');
            root.prepend(node);
        }
        node.className = 'form-status' + (error ? ' error' : '');
        node.setAttribute('role', error ? 'alert' : 'status');
        node.textContent = text;
        if (focus) {
            node.setAttribute('tabindex', '-1');
            node.focus();
        }
        return node;
    }
    function lock(root) {
        const controls = Array.from(root.querySelectorAll('button,input,select,textarea')).map(node => [node, node.disabled]);
        controls.forEach(([node]) => node.disabled = true);
        root.setAttribute('aria-busy', 'true');
        return () => { controls.forEach(([node, disabled]) => { if (node.isConnected)
            node.disabled = disabled; }); root.removeAttribute('aria-busy'); };
    }
    function steps(visible, index) {
        const list = $('.booking-steps');
        if (!list)
            return;
        list.hidden = !visible;
        list.querySelectorAll('li').forEach((node, i) => { if (i === index)
            node.setAttribute('aria-current', 'step');
        else
            node.removeAttribute('aria-current'); });
    }
    function pageTitle(title) {
        const heading = $('[data-booking-title]');
        if (heading) heading.textContent = title;
        const meta = $('.booking-meta');
        if (meta) meta.hidden = title === 'Din aftale';
    }
    const menu = $('.menu-toggle'), navigation = $('#navigation'), mobile = window.matchMedia('(max-width:760px)');
    function closeMenu(returnFocus = false) {
        if (!menu || !navigation)
            return;
        menu.setAttribute('aria-expanded', 'false');
        menu.setAttribute('aria-label', 'Åbn menu');
        navigation.classList.remove('is-open');
        if (mobile.matches)
            navigation.setAttribute('aria-hidden', 'true');
        else
            navigation.removeAttribute('aria-hidden');
        if (returnFocus)
            menu.focus();
    }
    if (menu && navigation) {
        closeMenu();
        menu.addEventListener('click', () => {
            if (menu.getAttribute('aria-expanded') === 'true') {
                closeMenu();
                return;
            }
            menu.setAttribute('aria-expanded', 'true');
            menu.setAttribute('aria-label', 'Luk menu');
            navigation.classList.add('is-open');
            navigation.removeAttribute('aria-hidden');
            if (mobile.matches)
                navigation.querySelector('a')?.focus();
        });
        navigation.addEventListener('click', event => { if (event.target.closest('a'))
            closeMenu(); });
        document.addEventListener('click', event => { if (!menu.contains(event.target) && !navigation.contains(event.target))
            closeMenu(); });
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeMenu(true);
        } });
        mobile.addEventListener('change', () => closeMenu());
    }
    let configPromise;
    function config(refresh = false) {
        if (refresh || !configPromise)
            configPromise = api('/config').then(data => { availability(data.bookingReady); return data; }).catch(error => { configPromise = null; throw error; });
        return configPromise;
    }
    async function campaign() {
        const nodes = [$('#home-campaign'), $('#services-campaign')].filter(Boolean);
        try {
            const data = await config(), c = data.campaign;
            nodes.forEach(node => { node.hidden = true; node.replaceChildren(); });
            if (!c || !c.enabled || !c.confirmed || !c.expiresOn || c.expiresOn < today)
                return;
            const price = new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK', minimumFractionDigits: c.priceOre % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(c.priceOre / 100);
            nodes.forEach(node => {
                node.className = 'campaign';
                node.hidden = false;
                node.innerHTML = '<h2>' + esc(c.title) + '</h2><p class="campaign-price"><strong>' + esc(price) + '</strong></p><p>Gælder til ' + esc(dateText(c.expiresOn + 'T12:00:00Z')) + '. Ring, hvis du vil høre om tilbuddet til din bil.</p>';
            });
        }
        catch { /* The server-rendered contact and booking status remain usable. */ }
    }
    campaign();
    const contact = $('#contact-form');
    if (contact)
        contact.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!contact.reportValidity())
                return;
            const payload = Object.fromEntries(new FormData(contact)), release = lock(contact), node = $('#contact-status');
            node.className = 'form-status';
            node.setAttribute('role', 'status');
            node.textContent = 'Gemmer din besked…';
            try {
                const result = await api('/contact', payload);
                node.textContent = result.notificationStatus === 'sent' ? 'Tak for din besked. Den er sendt til AJ Auto.' : result.notificationStatus === 'not_configured' ? 'Beskeden er gemt. Vi kan ikke modtage den på mail endnu, så ring på 60 64 41 43 for at få fat i os.' : 'Beskeden er gemt og venter på at blive sendt. Ring på 60 64 41 43, hvis det haster.';
                contact.reset();
            }
            catch (error) {
                node.classList.add('error');
                node.setAttribute('role', 'alert');
                node.textContent = error.message;
            }
            finally {
                release();
            }
        });
    let token = new URLSearchParams(location.hash.slice(1)).get('token') || new URLSearchParams(location.search).get('token');
    if (token && location.search.includes('token='))
        history.replaceState(null, '', location.pathname + '#token=' + encodeURIComponent(token));
    let bookingRoot = $('#booking-root'), manageRoot = $('#manage-root');
    if (bookingRoot && token) {
        manageRoot = bookingRoot;
        bookingRoot = null;
        steps(false);
        pageTitle('Din aftale');
    }
    const timingNote = '<p class="fineprint">${bookingTimingNote}</p>';
    function summary(b) {
        const minutes = b.durationMinutes ?? (Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000;
        const rows = [
            ['Ydelse', b.serviceName || b.service?.name],
            ['Starttid', dateText(b.startAt) + ' kl. ' + timeText(b.startAt) + ' (dansk tid)'],
            ['Forventet varighed', Number.isFinite(minutes) && minutes > 0 ? minutes + ' minutter' : ''],
            ['Mekaniker', b.staffName],
            ['Navn', b.name],
            ['E-mail', b.email],
            ['Telefon', b.phone],
            ['Nummerplade', b.registration],
            ['Bemærkning', b.note],
        ];
        return '<dl class="booking-summary">' + rows.filter(([, value]) => value).map(([label, value]) =>
            '<div><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>'
        ).join('') + '</dl>' + (b.status === 'cancelled' ? '' : timingNote);
    }
    function mailStatus(value, action, notifications) {
        if (notifications) {
            if (notifications.customer === 'sent') return action + ' Bekræftelsen er sendt til din e-mail.';
            if (notifications.customer === 'not_configured') return action + ' Vi kan ikke sende dig en mail lige nu. Ring på 60 64 41 43, hvis du har spørgsmål.';
            return action + ' Bekræftelsesmailen venter på at blive sendt.';
        }
        if (value === 'sent')
            return action + ' Du og værkstedet har fået besked på mail.';
        if (value === 'not_configured')
            return action + ' Vi kan ikke sende mail lige nu. Ring på 60 64 41 43, hvis du har spørgsmål.';
        return action + ' Mailen venter på at blive sendt.';
    }
    const newAppointment = ready => ready ? '<a class="button" href="/booking">Book en ny tid</a>' : phoneLink;
    function closed(root, notice, focus = false) {
        availability(false);
        steps(false);
        pageTitle('Aftal en tid');
        root.innerHTML = '<div class="empty-state">' + (notice ? '<p class="form-status" role="status">' + esc(notice) + '</p>' : '') + '<p>Du kan ikke booke online lige nu. Ring på 60 64 41 43, så aftaler vi en tid til din bil.</p>' + phoneLink + '</div>';
        if (focus)
            focusHeading(root);
    }
    if (bookingRoot) {
        const state = { step: 0, service: null, slot: null, date: today, staffId: '', details: {}, slots: [] };
        let cfg, viewVersion = 0;
        function render(html, n, focus = true) {
            state.step = n;
            viewVersion++;
            steps(true, n);
            pageTitle('Book tid');
            bookingRoot.innerHTML = html;
            if (focus) focusHeading(bookingRoot);
            return viewVersion;
        }
        function chooseService(focus = true) {
            const available = cfg.services.filter(s => s.active && s.durationMinutes);
            if (!cfg.bookingReady || !available.length) {
                closed(bookingRoot, null, focus);
                return;
            }
            const choices = available.map(service =>
                '<button type="button" class="choice" data-service="' + service.id + '"><span class="choice-heading"><strong>' + esc(service.name) + '</strong><span>Ca. ' + service.durationMinutes + ' minutter</span></span>' +
                (service.description ? '<small>' + esc(service.description) + '</small>' : '') + '</button>'
            ).join('');
            const byAgreement = '<section class="booking-by-agreement"><h3>Diverse efter aftale</h3><p><a href="tel:+4560644143">Ring på 60 64 41 43</a> eller <a href="/kontakt#skriv">skriv til os</a>, så aftaler vi opgaven og tidspunktet.</p></section>';
            render('<h2>Vælg ydelse</h2>' + timingNote + '<div class="service-choices">' + choices + '</div>' + byAgreement, 0, focus);
            bookingRoot.querySelectorAll('[data-service]').forEach(button => button.addEventListener('click', () => { state.service = available.find(s => String(s.id) === button.dataset.service); state.slot = null; chooseTime(); }));
        }
        async function chooseTime(notice, focus = true) {
            if (!state.service) {
                chooseService();
                return;
            }
            const view = render('<h2>Vælg en ledig tid</h2><p class="booking-context">' + esc(state.service.name) + ' · ca. ' + state.service.durationMinutes + ' minutter</p>' + timingNote + (notice ? '<p class="form-status" role="status">' + esc(notice) + '</p>' : '') + '<div class="form-grid"><label>Dato<input id="booking-date" type="date" min="' + today + '" max="' + maxDate + '" value="' + state.date + '" required></label><label>Mekaniker<select id="booking-staff"><option value="">Alle mekanikere</option>' + cfg.staff.map(s => '<option value="' + s.id + '"' + (String(s.id) === state.staffId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select></label></div><div id="slot-results" aria-live="polite" aria-atomic="true"></div><div class="booking-controls"><button class="back-button" id="back-service" type="button">Tilbage</button><button class="button" id="next-details" type="button" disabled>Fortsæt</button></div>', 1, focus);
            $('#back-service').onclick = () => chooseService();
            $('#next-details').onclick = details;
            let requestNumber = 0;
            async function slots() {
                const seq = ++requestNumber, result = $('#slot-results'), date = $('#booking-date').value;
                state.slot = null;
                $('#next-details').disabled = true;
                state.staffId = $('#booking-staff').value;
                if (!date || !$('#booking-date').checkValidity()) {
                    result.innerHTML = '<p class="form-status">Vælg en dato inden for de næste 90 dage.</p>';
                    return;
                }
                state.date = date;
                result.innerHTML = '<p class="loading">Henter ledige tider…</p>';
                result.setAttribute('aria-busy', 'true');
                try {
                    const data = await api('/slots?' + new URLSearchParams({ serviceId: String(state.service.id), date, staffId: state.staffId }));
                    if (seq !== requestNumber || view !== viewVersion)
                        return;
                    availability(data.bookingReady);
                    if (!data.bookingReady) {
                        cfg.bookingReady = false;
                        closed(bookingRoot, 'Kalenderen er lukket for nye bookinger.', true);
                        return;
                    }
                    state.slots = data.slots || [];
                    result.innerHTML = state.slots.length ? '<p class="fineprint">' + esc(dateText(date + 'T12:00:00Z')) + ' · dansk tid</p><div class="slots">' + state.slots.map((s, i) => '<button class="slot" type="button" data-slot="' + i + '" aria-pressed="false">' + esc(timeText(s.startAt)) + '<small>' + esc(s.staffName) + '</small></button>').join('') + '</div>' : '<p class="form-status">Der er ingen ledige tider denne dag. Vælg en anden dato, eller <a href="tel:+4560644143">ring på 60 64 41 43</a>.</p>';
                    result.querySelectorAll('[data-slot]').forEach(button => button.onclick = () => { state.slot = state.slots[Number(button.dataset.slot)]; result.querySelectorAll('[data-slot]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); $('#next-details').disabled = false; });
                }
                catch (error) {
                    if (seq === requestNumber && view === viewVersion)
                        result.innerHTML = '<p class="form-status error" role="alert">' + esc(error.message) + '</p><button class="back-button" type="button" id="retry-slots">Prøv igen</button>';
                    const retry = $('#retry-slots');
                    if (retry)
                        retry.onclick = slots;
                }
                finally {
                    result.removeAttribute('aria-busy');
                }
            }
            $('#booking-date').onchange = slots;
            $('#booking-staff').onchange = slots;
            await slots();
        }
        function details() {
            if (!state.slot) {
                chooseTime();
                return;
            }
            const v = key => esc(state.details[key] || '');
            render('<h2>Dine oplysninger</h2><p class="booking-context">' + esc(state.service.name) + ' · ' + esc(dateText(state.slot.startAt)) + ' kl. ' + esc(timeText(state.slot.startAt)) + '</p><form id="details-form"><label>Navn<input name="name" autocomplete="name" required maxlength="100" value="' + v('name') + '"></label><div class="form-grid"><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254" value="' + v('email') + '"></label><label>Telefon<input name="phone" type="tel" autocomplete="tel" required maxlength="30" minlength="6" value="' + v('phone') + '"></label></div><label>Nummerplade <span class="fineprint">Valgfrit</span><input name="registration" autocomplete="off" maxlength="15" value="' + v('registration') + '"></label><label>Bemærkning <span class="fineprint">Valgfrit. Undlad følsomme oplysninger.</span><textarea name="note" rows="3" maxlength="1000">' + v('note') + '</textarea></label><p class="fineprint">Vi bruger oplysningerne til din aftale. <a href="/kontakt#personoplysninger" target="_blank" rel="noopener">Læs om personoplysninger</a>.</p><div class="booking-controls"><button class="back-button" type="button" id="back-time">Tilbage</button><button class="button" type="submit">Gennemse aftalen</button></div></form>', 2);
            $('#back-time').onclick = () => { state.details = Object.fromEntries(new FormData($('#details-form'))); chooseTime(); };
            $('#details-form').onsubmit = event => { event.preventDefault(); if (!event.currentTarget.reportValidity())
                return; state.details = Object.fromEntries(new FormData(event.currentTarget)); review(); };
        }
        function review() {
            const b = { ...state.details, ...state.slot, serviceName: state.service.name, durationMinutes: state.service.durationMinutes };
            render('<h2>Din aftale</h2><p class="booking-context">Se oplysningerne igennem, før du bekræfter tiden.</p>' + summary(b) + '<p class="fineprint">Prisen aftales med AJ Auto. Du får et personligt link til at flytte eller aflyse.</p><p class="form-status" role="status"></p><div class="booking-controls"><button class="back-button" type="button" id="back-details">Ret oplysninger</button><button class="button" type="button" id="confirm-booking">Bekræft tid</button></div>', 3);
            $('#back-details').onclick = details;
            $('#confirm-booking').onclick = async () => {
                const release = lock(bookingRoot);
                status(bookingRoot, 'Gemmer din aftale…');
                try {
                    const result = await api('/bookings', { ...state.details, serviceId: state.service.id, staffId: state.slot.staffId, startAt: state.slot.startAt });
                    viewVersion++;
                    steps(false);
                    pageTitle('Din aftale');
                    bookingRoot.innerHTML = '<h2>Din tid er booket</h2><p>Vi ses på Sorøvej 5kl, Slagelse.</p>' + summary(result.booking || b) + '<p class="form-status" role="status">' + esc(mailStatus(result.notificationStatus, 'Aftalen er gemt.', result.notifications)) + '</p>' + (result.manageUrl ? '<a class="saved-link" href="' + esc(result.manageUrl) + '">Se, flyt eller aflys aftalen</a><p class="fineprint">Linket er personligt. Gem det, og del det ikke med andre.</p>' : '');
                    focusHeading(bookingRoot);
                }
                catch (error) {
                    if (error.status === 409) {
                        state.slot = null;
                        await chooseTime('Den valgte tid er ikke længere ledig. Vælg en ny tid.');
                    }
                    else if (error.status === 503) {
                        closed(bookingRoot, 'Du har ikke bestilt en tid. Ring, så hjælper vi dig videre.', true);
                    }
                    else
                        status(bookingRoot, error.status === 0 || error.uncertain ? 'Vi kunne ikke se, om aftalen blev gemt. Tjek din mail for en bekræftelse, før du prøver igen, eller ring på 60 64 41 43.' : error.message, true, true);
                }
                finally {
                    release();
                }
            };
        }
        async function start() {
            try {
                cfg = await config();
                if (cfg.bookingReady)
                    chooseService(false);
                else
                    closed(bookingRoot);
            }
            catch (error) {
                if (!bookingReady) {
                    closed(bookingRoot);
                    return;
                }
                bookingRoot.innerHTML = '<h2>Vi kunne ikke hente tiderne</h2><p class="form-status error" role="alert">' + esc(error.message) + '</p><div class="booking-controls"><button class="button" type="button" id="retry-booking">Prøv igen</button><a class="text-link" href="tel:+4560644143">Ring</a></div>';
                $('#retry-booking').onclick = start;
            }
        }
        start();
    }
    if (manageRoot) {
        let current, manageVersion = 0;
        function render(html, focus = false) { manageVersion++; manageRoot.innerHTML = html; if (focus)
            focusHeading(manageRoot); return manageVersion; }
        async function show(message, focus = false) {
            const requested = ++manageVersion;
            if (!token) {
                render('<h2>Brug linket fra din mail</h2><p>Åbn det personlige link i din bookingbekræftelse for at se aftalen. Du kan også <a href="tel:+4560644143">ringe på 60 64 41 43</a>.</p>', focus);
                return;
            }
            try {
                const data = await api('/manage', undefined, token);
                if (requested !== manageVersion)
                    return;
                current = data;
                availability(data.bookingReady);
                const b = data.booking, upcoming = b.status === 'confirmed' && Date.parse(b.startAt) > Date.now();
                pageTitle('Din aftale');
                render((b.status === 'cancelled' ? '<h2>Aftalen er aflyst</h2>' : '') + (message ? '<p class="form-status" role="status">' + esc(message) + '</p>' : '') + summary(b) + (upcoming ? (!data.bookingReady ? '<p>Ring på <a href="tel:+4560644143">60 64 41 43</a>, hvis du vil flytte tiden.</p>' : '') + '<div class="manage-actions">' + (data.bookingReady ? '<button type="button" class="button" id="move-booking">Flyt aftalen</button>' : '') + '<button type="button" class="button button-secondary danger" id="cancel-booking">Aflys aftalen</button></div>' : b.status === 'cancelled' ? '<div class="manage-actions">' + newAppointment(data.bookingReady) + '</div>' : '<p>Aftalen er begyndt eller afsluttet. <a href="tel:+4560644143">Ring</a>, hvis du har spørgsmål.</p>'), focus);
                if (upcoming) {
                    const moveButton = $('#move-booking');
                    if (moveButton)
                        moveButton.onclick = move;
                    $('#cancel-booking').onclick = cancel;
                }
            }
            catch (error) {
                if (requested !== manageVersion)
                    return;
                render('<h2>Vi kunne ikke åbne aftalen</h2><p class="form-status error" role="alert">' + esc(error.message) + '</p><a class="button" href="tel:+4560644143">Ring på 60 64 41 43</a>', focus);
            }
        }
        function cancel() {
            render('<h2>Vil du aflyse tiden?</h2><p>' + esc(current.booking.serviceName) + ' · ' + esc(dateText(current.booking.startAt)) + ' kl. ' + esc(timeText(current.booking.startAt)) + '.</p><p class="form-status" role="status"></p><div class="manage-actions"><button class="button button-secondary" id="keep-booking" type="button">Behold tiden</button><button class="button" id="confirm-cancel" type="button">Ja, aflys tiden</button></div>', true);
            $('#keep-booking').onclick = () => show(null, true);
            $('#confirm-cancel').onclick = async () => {
                const release = lock(manageRoot);
                status(manageRoot, 'Aflyser tiden…');
                try {
                    const result = await api('/manage/cancel', { token });
                    await show(mailStatus(result.notificationStatus, 'Aftalen er aflyst.', result.notifications), true);
                }
                catch (error) {
                    status(manageRoot, error.message, true, true);
                }
                finally {
                    release();
                }
            };
        }
        function move() {
            let chosen = null, requestNumber = 0;
            const view = render('<h2>Vælg en ledig tid</h2><p class="booking-context">Du beholder den nuværende tid, indtil den nye er gemt.</p>' + timingNote + '<label>Ny dato<input type="date" id="move-date" min="' + today + '" max="' + maxDate + '" value="' + today + '" required></label><div id="move-slots" aria-live="polite" aria-atomic="true"></div><p class="form-status" role="status"></p><div class="booking-controls"><button class="back-button" id="back-manage" type="button">Tilbage til aftalen</button><button class="button" id="confirm-move" type="button" disabled>Bekræft ny tid</button></div>', true);
            $('#back-manage').onclick = () => show(null, true);
            async function getSlots(notice) {
                const date = $('#move-date').value, seq = ++requestNumber, result = $('#move-slots');
                chosen = null;
                $('#confirm-move').disabled = true;
                if (!date || !$('#move-date').checkValidity()) {
                    result.innerHTML = '<p class="form-status">Vælg en dato inden for de næste 90 dage.</p>';
                    return;
                }
                result.innerHTML = '<p class="loading">Henter ledige tider…</p>';
                result.setAttribute('aria-busy', 'true');
                try {
                    const data = await api('/slots?' + new URLSearchParams({ serviceId: String(current.booking.serviceId), date }), undefined, token);
                    if (seq !== requestNumber || view !== manageVersion)
                        return;
                    availability(data.bookingReady);
                    if (!data.bookingReady) {
                        await show('Du kan ikke flytte tiden online lige nu. Ring på 60 64 41 43. Din aftale er uændret.', true);
                        return;
                    }
                    const slots = data.slots || [];
                    result.innerHTML = (notice ? '<p class="form-status" role="status">' + esc(notice) + '</p>' : '') + (slots.length ? '<div class="slots">' + slots.map((s, i) => '<button type="button" class="slot" data-move="' + i + '" aria-pressed="false">' + esc(timeText(s.startAt)) + '<small>' + esc(s.staffName) + '</small></button>').join('') + '</div>' : '<p class="form-status">Der er ingen ledige tider denne dag. Vælg en anden dato, eller <a href="tel:+4560644143">ring</a>.</p>');
                    result.querySelectorAll('[data-move]').forEach(button => button.onclick = () => { chosen = slots[Number(button.dataset.move)]; result.querySelectorAll('[data-move]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); }); $('#confirm-move').disabled = false; });
                }
                catch (error) {
                    if (seq === requestNumber && view === manageVersion) {
                        result.innerHTML = '<p class="form-status error" role="alert">' + esc(error.message) + '</p><button class="back-button" type="button" id="retry-move-slots">Prøv igen</button>';
                        $('#retry-move-slots').onclick = () => getSlots();
                    }
                }
                finally {
                    result.removeAttribute('aria-busy');
                }
            }
            $('#move-date').onchange = () => getSlots();
            getSlots();
            $('#confirm-move').onclick = async () => {
                if (!chosen)
                    return;
                const selected = chosen, release = lock(manageRoot);
                status(manageRoot, 'Gemmer den nye tid…');
                try {
                    const result = await api('/manage/reschedule', { token, startAt: selected.startAt, staffId: selected.staffId });
                    await show(mailStatus(result.notificationStatus, 'Aftalen er flyttet.', result.notifications), true);
                }
                catch (error) {
                    if (error.status === 409) {
                        release();
                        status(manageRoot, '');
                        await getSlots('Tiden er ikke længere ledig. Vælg en anden. Din nuværende aftale er uændret.');
                    }
                    else if (error.status === 503)
                        await show('Du kan ikke flytte tiden online lige nu. Ring på 60 64 41 43. Din aftale er uændret.', true);
                    else
                        status(manageRoot, error.message, true, true);
                }
                finally {
                    release();
                    if (view === manageVersion && $('#confirm-move'))
                        $('#confirm-move').disabled = !chosen;
                }
            };
        }
        show();
    }
})();
`;
