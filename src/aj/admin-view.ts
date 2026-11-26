import { bookingTimingNote } from './types';
import { carAdminCss, carAdminJs } from './car-admin-view';
import { calendarConnectionGuide, calendarConnectionGuideCss } from '../views/calendar-connection-guide';
/** AJ Auto's private workshop workspace. All customer data is loaded after authentication. */
export function adminPage() {
  return `<section class="aj-admin" aria-labelledby="admin-title">
    <div class="adm-top"><div><h1 id="admin-title">Værkstedets administration</h1><p class="adm-muted">Se aftaler, ret bookingtider og administrer biler til salg.</p></div><button class="adm-button adm-secondary" id="adm-logout" hidden>Log ud</button></div>
    <div id="adm-message" role="status" aria-live="polite" hidden></div>
    <section class="adm-login" id="adm-login"><h2>Log ind</h2><p>Få et login-link på den e-mail, der er tilknyttet din bruger.</p><form id="adm-login-form"><label>E-mail<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="Din e-mail"></label><button class="adm-button" type="submit">Send login-link</button><p class="adm-muted" id="adm-login-status" role="status"></p></form></section>
    <div id="adm-workspace" hidden><div class="adm-toolbar"><p id="adm-identity"></p><span class="adm-time-note">Dansk tid</span></div><div class="adm-layout"><button id="adm-nav-toggle" class="adm-nav-toggle adm-button adm-secondary" type="button" aria-expanded="false" aria-controls="adm-navigation">Vælg side</button><nav id="adm-navigation" class="adm-nav" aria-label="Administration"><button data-panel="appointments" aria-current="page">Aftaler</button><button data-panel="calendar">Kalender på mobilen</button><button data-panel="cars">Biler til salg</button><button data-panel="messages" data-owner>Beskeder</button><button data-panel="services" data-owner>Ydelser</button><button data-panel="hours">Bookingtider og pauser</button><button data-panel="staff" data-owner>Medarbejdere</button><button data-panel="settings" data-owner>Opsætning og kampagne</button></nav><div class="adm-content" id="adm-content" aria-live="polite"></div></div></div>
    <noscript>Slå JavaScript til for at bruge værkstedets administration.</noscript>
  </section>`;
}

