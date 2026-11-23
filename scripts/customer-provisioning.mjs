// Run only in the authorized production workflow. Customer data is encrypted before
// entering this public repository; neither plaintext nor credentials are logged.
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const context = 'veyro/complimentary-customer-provisioning/v1';
const b64 = data => Buffer.from(data).toString('base64');
const un64 = value => Buffer.from(value, 'base64');
const hash = data => createHash('sha256').update(data).digest('hex');

export function provisionKey(token) {
  if (typeof token !== 'string' || token.length < 20) throw new Error('Missing production credential.');
  const seed = Buffer.from(hkdfSync('sha256', token, context, 'recipient-key', 32));
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
}
export function publicProvisionKey(token) {
  return b64(createPublicKey(provisionKey(token)).export({ format: 'der', type: 'spki' }));
}
export function sealPayload(publicKey, payload) {
  const ephemeral = generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: un64(publicKey), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', hkdfSync('sha256', shared, nonce, context, 32), nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { version: 1, ephemeral: b64(ephemeral.publicKey.export({ format: 'der', type: 'spki' })), nonce: b64(nonce), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
}
export function openPayload(token, envelope) {
  if (envelope.version !== 1) throw new Error('Invalid payload version.');
  const shared = diffieHellman({ privateKey: provisionKey(token), publicKey: createPublicKey({ key: un64(envelope.ephemeral), format: 'der', type: 'spki' }) });
  const nonce = un64(envelope.nonce);
  const cipher = createDecipheriv('aes-256-gcm', hkdfSync('sha256', shared, nonce, context, 32), nonce);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(un64(envelope.tag));
  return JSON.parse(Buffer.concat([cipher.update(un64(envelope.ciphertext)), cipher.final()]).toString('utf8'));
}

