import { html, raw } from 'hono/html';
import { bookingTimingNote } from '../aj/types';
import type { CalendarAppointment, CalendarData } from '../lib/booking-calendar';
import type { H } from './layout';

const dateFormat = new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const monthFormat = new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit' });
const weekdays = ['Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag', 'Søndag'];
const dayLabel = (day: string) => dateFormat.format(new Date(`${day}T12:00:00Z`));
function calendarUrl(month: string, day?: string, staff?: number | null, anchor = false): string {
  const params = new URLSearchParams({ month });
  if (day) params.set('day', day);
  if (staff) params.set('staff', String(staff));
  return `/konto/kalender?${params}${anchor ? '#kalender-dag' : ''}`;
}
const calendarCss = `
.booking-calendar{--cal-line:#d8d5cd;--cal-soft:#ebe8df}.calendar-heading{display:flex;justify-content:space-between;gap:24px;align-items:start;margin-bottom:26px}.calendar-heading p{margin:8px 0 0}.calendar-timezone{color:var(--muted);font-size:12px;white-space:nowrap}.calendar-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:22px 0 18px}.calendar-month-title{margin:0;text-transform:capitalize;font-size:25px}.calendar-month-links{display:flex;gap:8px;flex-wrap:wrap}.calendar-controls{display:flex;align-items:end;gap:12px;flex-wrap:wrap;margin-bottom:22px}.calendar-controls .field{flex:1;min-width:150px;margin:0}.calendar-controls input[type=month]{width:100%;min-height:46px;padding:11px 14px;font:inherit;background:white;color:var(--ink);border:1px solid var(--line-strong);border-radius:var(--r-btn)}.calendar-grid-wrap{border:1px solid var(--cal-line);border-radius:14px;overflow:hidden;background:var(--surface)}.calendar-month{width:100%;border-collapse:collapse;table-layout:fixed;font-size:14px}.calendar-month th{padding:12px 4px;border-bottom:1px solid var(--cal-line);text-align:center;font-size:12px;font-weight:600;color:var(--muted)}.calendar-month abbr{text-decoration:none}.calendar-month td{padding:0;border-right:1px solid var(--cal-line);border-bottom:1px solid var(--cal-line);height:87px;vertical-align:top}.calendar-month tr:last-child td{border-bottom:0}.calendar-month td:last-child{border-right:0}.calendar-day-link{display:flex;flex-direction:column;justify-content:space-between;align-items:start;gap:8px;padding:11px;min-height:87px;text-decoration:none;position:relative}.calendar-day-link:hover{background:var(--cal-soft)}.calendar-day-link.is-other{background:#f0eee8;color:#8b8881}.calendar-day-link.is-today time{font-weight:800;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:4px}.calendar-day-link.is-selected{background:#fff0e8;box-shadow:inset 0 0 0 2px var(--accent);color:var(--ink)}.calendar-day-count{font-size:11px;line-height:1.2;background:var(--ink);color:var(--surface);padding:4px 7px;border-radius:20px;white-space:nowrap}.calendar-count-word{font-weight:400}.calendar-summary{font-size:13px;color:var(--muted);margin:12px 0 0}.calendar-selected-day{margin-top:36px;scroll-margin-top:24px}.calendar-selected-day>h2{text-transform:capitalize;font-size:24px}.calendar-appointments{list-style:none;padding:0;margin:18px 0 0}.calendar-appointment{display:grid;grid-template-columns:86px minmax(0,1fr) auto;gap:20px;border-top:1px solid var(--cal-line);padding:22px 0}.calendar-appointment:last-child{border-bottom:1px solid var(--cal-line)}.calendar-time{font-size:22px;font-weight:650;letter-spacing:-.025em;line-height:1.25}.calendar-time small{display:block;font-size:13px;font-weight:400;color:var(--muted);margin-top:6px}.calendar-appointment h3{font-size:18px;margin-bottom:6px}.calendar-appointment p{margin-bottom:7px}.calendar-client{font-size:14px;overflow-wrap:anywhere}.calendar-client a{display:inline-block}.calendar-appointment .badge{align-self:start}.calendar-note{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;color:var(--muted);margin-top:12px}.calendar-booking-id{font-size:11px;color:var(--muted);overflow-wrap:anywhere}.calendar-empty{padding:25px 0;color:var(--muted);border-top:1px solid var(--cal-line)}.calendar-setup{padding:20px 0 20px 20px;border-left:3px solid var(--accent);margin:24px 0}.calendar-setup p{max-width:65ch;margin-bottom:12px}.calendar-source{font-size:13px;color:var(--muted);margin-top:28px}.calendar-screenreader{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:600px){.calendar-heading{display:block}.calendar-timezone{display:block;margin-top:12px}.calendar-toolbar{align-items:start;flex-direction:column}.calendar-month-title{font-size:24px}.calendar-month-links{justify-content:space-between;width:100%;gap:6px}.calendar-month-links .btn{padding-inline:9px;font-size:12px}.calendar-month td,.calendar-day-link{height:61px;min-height:61px}.calendar-day-link{padding:7px;gap:6px}.calendar-day-count{font-size:10px;padding:3px 5px}.calendar-count-word{display:none}.calendar-month th{font-size:11px;padding:10px 0}.calendar-appointment{grid-template-columns:62px minmax(0,1fr);gap:14px}.calendar-appointment>.badge{grid-column:2;justify-self:start}.calendar-time{font-size:19px}.calendar-selected-day>h2{font-size:21px}.calendar-controls .field{min-width:140px}.calendar-controls>.btn{width:100%}.calendar-setup{padding-left:15px}.calendar-client a{max-width:100%}}
`;

