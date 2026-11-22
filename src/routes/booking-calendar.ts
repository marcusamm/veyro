import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { readiness } from '../aj/store';
import { bookingAdminUrl, CalendarInputError, calendarSelection, getBookingCalendarAccess, loadBookingCalendar } from '../lib/booking-calendar';
import { render } from '../render';
import { bookingCalendarPage } from '../views/booking-calendar';
import { errorPage } from '../views/pages';

const bookingCalendar = new Hono<AppEnv>();
bookingCalendar.get('/', async c => {
  c.header('Cache-Control', 'private, no-store');
  c.header('X-Robots-Tag', 'noindex, nofollow');
  const session = c.get('session');
  if (!session) return c.redirect('/login', 303);
  const access = await getBookingCalendarAccess(c.env.DB, session.email);
  if (!access) return render(c, 'Ingen kalenderadgang', errorPage('Du har ikke adgang til kalenderen', 'Kalenderen kræver en aktiv bookingaftale og adgang til virksomhedens bookingsystem.', { href: '/konto', label: 'Til dit overblik' }), { status: 403 });
  try {
    // An incoming tenant/customer selector never changes the trusted source mapping.
    if (c.req.query('workspace') && c.req.query('workspace') !== access.workspace.id) throw new CalendarInputError('Du har ikke adgang til denne kalender.', 403);
    const selection = calendarSelection({ month: c.req.query('month'), day: c.req.query('day') });
    const data = await loadBookingCalendar(c.env.DB, access, selection, c.req.query('staff'));
    const ready = await readiness(c.env);
    return render(c, 'Kalender', bookingCalendarPage(data, { bookingReady: ready.ready, adminUrl: bookingAdminUrl(c.env, new URL(c.req.url).origin) }), { nav: 'kalender', isCustomer: true });
  } catch (error) {
    if (error instanceof CalendarInputError) return render(c, 'Kalender', errorPage('Kalenderen kunne ikke vises', error.message, { href: '/konto/kalender', label: 'Til kalenderen' }), { status: error.status, nav: 'kalender', isCustomer: true });
    throw error;
  }
});
export default bookingCalendar;
