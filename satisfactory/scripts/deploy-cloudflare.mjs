#!/usr/bin/env node
// Deploy this application to its own Worker and D1 database. Credentials are
// supplied by GitHub Actions; this script never reads or changes Veyro's DB.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_NAME = 'satisfactory-venner';
const DATABASE_NAME = 'satisfactory-venner';
const HOSTNAME = 'satisfactoryvenner.veyro.dk';
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';

// The checked-in .jsonc file deliberately uses ordinary JSON, so it is also
// readable without adding a deployment-only dependency.
export function deploymentConfig(source, databaseId, root = ROOT) {
  const config = structuredClone(source);
  if (config.name !== WORKER_NAME) throw new Error(`Worker name must be ${WORKER_NAME}.`);
  if (config.routes?.length !== 1 || config.routes[0].pattern !== HOSTNAME || config.routes[0].custom_domain !== true) {
    throw new Error(`Only the ${HOSTNAME} custom domain may be deployed here.`);
  }
  if (config.d1_databases?.length !== 1 || config.d1_databases[0].binding !== 'DB' || config.d1_databases[0].database_name !== DATABASE_NAME) {
    throw new Error('This application must use only its dedicated satisfactory-venner database.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error('Cloudflare returned an invalid database ID.');
  }
  const localPath = (value, label) => {
    if (typeof value !== 'string' || !value) throw new Error(`Missing ${label}.`);
    const absolute = resolve(root, value);
    const location = relative(root, absolute);
    if (location.startsWith('..') || isAbsolute(location)) throw new Error(`${label} must stay inside this application.`);
    return absolute;
  };
  config.main = localPath(config.main, 'Worker entrypoint');
  if (!config.assets?.directory || config.assets.binding !== 'ASSETS' || config.assets.run_worker_first !== true) {
    throw new Error('Assets must pass through the Worker so private documents remain protected.');
  }
  config.assets.directory = localPath(config.assets.directory, 'assets directory');
  if (config.tsconfig) config.tsconfig = localPath(config.tsconfig, 'TypeScript configuration');
  config.d1_databases[0].database_id = databaseId;
  config.d1_databases[0].migrations_dir = localPath(config.d1_databases[0].migrations_dir || './migrations', 'migrations directory');
  config.workers_dev = false;
  config.preview_urls = false;
  return config;
}

function wrangler(args, capture = false) {
  return execFileSync(process.execPath, [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    maxBuffer: 10 * 1024 * 1024,
  });
}

function findDatabase() {
  const databases = JSON.parse(wrangler(['d1', 'list', '--json'], true));
  if (!Array.isArray(databases)) throw new Error('Cloudflare returned an unexpected database list.');
  return databases.find(database => database.name === DATABASE_NAME)?.uuid;
}

export function deploy({ dryRun = false } = {}) {
  const source = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8'));
  // Reject another application's configuration before any remote operation.
  deploymentConfig(source, PLACEHOLDER_ID);
  if (dryRun) {
    console.log(`Configuration checked: ${WORKER_NAME} → ${HOSTNAME}; dedicated D1 ${DATABASE_NAME}. No remote changes.`);
    return;
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be supplied by the deployment environment.');
  }
  let databaseId = findDatabase();
  if (!databaseId) {
    wrangler(['d1', 'create', DATABASE_NAME, '--jurisdiction', 'eu', '--update-config=false']);
    databaseId = findDatabase();
  }
  if (!databaseId) throw new Error('The dedicated database could not be found after creation.');
  const config = deploymentConfig(source, databaseId);
  config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
  const generatedConfig = join(ROOT, '.local-state/wrangler.deploy.json');
  mkdirSync(dirname(generatedConfig), { recursive: true });
  writeFileSync(generatedConfig, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  wrangler(['d1', 'migrations', 'apply', DATABASE_NAME, '--remote', '--config', generatedConfig]);
  wrangler(['deploy', '--config', generatedConfig]);
  console.log(`Deployed https://${HOSTNAME} with its dedicated database.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Usage: node scripts/deploy-cloudflare.mjs [--dry-run]');
  deploy({ dryRun: args.includes('--dry-run') });
}