export const adminCss = carAdminCss + calendarConnectionGuideCss + `
.aj-admin{max-width:1260px;margin:0 auto;padding:68px 28px 100px;color:#242229}.aj-admin .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.aj-admin [hidden]{display:none!important}.adm-top{display:flex;align-items:start;justify-content:space-between;gap:24px;margin-bottom:36px}.adm-top h1{font-size:clamp(32px,4vw,54px);line-height:1.08;letter-spacing:-.045em;max-width:760px;margin:10px 0 16px}.adm-eyebrow{font-size:12px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.adm-muted{color:#68646f;line-height:1.65}.adm-zone,.adm-badge{display:inline-block;border:1px solid #ded9e8;border-radius:30px;padding:5px 10px;font-size:12px;white-space:nowrap}.adm-badge.is-off{color:#735428;background:#fff5de;border-color:#ead8ae}.adm-login{max-width:490px;background:#fff;padding:32px;border:1px solid #ded9e8;border-radius:18px}.aj-admin h2{font-size:26px;letter-spacing:-.035em;line-height:1.2;margin:0 0 12px}.aj-admin h3{font-size:18px;margin:0 0 10px}.aj-admin p{margin-top:0}.aj-admin label{display:grid;gap:7px;font-size:13px;font-weight:650}.aj-admin input,.aj-admin select,.aj-admin textarea{font:inherit;color:#242229;border:1px solid #c8c0d7;background:#fff;border-radius:7px;padding:12px;width:100%;min-height:44px;box-sizing:border-box}.aj-admin textarea{min-height:100px;resize:vertical}.aj-admin input[type=checkbox]{width:18px;min-height:18px;accent-color:#392080}.aj-admin .adm-check{display:flex;align-items:start;gap:10px;line-height:1.5}.aj-admin button{font:inherit;cursor:pointer}.aj-admin button:disabled{opacity:.55;cursor:wait}.adm-button{display:inline-flex;align-items:center;justify-content:center;gap:24px;min-height:44px;border:1px solid #392080;border-radius:7px;background:#392080;color:white;font-weight:650;padding:11px 17px;text-decoration:none}.adm-button.adm-secondary{color:#392b55;background:transparent;border-color:#c8c0d7}.adm-button.adm-danger{background:#fff;color:#9b3029;border-color:#e2b9b3}.adm-button.adm-small{min-height:36px;padding:7px 12px;font-size:12px}.aj-admin :focus-visible{outline:3px solid #b8a5e6;outline-offset:3px}.adm-login form{display:grid;gap:18px;margin-top:24px}.adm-login .adm-button{justify-self:start}.adm-toolbar{display:flex;justify-content:space-between;align-items:center;border-top:1px solid #dcd6e6;padding:20px 0;gap:20px}.adm-toolbar p{margin:0;font-size:14px}.adm-layout{display:grid;grid-template-columns:218px minmax(0,1fr);gap:40px}.adm-nav{display:flex;flex-direction:column;gap:5px}.adm-nav button{text-align:left;border:0;background:transparent;color:#625b6e;padding:13px 15px;border-radius:7px;font-size:14px;line-height:1.3}.adm-nav button[aria-current=page]{background:#eee8f8;color:#392080;font-weight:700}.adm-nav button span{float:right}.adm-content{min-width:0}.adm-panel-head{display:flex;justify-content:space-between;align-items:start;gap:20px;margin:0 0 25px}.adm-panel-head p{margin-bottom:0;max-width:600px;font-size:14px}.adm-card{padding:24px;background:#fff;border:1px solid #ddd6e8;border-radius:12px;margin-bottom:16px}.adm-form{display:grid;gap:18px}.adm-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.adm-full{grid-column:1/-1}.adm-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.adm-divider{border:0;border-top:1px solid #e4deed;margin:10px 0}.adm-hint{font-size:12px;color:#6e647c;line-height:1.6;margin:0}.adm-notice,#adm-message{padding:15px 18px;border-radius:8px;background:#f2eef9;border:1px solid #d7cbea;line-height:1.6;font-size:14px;margin-bottom:20px}#adm-message.is-error{background:#fff3f1;border-color:#e3bcb7;color:#8c2d26}.adm-empty{padding:34px 20px;text-align:center;border:1px dashed #c8bcd9;border-radius:10px;color:#675d75;font-size:14px}.adm-table-wrap{overflow:auto;border:1px solid #ddd6e8;border-radius:10px;background:white;margin:18px 0}.adm-table{width:100%;border-collapse:collapse;font-size:13px}.adm-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:#f3eff8;color:#655975;padding:13px 16px}.adm-table td{vertical-align:top;padding:16px;border-top:1px solid #e7e0ef;line-height:1.5}.adm-table td small{display:block;color:#71677d;margin-top:3px}.adm-table a{color:#493084}.adm-table .adm-actions{min-width:105px}.adm-filters{display:flex;gap:15px;align-items:end;flex-wrap:wrap}.adm-filters label{flex:1;min-width:150px}.adm-filters .adm-button{align-self:end}.adm-cal{margin:24px 0;border:1px solid #ddd6e8;border-radius:10px;background:#fff;overflow:hidden}.adm-cal-head{display:flex;align-items:center;justify-content:space-between;padding:15px;border-bottom:1px solid #ddd6e8}.adm-cal-head strong{text-transform:capitalize}.adm-cal-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr))}.adm-cal-weekday{text-align:center;padding:11px 2px;color:#756b80;font-size:11px}.adm-cal-day{position:relative;border:0;border-top:1px solid #e6dfed;border-right:1px solid #e6dfed;background:#fff;min-height:57px;padding:10px;font-size:13px;text-align:left;color:#3b2b51}.adm-cal-day:nth-child(7n){border-right:0}.adm-cal-day.is-other{color:#a69aaf;background:#fbf9fd}.adm-cal-day[aria-pressed=true]{background:#ece3fa;box-shadow:inset 0 0 0 2px #6a4caa}.adm-cal-count{position:absolute;right:8px;bottom:8px;border-radius:100%;height:17px;min-width:17px;text-align:center;line-height:17px;font-size:10px;background:#392080;color:#fff}.adm-booking{display:grid;grid-template-columns:80px 1fr auto;gap:18px;border-top:1px solid #ded5e8;padding:23px 0}.adm-booking time{font-size:22px;letter-spacing:-.03em;font-weight:650}.adm-booking h3{margin-bottom:7px}.adm-booking p{font-size:13px;margin-bottom:5px;line-height:1.5}.adm-booking small{display:block;font-size:12px;color:#71677d;margin-top:5px}.adm-booking .adm-badge{align-self:start}.adm-note{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1edf7;padding:10px 12px;border-radius:6px}.adm-calendar-url{word-break:break-all;font-size:12px;background:#f3eff8;padding:15px;border-radius:8px;margin:15px 0}.adm-saved{color:#4a3473;font-size:13px}.adm-counter{font-size:48px;letter-spacing:-.06em;font-weight:650;line-height:1;margin:0 0 10px}.adm-narrow{min-width:0}.adm-wrap{overflow-wrap:anywhere}.adm-gap16{margin-top:16px}.adm-gap20{margin-top:20px}.adm-gap28{margin-top:28px}.adm-margin20{margin:20px 0}.adm-pad18{padding-top:18px}.adm-pad22{padding-top:22px}.adm-loading{padding:40px 0;color:#68646f}.adm-list-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:24px 0 12px}.adm-list-title h3{margin:0}.adm-error-summary{color:#8c2d26;line-height:1.6}.adm-inline-check{display:flex;gap:12px;align-items:center}.adm-select-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.adm-config-state{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:0 0 22px}
@media(max-width:800px){.aj-admin{padding:40px 20px 70px}.adm-layout{grid-template-columns:1fr;gap:25px}.adm-nav{flex-direction:row;overflow:auto;padding-bottom:10px}.adm-nav button{flex-shrink:0;white-space:nowrap}.adm-nav button span{display:none}.adm-top h1{font-size:38px}.adm-card{padding:20px}.adm-panel-head{display:block}.adm-panel-head>.adm-button{margin-top:15px}.adm-top{align-items:start}.adm-top>.adm-button{font-size:12px;white-space:nowrap;min-height:38px;padding:9px 12px}.adm-booking{grid-template-columns:65px 1fr}.adm-booking>.adm-badge{grid-column:2;justify-self:start}.adm-cal-day{min-height:53px;padding:9px}.adm-cal-count{right:5px;bottom:5px}}
@media(max-width:480px){.adm-form-grid{grid-template-columns:1fr}.adm-login{padding:23px}.adm-top{flex-wrap:wrap}.adm-top h1{font-size:34px}.adm-toolbar{align-items:start}.adm-zone{font-size:10px}.adm-table td,.adm-table th{padding:12px}.adm-cal-day{padding:8px;font-size:12px}.adm-cal-count{height:14px;min-width:14px;line-height:14px;font-size:9px}.adm-booking time{font-size:20px}.adm-booking{gap:12px}.adm-filters .adm-button{width:100%}}
.aj-admin{max-width:1240px;color:var(--ink,#1b1922);padding:64px 28px 96px}.adm-top h1{font-weight:750;letter-spacing:-.035em;line-height:1.12;margin:0 0 14px}.adm-time-note{font-size:13px;color:var(--muted,#615e69);white-space:nowrap}.adm-nav-toggle{display:none}.adm-login{border-radius:10px;padding:30px;background:#fff}.adm-card{border-radius:8px;border-color:#e2dee9;padding:26px}.adm-nav button{border-radius:5px;min-height:44px}.adm-empty{border:0;border-radius:0;text-align:left;padding:24px 0;color:#615e69}.adm-badge{border:0;border-radius:4px;background:#f0edf6;color:#4e465d}.adm-table th{text-transform:none;letter-spacing:0;font-size:13px}.adm-panel-head h2{font-weight:700}.adm-button{gap:12px}.adm-hint{font-size:13px;color:#61596d}.adm-counter{font-size:36px}.aj-admin input,.aj-admin select,.aj-admin textarea{font-size:16px;line-height:1.5;border-radius:5px}.adm-calendar-url{border-radius:5px}.adm-table-wrap,.adm-cal{border-radius:6px}.adm-note{background:#f6f4f9;border-radius:4px}.adm-login-status:empty{display:none}.adm-top>.adm-button{flex-shrink:0}
@media(max-width:800px){.aj-admin{padding:38px 20px 64px}.adm-layout{gap:20px}.adm-nav-toggle{display:flex;justify-content:space-between;width:100%;text-align:left}.adm-nav{display:none;flex-direction:column;gap:3px;padding:0 0 16px;border-bottom:1px solid #e2dee9;overflow:visible}.adm-nav.is-open{display:flex}.adm-nav button{white-space:normal;padding:12px 14px}.adm-card{padding:22px}.adm-time-note{font-size:12px}.adm-toolbar{gap:12px}.adm-toolbar p{overflow-wrap:anywhere}.adm-top h1{font-size:clamp(30px,8vw,40px)}.adm-login{padding:24px}.adm-actions>.adm-button{min-height:44px}}

`;