function appointment(item: CalendarAppointment): H {
  const safePhone = item.phone.replace(/[^+\d]/g, '');
  return html`<li class="calendar-appointment" data-booking-id="${item.id}">
    <time class="calendar-time" datetime="${item.startAt}">${timeFormat.format(new Date(item.startAt))}<small><span class="calendar-screenreader">Forventet slut </span>ca. ${timeFormat.format(new Date(item.endAt))}</small></time>
    <div>
      <h3>${item.serviceName}</h3>
      <p><strong>${item.name}</strong><span class="muted"> · ${item.staffName}</span></p>
      <p class="calendar-client">${safePhone ? html`<a href="tel:${safePhone}">${item.phone}</a> · ` : ''}<a href="mailto:${encodeURIComponent(item.email)}">${item.email}</a></p>
      ${item.registration ? html`<p class="small">Nummerplade: ${item.registration}</p>` : ''}
      ${item.note ? html`<p class="calendar-note">${item.note}</p>` : ''}
      <p class="calendar-booking-id">Booking ${item.id}</p>
    </div>
    <span class="badge ${item.status === 'cancelled' ? 'b-neutral' : 'b-ok'}">${item.status === 'cancelled' ? 'Aflyst' : 'Bekræftet'}</span>
  </li>`;
}

