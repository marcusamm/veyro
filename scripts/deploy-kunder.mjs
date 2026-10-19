#!/usr/bin/env node
// Deployer alle kundeinstallationer beskrevet i kunder/*.json.
//
// For hver kunde og hvert system:
//   1. opretter D1-databasen, hvis den ikke findes
//   2. skriver en wrangler-konfiguration ud fra systemets wrangler.toml-skabelon
//   3. kører databasemigrationer
//   4. deployer workeren og sætter RESEND_API_KEY som hemmelighed
//
// Kræver CLOUDFLARE_API_TOKEN og CLOUDFLARE_ACCOUNT_ID i miljøet (og RESEND_API_KEY for e-mail).
// Brug:
//   node scripts/deploy-kunder.mjs              # alle kunder
//   node scripts/deploy-kunder.mjs nordlys      # kun én kunde
//   node scripts/deploy-kunder.mjs --dry-run    # vis konfigurationerne uden at kalde Cloudflare
// Valgfrit: EMAIL_FROM_STANDARD (afsender når kunden ikke har sin egen) og WORKERS_SUBDOMAIN
// (kontoens workers.dev-underdomæne, kræves for kunder uden eget domæne).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KUNDER_DIR = join(ROOT, 'kunder');

// Systemer, der kan installeres, og det korte navn, der bruges i worker- og databasenavnet
const SYSTEMER = {
  lagerstyring: { kort: 'lager' },
  varebestilling: { kort: 'bestilling' },
};

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOMAENE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const EMAIL = /^[^\s@,"<>]+@[^\s@,"<>]+\.[^\s@,"<>]+$/;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const kunFilter = args.filter((a) => !a.startsWith('--'));

function fejl(fil, besked) {
  throw new Error(`${fil}: ${besked}`);
}

/** Læser og validerer kunder/*.json. Alt, der havner i TOML eller kommandoer, tjekkes her. */
export function laesKunder(dir = KUNDER_DIR) {
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
      return { system, navn, domaene, admins, afsender };
    });
    return { slug, navn: data.navn.trim(), systemer };
  });
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
  if (/^DEMO_MODE = /m.test(t)) t = t.replace(/^DEMO_MODE = .*$/m, 'DEMO_MODE = "0"');
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

function deploy(inst) {
  const cwd = join(ROOT, inst.system);
  const skabelon = readFileSync(join(cwd, 'wrangler.toml'), 'utf8');
  const config = `.wrangler-kunde-${inst.navn}.toml`;

  let databaseId = dryRun ? '00000000-0000-0000-0000-000000000000' : findDatabase(cwd, inst.navn);
  if (!databaseId) {
    console.log(`  opretter database ${inst.navn}`);
    wrangler(cwd, ['d1', 'create', inst.navn]);
    databaseId = findDatabase(cwd, inst.navn);
    if (!databaseId) throw new Error(`Databasen ${inst.navn} blev ikke fundet efter oprettelse`);
  }

  const toml = bygKonfiguration(skabelon, inst, databaseId, {
    standardAfsender: process.env.EMAIL_FROM_STANDARD,
    workersSubdomain: dryRun ? process.env.WORKERS_SUBDOMAIN || 'konto' : process.env.WORKERS_SUBDOMAIN,
  });
  if (dryRun) {
    console.log(toml);
    return;
  }
  writeFileSync(join(cwd, config), toml);
  wrangler(cwd, ['d1', 'migrations', 'apply', inst.navn, '--remote', '--config', config]);
  wrangler(cwd, ['deploy', '--config', config]);
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
        deploy(inst);
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
