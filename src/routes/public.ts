import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { render } from '../render';
import { CONTACT_URL, thanksPage } from '../views/pages';

const pub = new Hono<AppEnv>();

pub.get('/', (c) => c.redirect(c.get('session') ? '/konto' : '/login', 302));

// Veyro har ingen faste planer; prisen er skræddersyet. Gamle links og formularer til /bestil
// (fra veyro.dk, e-mails og bogmærker) sendes videre til kontaktformularen.
pub.get('/bestil', (c) => c.redirect(CONTACT_URL, 302));
pub.post('/bestil', (c) => c.redirect(CONTACT_URL, 303));

pub.get('/bestil/tak', (c) => render(c, 'Tak for din bestilling', thanksPage()));

export default pub;