export function bookingCalendarPage(data: CalendarData, options: { bookingReady: boolean; adminUrl: string }): H {
  const { selection, access, selectedStaff } = data;
  const monthTitle = monthFormat.format(new Date(`${selection.month}-15T12:00:00Z`));
  const weeks = Array.from({ length: 6 }, (_, i) => selection.days.slice(i * 7, i * 7 + 7));
  const total = Object.entries(data.counts).filter(([day]) => day.startsWith(selection.month)).reduce((sum, [, n]) => sum + n, 0);
  return html`${raw(`<style>${calendarCss}</style>`)}
<section class="booking-calendar" aria-labelledby="calendar-title">
  <header class="calendar-heading">
    <div><h1 id="calendar-title">Kalender</h1><p>${access.workspace.name} · ${access.role === 'owner' ? 'Alle dine medarbejderkalendere' : `Din kalender: ${access.staffName}`}</p></div>
    <span class="calendar-timezone">Dansk tid · Europe/Copenhagen</span>
  </header>
  ${access.role === 'owner' && !options.bookingReady ? html`<aside class="calendar-setup" aria-label="Åbn for onlinebooking"><p>Angiv den forventede varighed for dine ydelser og de tider, kunderne må booke.</p><a class="btn btn-primary" href="${options.adminUrl}" target="_blank" rel="noopener noreferrer">Indstil bookingtider</a></aside>` : ''}
  <form method="get" action="/konto/kalender" class="calendar-controls">
    <div class="field"><label for="calendar-month">Måned</label><input type="month" id="calendar-month" name="month" min="1900-01" max="2199-12" value="${selection.month}" required></div>
    ${access.role === 'owner' ? html`<div class="field"><label for="calendar-staff">Kalender</label><select id="calendar-staff" name="staff"><option value="">Alle medarbejdere</option>${data.members.map(member => html`<option value="${member.id}"${member.id === selectedStaff ? html` selected` : ''}>${member.name}${member.active ? '' : ' (inaktiv)'}</option>`)}</select></div>` : ''}
    <button class="btn btn-secondary" type="submit">Vis måned</button>
  </form>
  <div class="calendar-toolbar">
    <h2 class="calendar-month-title">${monthTitle}</h2>
    <nav class="calendar-month-links" aria-label="Skift måned">
      <a class="btn btn-secondary btn-small" href="${calendarUrl(selection.previousMonth, undefined, selectedStaff)}">Forrige måned</a>
      <a class="btn btn-secondary btn-small" href="${calendarUrl(selection.today.slice(0, 7), selection.today, selectedStaff)}">I dag</a>
      <a class="btn btn-secondary btn-small" href="${calendarUrl(selection.nextMonth, undefined, selectedStaff)}">Næste måned</a>
    </nav>
  </div>
  <div class="calendar-grid-wrap">
    <table class="calendar-month" aria-label="${monthTitle}">
      <thead><tr>${weekdays.map(label => html`<th scope="col"><abbr title="${label}">${label.slice(0, 3)}</abbr></th>`)}</tr></thead>
      <tbody>${weeks.map(week => html`<tr>${week.map(day => {
        const count = data.counts[day] || 0;
        const classes = ['calendar-day-link', day.slice(0, 7) !== selection.month ? 'is-other' : '', day === selection.today ? 'is-today' : '', day === selection.day ? 'is-selected' : ''].filter(Boolean).join(' ');
        return html`<td><a class="${classes}" data-calendar-day="${day}" href="${calendarUrl(day.slice(0, 7), day, selectedStaff, true)}" aria-label="${dayLabel(day)}: ${count} ${count === 1 ? 'aftale' : 'aftaler'}"${day === selection.day ? html` aria-current="date"` : ''}><time datetime="${day}">${Number(day.slice(-2))}</time>${count ? html`<span class="calendar-day-count">${count}<span class="calendar-count-word"> ${count === 1 ? 'aftale' : 'aftaler'}</span></span>` : ''}</a></td>`;
      })}</tr>`)}</tbody>
    </table>
  </div>
  <p class="calendar-summary">${total} ${total === 1 ? 'bekræftet aftale' : 'bekræftede aftaler'} i måneden. Vælg en dato for at se dagens aftaler.</p>
  <section class="calendar-selected-day" id="kalender-dag" aria-labelledby="calendar-day-title">
    <h2 id="calendar-day-title">${dayLabel(selection.day)}</h2>
    ${data.appointments.length ? html`<p class="calendar-summary">${bookingTimingNote}</p><ol class="calendar-appointments">${data.appointments.map(appointment)}</ol>` : html`<p class="calendar-empty" role="status">Ingen aftaler denne dag.</p>`}
    ${data.truncated ? html`<p class="alert alert-info">Dagen indeholder flere end 500 aftaler. De første 500 vises her. Vælg én medarbejderkalender for at begrænse oversigten.</p>` : ''}
  </section>
  <p class="calendar-source">Oversigten viser aftalerne fra ${access.workspace.name}s bookingsystem.${access.role === 'owner' ? html` <a href="${options.adminUrl}" target="_blank" rel="noopener noreferrer">Åbn bookingadministrationen</a> for at flytte eller aflyse aftaler.` : ' Du ser kun din egen kalender.'}</p>
</section>`;
}
