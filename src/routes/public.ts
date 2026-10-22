import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { getPlan, isPlanKey, minMonths } from '../lib/plans';
import { render } from '../render';
import { contactUrlFor, flash, plansPage, thanksPage } from '../views/pages';

const pub = new Hono<AppEnv>();

pub.get('/', (c) => c.redirect(c.get('session') ? '/konto' : '/login', 302));

// ?plan=starter|business|premium (fra knapperne på veyro.dk) fremhæver den valgte plan.
pub.get('/bestil', (c) => {
  const plan = c.req.query('plan');
  return render(
    c,
    'Abonnementer',
    plansPage({
      minMonths: minMonths(c.env),
      loggedIn: !!c.get('session'),
      selected: isPlanKey(plan) ? plan : undefined,
      info: flash(c.req.query('besked')),
    }),
  );
});

// Selvbetjent Stripe Checkout er fjernet: abonnementer sælges via kontaktformularen og et personligt tilbud.
// Gamle formularer og bogmærker sendes videre til kontaktformularen med planen forvalgt.
pub.post('/bestil', async (c) => {
  const plan = getPlan((await c.req.parseBody())['plan'] as string | undefined);
  return c.redirect(plan ? contactUrlFor(plan) : '/bestil', 303);
});

pub.get('/bestil/tak', (c) => render(c, 'Tak for din bestilling', thanksPage()));

export default pub;
