#!/usr/bin/env node
// Deployer alle kundeinstallationer beskrevet i kunder/*.json.
//
// For hver kunde og hvert system:
//   1. opretter D1-databasen, hvis den ikke findes
//   2. skriver en wrangler-konfiguration ud fra systemets wrangler.toml-skabelon
//   3. kører databasemigrationer
//   4. deployer workeren og sætter RESEND_API_KEY som hemmelighed
//   5. lagerstyring: lægger firmanavn, farve og logo fra kundefilen i databasen, når de er ændret
//
// Kræver CLOUDFLARE_API_TOKEN og CLOUDFLARE_ACCOUNT_ID i miljøet (og RESEND_API_KEY for e-mail).
// Brug:
//   node scripts/deploy-kunder.mjs              # alle kunder
//   node scripts/deploy-kunder.mjs nordlys      # kun én kunde
//   node scripts/deploy-kunder.mjs --dry-run    # vis konfigurationerne uden at kalde Cloudflare
// Valgfrit: EMAIL_FROM_STANDARD (afsender når kunden ikke har sin egen), WORKERS_SUBDOMAIN
// (kontoens workers.dev-underdomæne, kræves for kunder uden eget domæne) og KUNDE_DOMAENE
// (fx veyro.dk: kunder uden eget domæne får <adresse>.veyro.dk i stedet for workers.dev).
// KUNDEKATALOG_ID overskriver ID'et på KV-navnerummet veyro-kundekatalog.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KUNDER_DIR = join(ROOT, 'kunder');

// Systemer, der kan installeres, og det korte navn, der bruges i worker- og databasenavnet
const SYSTEMER = {
  lagerstyring: { kort: 'lager' },
  varebestilling: { kort: 'bestilling' },
};

