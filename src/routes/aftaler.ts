// "Aftaler og dokumenter" i kundeportalen: fælles indgang til fuldmagter (og fortrolighedsaftaler).
import { Hono, type Context } from 'hono';
import type { AppEnv, CustomerRow, Env } from '../env';
import { getCustomerByEmail } from '../lib/db';
import { canIssue, getSettings, listForCustomer } from '../lib/poa';
import { customerHasNdas, listForCustomer as listNdas, listRequests as listNdaRequests } from '../lib/nda';
import { render } from '../render';
import { agreementsPage } from '../views/aftaler';
import { poaPolicyPage } from '../views/poa';

type Vars = AppEnv & { Variables: AppEnv['Variables'] & { customer: CustomerRow } };
const aftaler = new Hono<Vars>();

/** Vis menupunktet, når kunden må oprette fuldmagter eller allerede har nogen. */
export async function agreementsAccess(env: Env, email: string): Promise<boolean> {
  try {
    const settings = await getSettings(env.DB);
    if (canIssue(settings, email)) return true;
    const customer = await getCustomerByEmail(env.DB, email);
    if (!customer) return false;
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM poas WHERE customer_id = ?').bind(customer.id).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) return true;
    return await customerHasNdas(env.DB, customer.id);
  } catch {
    // Før migrationen er kørt findes tabellerne ikke; så vises menupunktet bare ikke.
    return false;
  }
}

aftaler.get('/', async (c) => {
  const customer = c.get('customer');
  const [rows, settings, ndas, ndaRequests] = await Promise.all([
    listForCustomer(c.env.DB, customer.id),
    getSettings(c.env.DB),
    listNdas(c.env.DB, customer.id),
    listNdaRequests(c.env.DB, customer.id),
  ]);
  return render(c as unknown as Context<AppEnv>, 'Aftaler og dokumenter', agreementsPage({ poas: rows, canIssuePoa: canIssue(settings, customer.email), ndas, ndaRequests }), {
    nav: 'aftaler',
    isCustomer: true,
  });
});

/** Opbevarings- og slettepolitikken er offentlig, så den kan læses før login og linkes fra mails. */
export const policyPage = (c: Context<AppEnv>) => render(c, 'Opbevaring af fuldmagter', poaPolicyPage());

export default aftaler;