export function validatePayload(p, now = Math.floor(Date.now() / 1000)) {
  if (!p || p.version !== 1 || p.system !== 'aj' || p.plan !== 'starter' || p.amount !== 0) throw new Error('Only the authorized complimentary Starter operation is supported.');
  if (!/^[a-z0-9_-]{8,80}$/.test(p.operationId) || !/^agreement_[a-z0-9_]{8,80}$/.test(p.subscriptionId)) throw new Error('Invalid operation identifiers.');
  if (typeof p.email !== 'string' || p.email !== p.email.toLowerCase() || !/^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[^\s@<>()"',;]{2,}$/.test(p.email) || p.email.length > 254) throw new Error('Invalid customer email.');
  for (const key of ['name', 'company', 'city', 'agreementNote']) if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > (key === 'agreementNote' ? 4000 : 200)) throw new Error('Invalid customer fields.');
  if (!/^\d{8}$/.test(p.cvr) || !/^[a-f0-9]{64}$/.test(p.documentSha256)) throw new Error('Invalid agreement reference.');
  if (p.websiteUrl !== 'https://aj.veyro.dk' || p.websiteAdminUrl !== 'https://aj.veyro.dk/admin') throw new Error('Unexpected website.');
  if (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= now || p.expiresAt > now + 86400) throw new Error('Provisioning authorization expired or invalid.');
  return p;
}

export function writeBatch(p, payloadHash) {
  return [
    { sql: 'INSERT INTO customers (email,name,company,cvr,city,created_at,updated_at) VALUES (?,?,?,?,?,unixepoch(),unixepoch()) ON CONFLICT(email) DO NOTHING', params: [p.email, p.name, p.company, p.cvr, p.city] },
    { sql: 'UPDATE customers SET name=COALESCE(name,?),company=COALESCE(company,?),cvr=COALESCE(cvr,?),city=COALESCE(city,?),updated_at=unixepoch() WHERE email=? AND stripe_customer_id IS NULL', params: [p.name, p.company, p.cvr, p.city, p.email] },
    { sql: `INSERT INTO subscriptions (id,customer_id,status,plan,amount,currency,started_at,updated_at,interval,billing_mode,agreement_note,website_url,website_admin_url)
      SELECT ?,id,'active','starter',0,'dkk',unixepoch(),unixepoch(),'month','complimentary',?,?,? FROM customers WHERE email=? AND stripe_customer_id IS NULL`, params: [p.subscriptionId, p.agreementNote, p.websiteUrl, p.websiteAdminUrl, p.email] },
    { sql: "UPDATE aj_staff SET name=?,role='owner',active=1 WHERE email=?", params: [p.name, p.email] },
    { sql: `INSERT INTO aj_staff (name,email,role,active) SELECT ?,?,'owner',1
      WHERE NOT EXISTS(SELECT 1 FROM aj_staff WHERE email=?)`, params: [p.name, p.email, p.email] },
    // The final CHECK makes the entire D1 batch fail if a precondition changed concurrently.
    { sql: `INSERT INTO customer_provisioning_operations (id,payload_sha256,document_sha256,customer_id,verified)
      SELECT ?,?,?,c.id,CASE WHEN c.stripe_customer_id IS NULL AND c.name=? AND c.company=? AND c.cvr=?
      AND (SELECT COUNT(*) FROM subscriptions s WHERE s.customer_id=c.id AND s.status NOT IN ('canceled','incomplete_expired'))=1
      AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.id=? AND s.customer_id=c.id AND s.billing_mode='complimentary' AND s.amount=0 AND s.status='active')
      AND EXISTS(SELECT 1 FROM aj_staff a WHERE a.email=c.email AND a.role='owner' AND a.active=1)
      THEN 1 ELSE 0 END FROM customers c WHERE c.email=?`, params: [p.operationId, payloadHash, p.documentSha256, p.name, p.company, p.cvr, p.subscriptionId, p.email] },
  ];
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const publicKey = publicProvisionKey(token);
  console.log(`PROVISIONING_PUBLIC_KEY=${publicKey}`);
  const payloadFile = process.argv[2];
  if (!payloadFile || !existsSync(payloadFile)) { console.log('No customer payload; no database changes.'); return; }
  const raw = readFileSync(payloadFile, 'utf8');
  const p = openPayload(token, JSON.parse(raw));
  // Defensive log masking; no customer values are otherwise written to stdout.
  if (process.env.GITHUB_ACTIONS) for (const key of ['email', 'name', 'company', 'cvr', 'agreementNote']) console.log(`::add-mask::${String(p[key]).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  const config = readFileSync('wrangler.toml', 'utf8');
  const dbId = config.match(/^database_id = "([a-f0-9-]+)"/m)?.[1];
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!dbId || !account) throw new Error('Missing target database configuration.');
  const query = async body => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${dbId}/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || !result.success || result.result?.some(r => r.success === false)) throw new Error(`Database operation rejected (HTTP ${response.status}); no query data logged.`);
    return result.result;
  };
  const operation = await query({ sql: 'SELECT payload_sha256 FROM customer_provisioning_operations WHERE id=?', params: [p.operationId] });
  if (operation[0]?.results?.length) {
    if (operation[0].results[0].payload_sha256 !== hash(raw)) throw new Error('Operation already used with another payload.');
    if (process.argv[3]) {
      const update = readFileSync(process.argv[3], 'utf8');
      const change = openPayload(token, JSON.parse(update));
      if (change.provisionSha256 !== hash(raw)) throw new Error('Email update belongs to a different provisioning record.');
      const { updateOwnerEmail } = await import('./customer-email-update.mjs');
      await updateOwnerEmail(query, p, change, hash(update));
      return;
    }
    console.log('Operation already completed; no changes or reactivation performed.'); return;
  }
  if (process.argv[3]) throw new Error('An owner email change requires a previously provisioned customer.');
  validatePayload(p);
  const before = await query({ batch: [
    { sql: 'SELECT email,name,company,cvr,stripe_customer_id FROM customers WHERE lower(email)=?', params: [p.email] },
    { sql: "SELECT s.id FROM subscriptions s JOIN customers c ON c.id=s.customer_id WHERE lower(c.email)=? AND s.status NOT IN ('canceled','incomplete_expired')", params: [p.email] },
    { sql: 'SELECT id FROM subscriptions WHERE id=?', params: [p.subscriptionId] },
    { sql: 'SELECT booking_enabled,workshop_email FROM aj_settings WHERE id=1', params: [] },
  ] });
  const existing = before[0].results[0];
  if (before[0].results.length > 1 || (existing?.email && existing.email !== p.email) || existing?.stripe_customer_id || before[1].results.length || before[2].results.length) throw new Error('Existing billing or ambiguous account requires review; no account changes made.');
  for (const field of ['name', 'company', 'cvr']) if (existing?.[field] && existing[field] !== p[field]) throw new Error('Existing customer identity differs; no changes made.');
  await query({ batch: writeBatch(p, hash(raw)) });
  const after = await query({ batch: [
    { sql: `SELECT c.id AS customer_id,c.email,c.name,c.company,c.cvr,c.stripe_customer_id,s.* FROM customers c JOIN subscriptions s ON s.customer_id=c.id WHERE c.email=? AND s.id=?`, params: [p.email, p.subscriptionId] },
    { sql: 'SELECT role,active FROM aj_staff WHERE email=?', params: [p.email] },
    { sql: 'SELECT booking_enabled,workshop_email FROM aj_settings WHERE id=1', params: [] },
  ] });
  const s = after[0].results[0], staff = after[1].results[0];
  if (!s || s.email !== p.email || s.name !== p.name || s.company !== p.company || s.cvr !== p.cvr || s.stripe_customer_id || s.plan !== 'starter' || s.billing_mode !== 'complimentary' || s.amount !== 0 || s.status !== 'active' || s.price_id || s.item_id || s.current_period_end || s.website_url !== p.websiteUrl || s.website_admin_url !== p.websiteAdminUrl || s.agreement_note !== p.agreementNote || staff?.role !== 'owner' || staff.active !== 1 || JSON.stringify(before[3].results) !== JSON.stringify(after[2].results)) throw new Error('Post-operation verification failed; review required.');
  console.log(JSON.stringify({ verified: true, customerId: s.customer_id, plan: 'starter', monthlyAmount: 0, billingMode: 'complimentary', stripeCustomer: false, stripePrice: false, automaticConversion: false, websiteLinked: true, siteOwner: true, globalAdminGranted: false, bookingSettingsUnchanged: true, emailsSent: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