// KV-navnerummet "veyro-kundekatalog", som Kundelogin på kunde.veyro.dk slår brugere op i.
// Samme ID står i wrangler.toml i roden. Lagerstyringen skriver sine brugere (som hash) dertil.
const KUNDEKATALOG_ID = process.env.KUNDEKATALOG_ID || '3c625abe4eca4137926bef27947a605f';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAENE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL = /^[^\s@,"<>]+@[^\s@,"<>]+\.[^\s@,"<>]+$/;
const FARVE = /^#[0-9a-fA-F]{6}$/;
const LOGOFIL = /^[a-z0-9][a-z0-9._-]*\.(svg|png|jpe?g|webp)$/;
// Samme grænse som logo-upload i lagerstyring/src/lib/settings.ts
const LOGO_MAX_BYTES = 200 * 1024;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kunFilter = args.filter((a) => !a.startsWith('--'));

function fejl(fil, besked) {
  throw new Error(`${fil}: ${besked}`);
}

/** Læser og validerer kunder/*.json. Alt, der havner i TOML eller kommandoer, tjekkes her. */
export function laesKunder(dir = KUNDER_DIR, kundeDomaene = process.env.KUNDE_DOMAENE || '') {
  if (kundeDomaene && !DOMAENE.test(kundeDomaene)) throw new Error(`KUNDE_DOMAENE er ugyldigt: "${kundeDomaene}"`);
  const filer = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  return filer.map((fil) => {
    const slug = fil.replace(/\.json$/, '');
    if (!SLUG.test(slug) || slug.length > 40) {
      fejl(fil, 'filnavnet skal være små bogstaver, tal og bindestreger (højst 40 tegn)');
    }
    const data = JSON.parse(readFileSync(join(dir, fil), 'utf8'));
    if (typeof data.navn !== 'string' || !data.navn.trim() || /["\\\n]/.test(data.navn)) {
      fejl(fil, '"navn" skal være firmanavnet uden anførselstegn');
    }
    if (!data.systemer || typeof data.systemer !== 'object' || !Object.keys(data.systemer).length) {
      fejl(fil, '"systemer" skal indeholde mindst ét system');
    }
    const adresse = data.adresse ?? slug;
    if (typeof adresse !== 'string' || !SLUG.test(adresse) || adresse.length > 40) {
      fejl(fil, '"adresse" skal være små bogstaver, tal og bindestreger, fx "ek"');
    }
    const systemer = Object.entries(data.systemer).map(([system, opsaetning]) => {
      if (!SYSTEMER[system]) fejl(fil, `ukendt system "${system}" (brug ${Object.keys(SYSTEMER).join(' eller ')})`);
      const { domaene = '', admins = [], afsender = '' } = opsaetning ?? {};
      if (domaene && !DOMAENE.test(domaene)) fejl(fil, `${system}: ugyldigt domæne "${domaene}"`);
      if (!Array.isArray(admins) || !admins.length || !admins.every((a) => EMAIL.test(a))) {
        fejl(fil, `${system}: "admins" skal være en liste med mindst én e-mailadresse`);
      }
      if (afsender && (/["\\\n]/.test(afsender) || !/<[^<>@\s]+@[^<>@\s]+>$/.test(afsender))) {
        fejl(fil, `${system}: "afsender" skal have formen "Navn <adresse@domæne.dk>"`);
      }
      const navn = `${slug}-${SYSTEMER[system].kort}`;
      // Uden eget domæne: <adresse>.<KUNDE_DOMAENE> til lagerstyringen, <adresse>-bestilling.<…> til varebestillingen
      const standardDomaene = kundeDomaene
        ? `${adresse}${system === 'lagerstyring' ? '' : `-${SYSTEMER[system].kort}`}.${kundeDomaene}`
        : '';
      return { system, navn, domaene: domaene || standardDomaene, admins, afsender };
    });
    const udseende = laesUdseende(fil, dir, data.udseende);
    if (data.demo !== undefined && typeof data.demo !== 'boolean') fejl(fil, '"demo" skal være true eller false');
    // "demo": true gør installationen til en demomodel med fiktive eksempeldata og login med ét klik
    if (data.demo) for (const s of systemer) s.demo = true;
    return { slug, navn: data.navn.trim(), systemer, udseende, demo: !!data.demo };
  });
}

/** Billedtypen ud fra filens indhold, som logo-upload i lagerstyringen gør. */
function logoType(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** Valgfri "udseende": { "farve": "#RRGGBB", "logo": "fil i kunder/" }. */
function laesUdseende(fil, dir, udseende) {
  if (udseende === undefined) return null;
  if (!udseende || typeof udseende !== 'object') fejl(fil, '"udseende" skal være et objekt');
  const { farve = '', logo = '' } = udseende;
  if (farve && (typeof farve !== 'string' || !FARVE.test(farve))) fejl(fil, '"udseende.farve" skal have formen "#RRGGBB"');
  let logoData = '';
  if (logo) {
    if (typeof logo !== 'string' || !LOGOFIL.test(logo)) fejl(fil, '"udseende.logo" skal være et filnavn i kunder/, fx "nordlys-logo.svg"');
    const bytes = readFileSync(join(dir, logo));
    const type = logoType(bytes);
    if (!type) fejl(fil, `${logo} er ikke et PNG-, JPG-, WebP- eller SVG-billede`);
    if (bytes.length > LOGO_MAX_BYTES) fejl(fil, `${logo} fylder mere end 200 KB`);
    logoData = `${type};${bytes.toString('base64')}`;
  }
  return { farve: farve.toUpperCase(), logoData };
}

const sqlTekst = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * SQL, der lægger firmanavn, farve og logo fra kundefilen i lagerstyringens indstillinger,
 * når kundefilen har "udseende".
 * Det sker kun, når værdierne i filen er ændret siden sidste deploy, så det, kunden selv
 * retter under Indstillinger, bliver stående, indtil kundefilen ændres igen.
 */
export function bygUdseendeSql(kunde) {
  if (!kunde.udseende) return '';
  const vaerdier = [['company_name', kunde.navn]];
  if (kunde.udseende?.farve) vaerdier.push(['accent_color', kunde.udseende.farve]);
  if (kunde.udseende?.logoData) {
    vaerdier.push(['logo', kunde.udseende.logoData]);
    vaerdier.push(['logo_version', String(Date.now())]);
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(vaerdier.filter(([k]) => k !== 'logo_version')))
    .digest('hex')
    .slice(0, 16);
  const ny = `NOT EXISTS (SELECT 1 FROM settings WHERE key = 'kundefil_udseende' AND value = ${sqlTekst(hash)})`;
  return [...vaerdier, ['kundefil_udseende', hash]]
    .map(
      ([k, v]) =>
        `INSERT INTO settings (key, value) SELECT ${sqlTekst(k)}, ${sqlTekst(v)} WHERE ${ny}\n` +
        '  ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
    )
    .join('\n');
}

/** Bygger kundens wrangler-konfiguration ud fra systemets skabelon, så cron og øvrige felter følger med. */
export function bygKonfiguration(skabelon, inst, databaseId, { standardAfsender = '', workersSubdomain = '' } = {}) {
  const erstat = (tekst, moenster, ny) => {
    if (!moenster.test(tekst)) throw new Error(`Skabelonen mangler ${moenster}`);
    return tekst.replace(moenster, ny);
  };
  // Login-links i e-mails skal være absolutte, så uden eget domæne bruges workers.dev-adressen
  if (!inst.domaene && !workersSubdomain) {
    throw new Error(`${inst.navn}: angiv "domaene" eller sæt WORKERS_SUBDOMAIN`);
  }
  if (workersSubdomain && !SLUG.test(workersSubdomain)) throw new Error('WORKERS_SUBDOMAIN er ugyldigt');
  const appUrl = inst.domaene ? `https://${inst.domaene}` : `https://${inst.navn}.${workersSubdomain}.workers.dev`;
  const afsender = inst.afsender || standardAfsender;
  let t = skabelon;
  t = erstat(t, /^name = .*$/m, `name = "${inst.navn}"`);
  t = erstat(t, /^database_name = .*$/m, `database_name = "${inst.navn}"`);
  t = erstat(t, /^database_id = .*$/m, `database_id = "${databaseId}"`);
  t = erstat(t, /^APP_URL = .*$/m, `APP_URL = "${appUrl}"`);
  t = erstat(t, /^ADMIN_EMAILS = .*$/m, `ADMIN_EMAILS = "${inst.admins.join(',')}"`);
  t = erstat(t, /^EMAIL_FROM = .*$/m, `EMAIL_FROM = "${afsender}"`);
  t = erstat(t, /^DEV_MODE = .*$/m, 'DEV_MODE = "0"');
  if (/^DEMO_MODE = /m.test(t)) t = t.replace(/^DEMO_MODE = .*$/m, `DEMO_MODE = "${inst.demo ? '1' : '0'}"`);
  if (inst.system === 'lagerstyring') {
    if (!/^[0-9a-f]{32}$/.test(KUNDEKATALOG_ID)) throw new Error('KUNDEKATALOG_ID er ugyldigt');
    t = erstat(t, /^DEV_MODE = .*$/m, `DEV_MODE = "0"\nKATALOG_ID = "${inst.navn}"`);
    t += `\n# Kundekataloget, så Kundelogin på kunde.veyro.dk kan sende brugerne hertil\n[[kv_namespaces]]\nbinding = "KATALOG"\nid = "${KUNDEKATALOG_ID}"\n`;
  }
  if (inst.domaene) {
    t = erstat(
      t,
      /^preview_urls = .*$/m,
      `preview_urls = false\nroutes = [\n  { pattern = "${inst.domaene}", custom_domain = true }\n]`,
    );
  }
  return `# Genereret af scripts/deploy-kunder.mjs – rediger kunder/*.json i stedet.\n${t}`;
}

function wrangler(cwd, wranglerArgs, input) {
  return execFileSync('npx', ['--no-install', 'wrangler', ...wranglerArgs], {
    cwd,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'],
  });
}

function findDatabase(cwd, navn) {
  const liste = JSON.parse(wrangler(cwd, ['d1', 'list', '--json']));
  return liste.find((db) => db.name === navn)?.uuid;
}

function deploy(kunde, inst) {
  const cwd = join(ROOT, inst.system);
  const skabelon = readFileSync(join(cwd, 'wrangler.toml'), 'utf8');
  const config = `.wrangler-kunde-${inst.navn}.toml`;

  let databaseId = dryRun ? '00000000-0000-0000-0000-000000000000' : findDatabase(cwd, inst.navn);
  if (!databaseId) {
    console.log(`  opretter database ${inst.navn}`);
    // Uden angivelse lægges databasen tæt på den, der opretter den (GitHubs servere i USA), og så
    // skal hver forespørgsel fra Danmark over Atlanten. "eu" holder kundedata i EU og tæt på kunderne.
    wrangler(cwd, ['d1', 'create', inst.navn, '--jurisdiction', 'eu']);
    databaseId = findDatabase(cwd, inst.navn);
    if (!databaseId) throw new Error(`Databasen ${inst.navn} blev ikke fundet efter oprettelse`);
  }

  const toml = bygKonfiguration(skabelon, inst, databaseId, {
    standardAfsender: process.env.EMAIL_FROM_STANDARD,
    workersSubdomain: dryRun ? process.env.WORKERS_SUBDOMAIN || 'konto' : process.env.WORKERS_SUBDOMAIN,
  });
  const udseendeSql = inst.system === 'lagerstyring' ? bygUdseendeSql(kunde) : '';
  if (dryRun) {
    console.log(toml);
    if (udseendeSql) console.log(udseendeSql.replace(/'image\/[^;']+;[^']{60,}'/g, "'<logo>'"));
    return;
  }
  writeFileSync(join(cwd, config), toml);
  wrangler(cwd, ['d1', 'migrations', 'apply', inst.navn, '--remote', '--config', config]);
  if (udseendeSql) {
    const sqlFil = `.wrangler-kunde-${inst.navn}-udseende.sql`;
    writeFileSync(join(cwd, sqlFil), udseendeSql);
    try {
      wrangler(cwd, ['d1', 'execute', inst.navn, '--remote', '--yes', '--file', sqlFil, '--config', config]);
    } finally {
      unlinkSync(join(cwd, sqlFil));
    }
  }
  // Vis deployets output, så det fremgår af loggen, hvilke adresser workeren fik
  console.log(wrangler(cwd, ['deploy', '--config', config]));
  if (process.env.RESEND_API_KEY) {
    wrangler(cwd, ['secret', 'put', 'RESEND_API_KEY', '--config', config], process.env.RESEND_API_KEY);
  } else {
    console.log('  RESEND_API_KEY er ikke sat – login-mails sendes ikke');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kunder = laesKunder().filter((k) => !kunFilter.length || kunFilter.includes(k.slug));
  if (kunFilter.length && !kunder.length) throw new Error(`Ingen kunde hedder ${kunFilter.join(', ')}`);
  const fejlede = [];
  for (const kunde of kunder) {
    for (const inst of kunde.systemer) {
      console.log(`\n== ${kunde.navn}: ${inst.system} (${inst.navn})`);
      try {
        deploy(kunde, inst);
      } catch (e) {
        // Én kundes fejl må ikke stoppe opdateringen af de andre
        console.error(`  FEJL: ${e.message}`);
        fejlede.push(inst.navn);
      }
    }
  }
  if (fejlede.length) {
    console.error(`\nFejlede: ${fejlede.join(', ')}`);
    process.exit(1);
  }
}
