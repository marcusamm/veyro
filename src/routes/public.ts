import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { render } from '../render';
import { thanksPage } from '../views/pages';

const pub = new Hono<AppEnv>();

pub.get('/', (c) => c.redirect(c.get('session') ? '/konto' : '/login', 302));

// Pakkerne bestilles via veyro.dk (kontaktformularen og et personligt tilbud). Gamle links og
// formularer til /bestil (fra e-mails og bogmærker) sendes videre til prissiden.
const PRICES_URL = 'https://veyro.dk/pages/priser';
pub.get('/bestil', (c) => c.redirect(PRICES_URL, 302));
pub.post('/bestil', (c) => c.redirect(PRICES_URL, 303));

pub.get('/bestil/tak', (c) => render(c, 'Tak for din bestilling', thanksPage()));

export default pub;