export const adminJs = String.raw`
(() => {
    'use strict';
    const $ = (s, root = document) => root.querySelector(s);
    const menu = $('.menu-toggle'), navigation = $('#navigation'), mobile = matchMedia('(max-width:760px)');
    const adminMenu = $('#adm-nav-toggle'), adminNavigation = $('#adm-navigation'), adminMobile = matchMedia('(max-width:800px)');
    function closeMenu(toggle, nav, breakpoint, focus = false) {
        if (!toggle || !nav)
            return;
        toggle.setAttribute('aria-expanded', 'false');
        nav.classList.remove('is-open');
        if (breakpoint.matches)
            nav.setAttribute('aria-hidden', 'true');
        else
            nav.removeAttribute('aria-hidden');
        if (focus)
            toggle.focus();
    }
    [[menu, navigation, mobile], [adminMenu, adminNavigation, adminMobile]].forEach(([toggle, nav, breakpoint]) => {
        if (!toggle || !nav)
            return;
        closeMenu(toggle, nav, breakpoint);
        toggle.addEventListener('click', () => {
            if (toggle.getAttribute('aria-expanded') === 'true') {
                closeMenu(toggle, nav, breakpoint);
                return;
            }
            toggle.setAttribute('aria-expanded', 'true');
            nav.classList.add('is-open');
            nav.removeAttribute('aria-hidden');
            if (breakpoint.matches)
                nav.querySelector('a,button:not([hidden])')?.focus();
        });
        nav.addEventListener('click', event => { if (event.target.closest('a,button'))
            closeMenu(toggle, nav, breakpoint); });
        document.addEventListener('click', event => { if (!toggle.contains(event.target) && !nav.contains(event.target))
            closeMenu(toggle, nav, breakpoint); });
        breakpoint.addEventListener('change', () => closeMenu(toggle, nav, breakpoint));
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape')
            return;
        if (menu?.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeMenu(menu, navigation, mobile, true);
        }
        else if (adminMenu?.getAttribute('aria-expanded') === 'true') {
            event.preventDefault();
            closeMenu(adminMenu, adminNavigation, adminMobile, true);
        }
    });
    const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const message = (text, error = false) => { const el = $('#adm-message'); el.textContent = text; el.hidden = !text; el.classList.toggle('is-error', error); el.setAttribute('role', error ? 'alert' : 'status'); };
    let state = null;
    let panel = location.hash === '#kalender' ? 'calendar' : 'appointments';
    let selectedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    let calendarMonth = selectedDate.slice(0, 7);
    let staffFilter = '';
    let calendarStaffId = '';
    let calendarLink = null;
    const manualCalendarGuide = ${JSON.stringify(calendarConnectionGuide(false))};
    const icloudCalendarGuide = ${JSON.stringify(calendarConnectionGuide(true))};
    const owner = () => state && (state.user.role === 'owner' || state.user.role === 'operator');
    const asDate = v => new Date(typeof v === 'number' && v < 100000000000 ? v * 1000 : v);
    const tzDate = v => new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', day: 'numeric', month: 'long', year: 'numeric' }).format(asDate(v));
    const tzTime = v => new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' }).format(asDate(v));
    const isoDay = v => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(asDate(v));
    const weekdays = ['', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
    const head = (title, description = '') => '<div class="adm-panel-head"><div><h2>' + esc(title) + '</h2><p class="adm-muted">' + esc(description) + '</p></div></div>';
    const empty = text => '<div class="adm-empty">' + esc(text) + '</div>';
    const staffName = id => (state.staff.find(x => x.id === id) || {}).name || 'Kalender';
    const serviceName = id => (state.services.find(x => x.id === id) || {}).name || 'Ydelse';
    const staffOptions = (id = '', all = false) => (all ? '<option value="">Alle kalendere</option>' : '') + state.staff.map(x => '<option value="' + esc(x.id) + '"' + (x.id === id ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
    function copenhagenISO(local) {
        const value = String(local || '');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
            throw new Error('Vælg en gyldig dato og et tidspunkt.');
        const wall = Date.parse(value + ':00Z');
        const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        const candidates = [60, 120].map(offset => new Date(wall - offset * 60000)).filter(d => fmt.format(d).replace(' ', 'T') === value);
        if (candidates.length !== 1)
            throw new Error('Tidspunktet ligger i skiftet mellem sommer- og vintertid. Vælg et andet tidspunkt.');
        return candidates[0].toISOString();
    }
    async function api(path, method = 'GET', body) {
        const response = await fetch('/api/admin/' + ({ state: 'data', config: 'settings' }[path] || path), { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        const data = await response.json().catch(() => ({ error: 'Serveren kunne ikke svare. Prøv igen.' }));
        if (!response.ok) {
            const error = new Error(data.error || data.message || 'Handlingen kunne ikke gennemføres.');
            error.status = response.status;
            throw error;
        }
        return data;
    }
    async function busy(form, fn) {
        const buttons = Array.from(form.querySelectorAll('button')).map(node => [node, node.disabled]);
        buttons.forEach(([node]) => node.disabled = true);
        form.setAttribute('aria-busy', 'true');
        message('');
        try {
            await fn();
        }
        catch (e) {
            if (e.status === 401)
                loginView();
            message(e.message, true);
        }
        finally {
            buttons.forEach(([node, disabled]) => { if (node.isConnected)
                node.disabled = disabled; });
            form.removeAttribute('aria-busy');
        }
    }
    async function refresh(success) {
        state = await api('state');
        const ready = state.readiness?.ready === true;
        document.body.dataset.bookingReady = String(ready);
        document.querySelectorAll('[data-booking-cta]').forEach(link => {
            link.href = ready ? '/booking' : 'tel:+4560644143';
            link.textContent = ready ? 'Book tid' : 'Ring og aftal en tid';
        });
        state.staff = (state.staff || []).map(x => ({ ...x, id: String(x.id) }));
        state.services = (state.services || []).map(x => ({ ...x, id: String(x.id), duration: x.durationMinutes }));
        state.hours = (state.hours || []).map(x => ({ ...x, staffId: String(x.staffId) }));
        state.blocks = (state.blocks || []).map(x => ({ ...x, staffId: String(x.staffId), start: x.startAt, end: x.endAt }));
        state.bookings = (state.bookings || []).map(x => ({ ...x, staffId: String(x.staffId), serviceId: String(x.serviceId), start: x.startAt, end: x.endAt, plate: x.registration }));
        state.config = state.settings || {};
        state.config.campaign = { ...(state.config.campaign || {}), price: (state.config.campaign?.priceOre || 90000) / 100, expiresAt: state.config.campaign?.expiresOn, text: state.config.campaign?.title };
        $('#adm-login').hidden = true;
        $('#adm-workspace').hidden = false;
        $('#adm-logout').hidden = false;
        $('#adm-identity').textContent = (state.user.name || state.user.email) + (state.user.role === 'operator' ? ' · Veyro-administration' : owner() ? ' · Ejer' : ' · Medarbejder');
        document.querySelectorAll('[data-owner]').forEach(el => el.hidden = !owner());
        if (!owner() && !['appointments', 'calendar', 'cars', 'hours'].includes(panel))
            panel = 'appointments';
        render();
        if (success)
            message(success);
    }
    function loginView() { $('#adm-login').hidden = false; $('#adm-workspace').hidden = true; $('#adm-logout').hidden = true; state = null; calendarStaffId = ''; calendarLink = null; }
    $('#adm-login-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { await api('login', 'POST', { email: new FormData(e.currentTarget).get('email') }); $('#adm-login-status').textContent = 'Hvis e-mailen er tilknyttet en bruger, modtager du et login-link. Tjek også uønsket post.'; }); });
    $('#adm-logout').addEventListener('click', e => busy(e.currentTarget.parentElement, async () => { await api('logout', 'POST', {}); location.assign('/admin'); }));
    document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => { panel = button.dataset.panel; message(''); render(); const heading = $('#adm-content h2'); if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
    } }));
    function render() {
        document.querySelectorAll('[data-panel]').forEach(x => x.dataset.panel === panel ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
        const content = $('#adm-content');
        if (panel === 'appointments')
            renderAppointments(content);
        if (panel === 'calendar')
            renderCalendar(content);
        if (panel === 'cars')
            renderCars(content);
        if (panel === 'messages')
            renderMessages(content);
        if (panel === 'services')
            renderServices(content);
        if (panel === 'hours')
            renderHours(content);
        if (panel === 'staff')
            renderStaff(content);
        if (panel === 'settings')
            renderSettings(content);
    }
    ${carAdminJs}
    function visibleBookings() { return state.bookings.filter(x => (!staffFilter || x.staffId === staffFilter)); }
    function renderAppointments(el) {
        const first = new Date(calendarMonth + '-01T12:00:00Z');
        const mondayOffset = (first.getUTCDay() + 6) % 7;
        const start = new Date(first);
        start.setUTCDate(1 - mondayOffset);
        const bookings = visibleBookings();
        let grid = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'].map(x => '<span class="adm-cal-weekday">' + x + '</span>').join('');
        for (let i = 0; i < 42; i++) {
            const day = new Date(start);
            day.setUTCDate(day.getUTCDate() + i);
            const d = day.toISOString().slice(0, 10);
            const count = bookings.filter(x => x.status !== 'cancelled' && isoDay(x.start) === d).length;
            grid += '<button class="adm-cal-day' + (d.slice(0, 7) !== calendarMonth ? ' is-other' : '') + '" data-day="' + d + '" aria-pressed="' + (d === selectedDate) + '" aria-label="' + esc(tzDate(day)) + ', ' + count + ' aftaler">' + day.getUTCDate() + (count ? '<span class="adm-cal-count">' + count + '</span>' : '') + '</button>';
        }
        const selected = bookings.filter(x => isoDay(x.start) === selectedDate).sort((a, b) => String(a.start).localeCompare(String(b.start)));
        el.innerHTML = head('Aftaler', 'Se aftaler i kalenderen. Vælg en dato for at se dagens besøg.') + '<div class="adm-filters"><label>Dato<input type="date" id="adm-date" value="' + selectedDate + '"></label>' + (owner() ? '<label>Kalender<select id="adm-staff-filter">' + staffOptions(staffFilter, true) + '</select></label>' : '') + '<button class="adm-button adm-secondary" id="adm-refresh">Opdatér</button></div><div class="adm-cal"><div class="adm-cal-head"><button class="adm-button adm-secondary adm-small" data-month="-1" aria-label="Forrige måned">←</button><strong>' + esc(new Intl.DateTimeFormat('da-DK', { month: 'long', year: 'numeric', timeZone: 'Europe/Copenhagen' }).format(first)) + '</strong><button class="adm-button adm-secondary adm-small" data-month="1" aria-label="Næste måned">→</button></div><div class="adm-cal-grid">' + grid + '</div></div><div class="adm-list-title"><h3>' + esc(tzDate(selectedDate + 'T12:00:00Z')) + '</h3><span class="adm-badge">' + selected.length + ' aftaler</span></div>' + (selected.length ? '<p class="fineprint">${bookingTimingNote}</p>' + selected.map(bookingHtml).join('') : empty('Ingen aftaler denne dag.'));
        $('#adm-date').addEventListener('change', e => { if (e.target.value) {
            selectedDate = e.target.value;
            calendarMonth = selectedDate.slice(0, 7);
            render();
        } });
        $('#adm-staff-filter')?.addEventListener('change', e => { staffFilter = e.target.value; render(); });
        $('#adm-refresh').addEventListener('click', e => busy(e.currentTarget.parentElement, () => refresh('Aftalerne er opdateret.')));
        el.querySelectorAll('[data-day]').forEach(x => x.addEventListener('click', () => { selectedDate = x.dataset.day; calendarMonth = selectedDate.slice(0, 7); render(); }));
        el.querySelectorAll('[data-month]').forEach(x => x.addEventListener('click', () => { first.setUTCMonth(first.getUTCMonth() + Number(x.dataset.month)); calendarMonth = first.toISOString().slice(0, 7); render(); }));
        el.querySelectorAll('[data-cancel-booking]').forEach(button => button.addEventListener('click', () => busy(button.parentElement, async () => { if (!confirm('Aflys aftalen? Kunden og værkstedet får besked på mail.'))
            return; await api('bookings/' + encodeURIComponent(button.dataset.cancelBooking) + '/cancel', 'POST', {}); await refresh('Aftalen er aflyst.'); })));
        el.querySelectorAll('[data-change-booking]').forEach(form => {
            const slotSelect = $('[name=slot]', form), save = $('[type=submit]', form), status = $('[data-slot-status]', form);
            const reset = () => { slotSelect.innerHTML = '<option value="">Hent ledige tider først</option>'; slotSelect.disabled = true; save.disabled = true; status.textContent = ''; };
            $('[name=date]', form).addEventListener('change', reset);
            $('[name=staffId]', form).addEventListener('change', reset);
            $('[data-load-slots]', form).addEventListener('click', () => busy(form, async () => {
                reset();
                const booking = state.bookings.find(x => String(x.id) === form.dataset.changeBooking);
                const date = $('[name=date]', form).value;
                if (!date)
                    throw new Error('Vælg en dato.');
                const params = new URLSearchParams({ serviceId: booking.serviceId, date, staffId: $('[name=staffId]', form).value, bookingId: String(booking.id) });
                const response = await fetch('/api/slots?' + params, { credentials: 'same-origin' });
                const data = await response.json();
                if (!response.ok)
                    throw new Error(data.error || 'Ledige tider kunne ikke hentes.');
                slotSelect.innerHTML = '<option value="">Vælg en ledig tid</option>' + (data.slots || []).map(s => '<option value="' + esc(s.startAt) + '">' + esc(tzTime(s.startAt)) + '</option>').join('');
                slotSelect.disabled = !data.slots?.length;
                save.disabled = !data.slots?.length;
                status.textContent = data.bookingReady === false ? 'Onlinebooking er lukket. Åbn booking under Opsætning, før en aftale flyttes.' : data.slots?.length ? '' : 'Ingen ledige tider denne dag. Vælg en anden dato.';
            }).then(() => { save.disabled = slotSelect.disabled || !slotSelect.value; }));
            slotSelect.addEventListener('change', () => { save.disabled = slotSelect.disabled || !slotSelect.value; });
            form.addEventListener('submit', e => { e.preventDefault(); busy(form, async () => { if (!slotSelect.value)
                throw new Error('Vælg en ledig tid.'); await api('bookings/' + encodeURIComponent(form.dataset.changeBooking) + '/reschedule', 'POST', { startAt: slotSelect.value, staffId: Number($('[name=staffId]', form).value) }); await refresh('Aftalen er flyttet.'); }); });
        });
    }
    function bookingHtml(b) {
        return '<article class="adm-booking"><time datetime="' + esc(b.start) + '">' + esc(tzTime(b.start)) + '<small><span class="sr-only">Forventet slut </span>ca. ' + esc(tzTime(b.end)) + '</small></time><div class="adm-narrow"><h3>' + esc(b.serviceName || serviceName(b.serviceId)) + '</h3><p><strong>' + esc(b.name) + '</strong> · ' + esc(staffName(b.staffId)) + '</p><p class="adm-wrap"><a href="tel:' + esc(String(b.phone || '').replace(/[^+\d]/g, '')) + '">' + esc(b.phone) + '</a> · <a href="mailto:' + esc(b.email) + '">' + esc(b.email) + '</a></p>' + (b.plate ? '<p>Nummerplade: ' + esc(b.plate) + '</p>' : '') + (b.note ? '<p class="adm-note">' + esc(b.note) + '</p>' : '') + (b.status === 'cancelled' ? '' : '<details class="adm-gap16"><summary>Flyt eller aflys</summary><form class="adm-form adm-pad18" data-change-booking="' + esc(b.id) + '"><label>Ny dato<input name="date" type="date" value="' + esc(isoDay(b.start)) + '" required></label><label>Kalender<select name="staffId">' + staffOptions(b.staffId) + '</select></label><button class="adm-button adm-secondary" type="button" data-load-slots>Hent ledige tider</button><label>Ledig tid<select name="slot" required disabled><option value="">Hent ledige tider først</option></select></label><p class="adm-hint" data-slot-status role="status"></p><div class="adm-actions"><button class="adm-button" type="submit" disabled>Gem ny tid</button><button class="adm-button adm-danger" type="button" data-cancel-booking="' + esc(b.id) + '">Aflys aftale</button></div></form></details>') + '</div><span class="adm-badge' + (b.status === 'cancelled' ? ' is-off' : '') + '">' + (b.status === 'cancelled' ? 'Aflyst' : 'Bekræftet') + '</span></article>';
    }
    function renderCalendar(el) {
        const activeStaff = state.staff.filter(person => person.active);
        const selected = activeStaff.find(person => person.id === calendarStaffId)
            || activeStaff.find(person => person.id === String(state.user.staffId))
            || activeStaff[0];
        const staffId = selected?.id || '';
        calendarStaffId = staffId;
        const url = calendarLink?.staffId === staffId ? calendarLink.url : '';
        const ownPrivateCalendar = ['owner', 'staff'].includes(state.user.role) && staffId === String(state.user.staffId);
        const selector = owner() && selected
            ? '<label>Kalender<select id="adm-calendar-staff">' + activeStaff.map(person =>
                '<option value="' + esc(person.id) + '"' + (person.id === staffId ? ' selected' : '') + '>' + esc(person.name) + '</option>').join('') + '</select></label>'
            : '';
        const linkActions = url
            ? '<div class="adm-calendar-url" id="adm-calendar-url">' + esc(url) + '</div><div class="adm-actions"><a class="adm-button" href="' + esc(url.replace(/^https?:/, 'webcal:')) + '">Åbn i kalenderapp</a><button class="adm-button adm-secondary" id="adm-copy-calendar">Kopiér link</button></div>'
            : '';
        const rotate = selected
            ? '<button class="adm-button adm-secondary" id="adm-rotate-calendar">' + (selected.hasCalendarLink ? 'Opret ny kobling' : 'Opret kalenderkobling') + '</button>'
            : '<p>Du skal have en aktiv medarbejderkalender for at oprette et link.</p>';
        el.innerHTML = head('Kalender på mobilen') + '<section class="adm-card"><h3>Dit personlige kalenderlink</h3>' + selector + linkActions
            + (selected?.hasCalendarLink ? '<p class="adm-hint">Hvis du opretter en ny kobling, skal du tilføje det nye link i din kalenderapp igen.</p>' : '')
            + rotate + '</section><div id="adm-calendar-guide">' + manualCalendarGuide + '</div>'
            + (ownPrivateCalendar ? '<section class="adm-card" id="adm-private-calendar" aria-labelledby="adm-private-title" hidden><h3 id="adm-private-title">Blokér tider fra din iCloud-kalender</h3><div id="adm-private-controls" aria-label="Din iCloud-forbindelse" role="region"></div></section>' : '');
        if (ownPrivateCalendar) loadIcloud($('#adm-private-controls', el));

        $('#adm-calendar-staff')?.addEventListener('change', e => {
            calendarStaffId = e.target.value;
            calendarLink = null;
            message('');
            render();
        });
        $('#adm-rotate-calendar')?.addEventListener('click', e => busy(e.currentTarget.parentElement, async () => {
            if (selected.hasCalendarLink && !confirm('Vil du erstatte kalenderkoblingen? Det tidligere link holder op med at virke.')) return;
            const data = await api('calendar', 'POST', { staffId: Number(staffId) });
            selected.hasCalendarLink = true;
            if (calendarStaffId === staffId) {
                calendarLink = { staffId, url: data.url };
                if (panel === 'calendar') {
                    render();
                    message('Kalenderkoblingen er oprettet.');
                }
            }
        }));
        $('#adm-copy-calendar')?.addEventListener('click', e => busy(e.currentTarget.parentElement, async () => {
            try {
                await navigator.clipboard.writeText(url);
                message('Kalenderlinket er kopieret.');
            } catch {
                const range = document.createRange();
                range.selectNodeContents($('#adm-calendar-url'));
                const selection = window.getSelection();
                selection.removeAllRanges();
                selection.addRange(range);
                message('Linket er markeret. Vælg Kopiér på din enhed.');
            }
        }));
    }
    async function loadIcloud(box) {
        const section = box.closest('#adm-private-calendar');
        const guide = $('#adm-calendar-guide', section.parentElement);
        try {
            const status = await api('icloud');
            if (!box.isConnected) return;
            const enabled = status.configured === true;
            section.hidden = !enabled && !status.connected;
            // The default instructions work while status loads, including on a slow mobile connection.
            if (enabled !== (guide.dataset.icloud === 'true')) {
                const open = [...guide.querySelectorAll('details')].map(details => details.open);
                const focused = [...guide.querySelectorAll('summary')].indexOf(document.activeElement);
                guide.innerHTML = enabled ? icloudCalendarGuide : manualCalendarGuide;
                guide.dataset.icloud = String(enabled);
                guide.querySelectorAll('details').forEach((details, i) => { if (i < open.length) details.open = open[i]; });
                if (focused !== -1) guide.querySelectorAll('summary')[focused]?.focus();
            }
            box.replaceChildren();
            if (!status.connected) {
                if (!enabled) return;
                box.insertAdjacentHTML('beforeend', '<form class="adm-form" method="post" autocomplete="off" data-icloud-connect><p class="adm-hint">Opret en app-specifik adgangskode til Veyro Booking på din Apple-konto. Det kræver tofaktorgodkendelse. <a href="https://support.apple.com/da-dk/102654" target="_blank" rel="noopener noreferrer">Se Apples vejledning</a>.</p><label>E-mail til din Apple-konto<input type="email" name="appleEmail" required maxlength="254" inputmode="email" autocomplete="off" spellcheck="false" autocapitalize="none"></label><label>App-specifik adgangskode fra Apple<input type="password" name="appPassword" required pattern="[a-z]{4}(-[a-z]{4}){3}" maxlength="19" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="icloud-password-hint"></label><p class="adm-hint" id="icloud-password-hint">Brug de fire grupper med fire små bogstaver og bindestreger, som Apple viser. Indtast aldrig din almindelige Apple-adgangskode. Du kan tilbagekalde app-koden hos Apple.</p><div><button class="adm-button" type="submit">Forbind min iCloud-kalender</button></div></form>');
                $('[data-icloud-connect]', box).onsubmit = event => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    const input = form.elements.appPassword;
                    const email = form.elements.appleEmail.value.trim();
                    if (!/^[a-z]{4}(?:-[a-z]{4}){3}$/.test(input.value)) {
                        input.value = '';
                        message('Brug kun den app-specifikke adgangskode, som Apple har genereret.', true);
                        return;
                    }
                    busy(box, async () => {
                        const payload = {email, appPassword: input.value};
                        input.value = '';
                        try {
                            const request = api('icloud/connect', 'POST', payload);
                            delete payload.appPassword;
                            await request;
                        } catch (e) {
                            if (e.status === 401) throw e;
                            throw new Error('Kalenderen kunne ikke forbindes. Kontrollér e-mailen og den app-specifikke adgangskode fra Apple, og prøv igen.');
                        }
                        if (box.isConnected) { render(); message('Din iCloud-konto er forbundet. Vælg de kalendere, der skal blokere tider.'); }
                    });
                };
                return;
            }
            box.insertAdjacentHTML('beforeend', '<p class="adm-notice" data-icloud-summary></p><div data-icloud-list></div><div class="adm-actions adm-gap20"><button type="button" class="adm-button adm-secondary" data-icloud-disconnect>Frakobl iCloud</button></div>');
            $('[data-icloud-summary]', box).textContent = status.state === 'reconnect' ? 'Din iCloud-forbindelse skal fornys. Frakobl kontoen, og forbind den igen.' : (status.selected ? 'Forbundet. Bookingen bruger optaget-tider fra de valgte kalendere.' : 'Forbundet. Vælg mindst én kalender for at bruge dine optaget-tider.');
            $('[data-icloud-disconnect]', box).onclick = () => {
                if (!confirm('Frakobl din iCloud-kalender? Dine private aftaler vil ikke længere blokere nye bookinger.')) return;
                busy(box, async () => {
                    await api('icloud/disconnect', 'POST', {});
                    if (box.isConnected) { render(); message('Din iCloud-kalender er frakoblet.'); }
                });
            };
            if (!enabled) {
                $('[data-icloud-summary]', box).textContent = 'iCloud-forbindelsen er sat på pause. Du kan frakoble kontoen her.';
                return;
            }
            if (status.state === 'reconnect') return;
            const list = $('[data-icloud-list]', box);
            try {
                const {calendars} = await api('icloud/calendars');
                if (!list.isConnected) return;
                if (!Array.isArray(calendars) || !calendars.length) {
                    list.textContent = 'Der blev ikke fundet nogen iCloud-kalendere på kontoen.';
                    return;
                }
                list.innerHTML = '<form class="adm-form"><fieldset class="adm-form"><legend>Vælg op til otte kalendere, der skal blokere tider</legend>' + calendars.map(cal => '<label class="adm-check"><input type="checkbox" name="calendar" value="' + esc(cal.id) + '"' + (cal.selected ? ' checked' : '') + '> ' + esc(cal.name) + '</label>').join('') + '</fieldset><div><button class="adm-button" type="submit">Gem kalendervalg</button></div></form>';
                $('form', list).onsubmit = event => {
                    event.preventDefault();
                    const ids = new FormData(event.currentTarget).getAll('calendar');
                    if (!ids.length) { message('Vælg mindst én kalender, eller brug Frakobl iCloud.', true); return; }
                    if (ids.length > 8) { message('Vælg højst otte kalendere.', true); return; }
                    busy(box, async () => {
                        await api('icloud/select', 'POST', {calendarIds: ids});
                        if (box.isConnected) { render(); message('Dine valgte kalendere er gemt.'); }
                    });
                };
            } catch (e) {
                if (e.status === 401) throw e;
                if (list.isConnected) showIcloudRetry(list, box, 'Dine kalendere kunne ikke hentes.');
            }
        } catch (e) {
            if (!box.isConnected) return;
            if (e.status === 401) { loginView(); return; }
            if (!section.hidden) showIcloudRetry(box, box, 'Din kalenderforbindelse kunne ikke hentes.');
        }
    }
    function showIcloudRetry(target, box, reason) {
        target.replaceChildren();
        const note = document.createElement('p');
        note.className = 'adm-hint'; note.setAttribute('role', 'alert'); note.textContent = reason;
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'adm-button adm-secondary adm-gap16'; retry.textContent = 'Prøv igen';
        retry.onclick = () => { if (box.isConnected) loadIcloud(box); };
        target.append(note, retry);
    }
    function renderServices(el) {
        el.innerHTML = head('Ydelser', 'Kalenderen reserverer den forventede varighed for hver aktiv ydelse.') + state.services.map(s => serviceForm(s)).join('') + '<details class="adm-card"><summary>Tilføj en ydelse</summary><div class="adm-pad22">' + serviceForm({}, true) + '</div></details>';
        el.querySelectorAll('[data-service-form]').forEach(form => form.addEventListener('submit', e => { e.preventDefault(); busy(form, async () => { const f = new FormData(form); await api('services', 'POST', { id: f.get('id') ? Number(f.get('id')) : undefined, name: f.get('name'), description: f.get('description'), durationMinutes: f.get('duration') ? Number(f.get('duration')) : null, active: f.has('active') }); await refresh('Ydelsen er gemt.'); }); }));
    }
    function serviceForm(s, inner = false) {
        return '<form class="adm-form ' + (inner ? '' : 'adm-card') + '" data-service-form><input type="hidden" name="id" value="' + esc(s.id || '') + '"><div class="adm-form-grid"><label>Navn på ydelse<input name="name" value="' + esc(s.name || '') + '" maxlength="100" required></label><label>Forventet varighed i minutter<input name="duration" type="number" min="15" max="480" step="5" value="' + esc(s.duration || '') + '" placeholder="Fx 60"></label><label class="adm-full">Kort beskrivelse<textarea name="description" maxlength="1000">' + esc(s.description || '') + '</textarea></label></div><label class="adm-check"><input name="active" type="checkbox" ' + (s.active ? 'checked' : '') + '>Ydelsen er bekræftet og må bookes online</label><div class="adm-actions"><button class="adm-button" type="submit">Gem ydelse</button><span class="adm-badge' + (s.active ? '' : ' is-off') + '">' + (s.active ? 'Aktiv' : 'Ikke bookbar') + '</span></div></form>';
    }
    function renderHours(el) {
        el.innerHTML = head('Bookingtider og pauser', 'Ledige tider beregnes ud fra hver kalender, ydelsens forventede varighed, aftaler og blokerede tider.')
            + (owner() ? '<div class="adm-card"><h3>Ugentlige bookingtider</h3><p class="adm-hint">Tilføj kun bekræftede intervaller. Du kan oprette flere intervaller samme dag, fx før og efter frokost.</p>' + hoursTable() + '<form id="adm-hours-form" class="adm-form"><div class="adm-form-grid"><label>Medarbejder<select name="staffId" required>' + staffOptions() + '</select></label><label>Ugedag<select name="weekday">' + [1, 2, 3, 4, 5, 6, 7].map(d => '<option value="' + d + '">' + weekdays[d] + '</option>').join('') + '</select></label><label>Fra<input name="startTime" type="time" step="300" required></label><label>Til<input name="endTime" type="time" step="300" required></label></div><div class="adm-actions"><button class="adm-button" type="submit">Tilføj interval</button></div></form></div>' : '')
            + '<div class="adm-card"><h3>Blokeret tid</h3><p class="adm-hint">Brug til ferie, fridage og andre perioder, hvor en kalender ikke må bookes. Tidspunkterne er dansk tid.</p>' + blocksTable() + '<form id="adm-block-form" class="adm-form"><div class="adm-form-grid"><label>Medarbejder<select name="staffId" required>' + staffOptions() + '</select></label><label>Intern bemærkning<input name="reason" maxlength="200" placeholder="Fx ferie"></label><label>Fra<input name="start" type="datetime-local" step="300" required></label><label>Til<input name="end" type="datetime-local" step="300" required></label></div><div class="adm-actions"><button class="adm-button" type="submit">Blokér tid</button></div></form></div>';
        $('#adm-hours-form')?.addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { const f = new FormData(e.currentTarget); await api('hours', 'POST', { staffId: Number(f.get('staffId')), weekday: Number(f.get('weekday')), startTime: f.get('startTime'), endTime: f.get('endTime') }); await refresh('Bookingintervallet er gemt.'); }); });
        $('#adm-block-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { const f = new FormData(e.currentTarget); await api('blocks', 'POST', { staffId: Number(f.get('staffId')), startAt: copenhagenISO(f.get('start')), endAt: copenhagenISO(f.get('end')), reason: f.get('reason') }); await refresh('Tiden er blokeret.'); }); });
        el.querySelectorAll('[data-delete-hour]').forEach(button => button.addEventListener('click', () => busy(button.parentElement, async () => { await api('hours', 'POST', { id: Number(button.dataset.deleteHour), delete: true }); await refresh('Intervallet er fjernet.'); })));
        el.querySelectorAll('[data-delete-block]').forEach(button => button.addEventListener('click', () => busy(button.parentElement, async () => { await api('blocks', 'POST', { id: Number(button.dataset.deleteBlock), delete: true }); await refresh('Blokeringen er fjernet.'); })));
    }
    function hoursTable() { return state.hours.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Kalender</th><th>Ugedag</th><th>Tidsrum</th><th><span class="sr-only">Handling</span></th></tr></thead><tbody>' + state.hours.map(h => '<tr><td>' + esc(staffName(h.staffId)) + '</td><td>' + esc(weekdays[h.weekday]) + '</td><td>' + esc(h.startTime) + '–' + esc(h.endTime) + '</td><td><button type="button" class="adm-button adm-secondary adm-small" data-delete-hour="' + esc(h.id) + '">Fjern</button></td></tr>').join('') + '</tbody></table></div>' : empty('Ingen bookingtider endnu. Tilføj de bekræftede tider nedenfor.'); }
    function blocksTable() { return state.blocks.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Kalender</th><th>Periode</th><th><span class="sr-only">Handling</span></th></tr></thead><tbody>' + state.blocks.map(b => '<tr><td>' + esc(staffName(b.staffId)) + '<small>' + esc(b.reason) + '</small></td><td>' + esc(tzDate(b.start)) + ' ' + esc(tzTime(b.start)) + '<small>Til ' + esc(tzDate(b.end)) + ' ' + esc(tzTime(b.end)) + '</small></td><td><button type="button" class="adm-button adm-secondary adm-small" data-delete-block="' + esc(b.id) + '">Fjern</button></td></tr>').join('') + '</tbody></table></div>' : empty('Ingen blokerede tider.'); }
    function renderStaff(el) {
        el.innerHTML = head('Medarbejdere', 'Hver medarbejder har sin egen kalender. Tilføj en e-mailadresse for at give adgang til login.') + '<p class="adm-badge">' + state.staff.filter(s => s.active).length + ' af 3 aktive personer</p>' + state.staff.map(s => staffForm(s)).join('') + (state.staff.filter(s => s.active).length < 3 ? '<details class="adm-card"><summary>Tilføj medarbejder</summary><div class="adm-pad22">' + staffForm({}, true) + '</div></details>' : '<p class="adm-notice">Alle tre pladser er i brug. Deaktivér en bruger, før du tilføjer en ny.</p>');
        el.querySelectorAll('[data-staff-form]').forEach(form => form.addEventListener('submit', e => { e.preventDefault(); busy(form, async () => { const f = new FormData(form); await api('staff', 'POST', { id: f.get('id') ? Number(f.get('id')) : undefined, name: f.get('name'), email: f.get('email'), role: f.get('role') || 'staff', active: f.has('active') }); await refresh('Medarbejderen er gemt.'); }); }));
    }
    function staffForm(s, inner = false) { return '<form class="adm-form ' + (inner ? '' : 'adm-card') + '" data-staff-form><input name="id" type="hidden" value="' + esc(s.id || '') + '"><div class="adm-form-grid"><label>Navn<input name="name" value="' + esc(s.name || '') + '" maxlength="100" required></label><label>E-mail til login<input name="email" type="email" value="' + esc(s.email || '') + '" maxlength="254"' + (s.id && !s.email ? '' : ' required') + ' autocomplete="off"></label><label>Adgang<select name="role"><option value="staff"' + (s.role !== 'owner' ? ' selected' : '') + '>Medarbejder · egen kalender</option><option value="owner"' + (s.role === 'owner' ? ' selected' : '') + '>Ejer · alle aftaler og opsætning</option></select></label></div><label class="adm-check"><input name="active" type="checkbox" ' + (s.active ? 'checked' : '') + '>Aktiv bruger og kalender</label><p class="adm-hint">' + (s.role === 'owner' ? 'Ejeren kan administrere opsætningen og se alle aftaler.' : s.id && !s.email ? 'Kalenderen kan bookes. Tilføj medarbejderens e-mail, når der skal åbnes for login.' : 'Medarbejderen kan se egne aftaler og oprette sin egen kalenderkobling.') + '</p><div class="adm-actions"><button class="adm-button" type="submit">Gem medarbejder</button>' + (s.role === 'owner' ? '<span class="adm-badge">Ejer</span>' : '') + '</div></form>'; }
    function renderSettings(el) {
        const c = state.config;
        const campaign = c.campaign || {};
        el.innerHTML = head('Opsætning og kampagne', 'Bekræft værkstedets oplysninger, før onlinebooking eller en kampagne offentliggøres.') + (state.readiness?.missing?.length ? '<div class="adm-notice"><strong>Mangler før booking er klar</strong><ul>' + state.readiness.missing.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '') + (state.readiness?.warnings?.length ? '<p class="adm-notice">' + state.readiness.warnings.map(esc).join(' ') + '</p>' : '') + '<div class="adm-config-state"><span class="adm-badge' + (state.readiness?.ready ? '' : ' is-off') + '">' + (state.readiness?.ready ? 'Onlinebooking er klar' : c.bookingEnabled ? 'Aktiveret · afventer opsætning' : 'Onlinebooking er ikke aktiv') + '</span></div><form id="adm-settings-form" class="adm-form"><section class="adm-card adm-form"><h3>Booking og kontakt</h3><label>Værkstedets e-mail · kan tilføjes senere<input name="workshopEmail" type="email" value="' + esc(c.workshopEmail || '') + '" maxlength="254" placeholder="Bekræftet modtager til aftaler og kontaktformular"></label><p class="adm-hint">Modtager aftaler, ændringer, aflysninger og beskeder. Uden en modtager gemmes værkstedets mails til senere. Aftalerne er synlige her med det samme.</p><label class="adm-check"><input name="bookingEnabled" type="checkbox" ' + (c.bookingEnabled ? 'checked' : '') + '>Åbn for onlinebooking</label><p class="adm-hint">Kræver aktive medarbejdere, ydelser med varighed, bookingtider og mail til kundernes bekræftelser. Værkstedets modtager kan tilføjes senere.</p></section><section class="adm-card adm-form"><h3>Olieskift · kampagne</h3><p class="adm-muted">Det oprindelige opslag nævner 900 kr. inklusive motorolie og oliefilter. Prisen vises kun, når gyldigheden er bekræftet og udløbsdatoen ikke er passeret.</p><div class="adm-form-grid"><label>Kampagnepris i kr.<input name="campaignPrice" type="number" min="1" max="100000" step="0.01" value="' + esc(campaign.price || 900) + '"></label><label>Udløbsdato<input name="campaignExpires" type="date" value="' + esc(campaign.expiresAt || '') + '"></label><label class="adm-full">Kort kampagnetekst<textarea name="campaignText" maxlength="160">' + esc(campaign.text || 'Olieskift inklusive motorolie og oliefilter.') + '</textarea></label></div><label class="adm-check"><input name="campaignConfirmed" type="checkbox" ' + (campaign.confirmed ? 'checked' : '') + '>Kunden har bekræftet kampagnens pris, indhold og udløbsdato</label><label class="adm-check"><input name="campaignEnabled" type="checkbox" ' + (campaign.enabled ? 'checked' : '') + '>Vis kampagnen på hjemmesiden</label><p class="adm-hint">Kampagnen skjules automatisk efter udløbsdatoen. Bekræftelse alene aktiverer ikke kampagnen.</p></section><div class="adm-actions"><button class="adm-button" type="submit">Gem opsætning</button></div></form>' + mailStatusHtml();
        $('#adm-retry-mail')?.addEventListener('click', e => busy(e.currentTarget.parentElement, async () => { await api('retry-mail', 'POST', {}); await refresh('Vi har forsøgt at sende de ventende mails. Se status nedenfor.'); }));
        $('#adm-settings-form').addEventListener('submit', e => { e.preventDefault(); busy(e.currentTarget, async () => { const f = new FormData(e.currentTarget); await api('config', 'POST', { workshopEmail: f.get('workshopEmail'), bookingEnabled: f.has('bookingEnabled'), campaign: { priceOre: Math.round(Number(f.get('campaignPrice')) * 100), expiresOn: f.get('campaignExpires') || null, title: f.get('campaignText'), confirmed: f.has('campaignConfirmed'), enabled: f.has('campaignEnabled') } }); await refresh('Opsætningen er gemt.'); }); });
    }
    function mailStatusHtml() {
        const rows = state.outbox || [];
        const labels = { sent: 'Sendt', pending: 'Afventer', sending: 'Sender', failed: 'Kunne ikke sendes', not_configured: 'Mail er ikke tilkoblet' };
        const events = { created: 'Booking', rescheduled: 'Flytning', cancelled: 'Aflysning', contact: 'Kontaktformular' };
        return '<section class="adm-card adm-gap28"><div class="adm-panel-head"><div><h3>Levering af mails</h3><p class="adm-hint">En gemt aftale er stadig gemt, hvis en mail fejler. Her kan du se status og forsøge levering igen.</p></div><button id="adm-retry-mail" class="adm-button adm-secondary adm-small">Forsøg igen</button></div>' + (rows.length ? '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Hændelse</th><th>Modtager</th><th>Status</th></tr></thead><tbody>' + rows.slice(0, 30).map(m => '<tr><td>' + esc(events[m.event] || m.event) + (m.createdAt ? '<small>' + esc(tzDate(m.createdAt)) + ' ' + esc(tzTime(m.createdAt)) + '</small>' : '') + '</td><td>' + esc(m.recipientKind === 'customer' ? 'Kunde' : m.recipientKind === 'workshop' ? 'Værksted' : m.recipientKind) + '</td><td>' + esc(labels[m.status] || m.status) + (m.lastError ? '<small>' + esc(m.lastError) + '</small>' : '') + '</td></tr>').join('') + '</tbody></table></div>' : empty('Der er endnu ingen mails i oversigten.')) + '</section>';
    }
    function renderMessages(el) {
        const messages = state.messages || [];
        el.innerHTML = head('Beskeder fra hjemmesiden', 'Beskeder fra kontaktformularen er gemt her. Svar kunden via telefon eller e-mail.') + (messages.length ? messages.map(m => '<article class="adm-card"><h3>' + esc(m.name) + '</h3><p><a href="mailto:' + esc(m.email) + '">' + esc(m.email) + '</a>' + (m.phone ? ' · <a href="tel:' + esc(String(m.phone).replace(/[^+\d]/g, '')) + '">' + esc(m.phone) + '</a>' : '') + '</p><p class="adm-note">' + esc(m.message || m.body) + '</p>' + (m.createdAt ? '<p class="adm-hint">' + esc(tzDate(m.createdAt)) + ' ' + esc(tzTime(m.createdAt)) + '</p>' : '') + '</article>').join('') : empty('Ingen beskeder endnu.'));
    }
    function prepareLogin() {
        const fragment = new URLSearchParams(location.hash.slice(1));
        const loginToken = fragment.get('token') || new URLSearchParams(location.search).get('token');
        if (location.hash === '#kalender' || fragment.get('panel') === 'kalender') panel = 'calendar';
        if (loginToken) {
            history.replaceState(null, '', location.pathname);
            loginView();
            $('#adm-login').innerHTML = '<h2>Bekræft dit login</h2><p>Fortsæt for at åbne AJ Autos administration med det sikre link fra din mail.</p><button id="adm-verify" class="adm-button">Log ind på værkstedet</button><p class="adm-gap20"><a href="/admin">Send et nyt login-link</a></p>';
            $('#adm-verify').addEventListener('click', e => busy(e.currentTarget.parentElement, async () => { await api('verify', 'POST', { token: loginToken }); await refresh(); }));
        }
        else
            api('session').then(session => session.authenticated ? refresh() : loginView()).catch(error => {
                loginView();
                message(error.message, true);
            });
    }
    window.addEventListener('hashchange', prepareLogin);
    prepareLogin();
})();
`;
