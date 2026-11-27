import { resolveNs } from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const domain = 'aj-auto-slagelse.dk';
const webHosts = [domain, 'www.' + domain];
const proofName = '_veyro-mail.' + domain;
const worker = 'veyro';
const parkingAddress = '46.30.211.38';
const placeholder = '100::';
const nameservers = ['blair.ns.cloudflare.com', 'logan.ns.cloudflare.com'];
const dig = promisify(execFile);

function cloudflare(token) {
  return async function request(path, method = 'GET', body) {
    const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      const codes = (data.errors ?? []).map(error => error.code).filter(Number.isInteger);
      const endpoint = path.split('?')[0].replace(/[0-9a-f]{32}/gi, '…');
      const error = new Error(`Cloudflare ${method} ${endpoint}: HTTP ${response.status}, kode ${codes.join(', ')}.`);
      error.status = response.status;
      throw error;
    }
    if (data.result_info?.total_pages > 1) throw new Error('Listen fra Cloudflare er ufuldstændig.');
    return data.result;
  };
}

async function dnsRecords(request, zonePath, name) {
  const records = await request(`${zonePath}/dns_records?name.exact=${encodeURIComponent(name)}&per_page=100`);
  if (!Array.isArray(records) || records.some(record => record.name !== name)) {
    throw new Error('Cloudflare returnerede andre DNS-navne end det ønskede.');
  }
  return records;
}

export function webRecordPlan(host, records) {
  const webTypes = ['A', 'AAAA', 'CNAME', 'HTTPS', 'SVCB'];
  if (host !== domain) webTypes.push('NS');
  const web = records.filter(record => webTypes.includes(record.type));
  if (!web.length) return { action: 'create' };
  const [record] = web;
  if (web.length === 1) {
    const parked = record.type === 'A' && record.content === parkingAddress;
    const ours = record.type === 'AAAA' && record.content === placeholder && record.proxied === true;
    if (ours || (parked && record.proxied === true)) return { action: 'ready' };
    if (parked && record.proxied === false && /^[0-9a-f]{32}$/i.test(record.id)) {
      return { action: 'proxy', id: record.id };
    }
  }
  throw new Error(`Ukendt web-DNS på ${host} (${web.map(record => record.type).join(', ')}).`);
}

export function routeExists(host, routes) {
  let found = false;
  for (const route of routes) {
    const routeHost = route.pattern.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    // Cloudflare admits a wildcard at the start of the hostname.
    const matches = routeHost.startsWith('*') ? host.endsWith(routeHost.slice(1)) : host === routeHost;
    if (!matches) continue;
    if (route.script !== worker) throw new Error(`En anden Worker-rute matcher ${host}: ${route.pattern}.`);
    if (route.pattern === host + '/*') found = true;
  }
  return found;
}

export function readAuthoritativeAnswer(host, type, output) {
  const flags = output.match(/^;; flags: ([^;]+);/m)?.[1].split(/\s+/) ?? [];
  const status = output.match(/status: (\w+),/)?.[1];
  if (!flags.includes('aa') || !['NOERROR', 'NXDOMAIN'].includes(status)) {
    throw new Error(`Intet autoritativt svar for ${host} ${type}.`);
  }
  const records = output.split(/\r?\n/).filter(line => line && !line.startsWith(';')).map(line => line.trim().split(/\s+/));
  const answers = records.filter(([name, , klass, rrtype]) => name === host + '.' && klass === 'IN' && rrtype !== 'SOA');
  if (!answers.length && !records.some(([name, , klass, rrtype]) => name === domain + '.' && klass === 'IN' && rrtype === 'SOA')) {
    throw new Error(`Manglende SOA ved tomt DNS-svar for ${host} ${type}.`);
  }
  return answers.map(([, , , rrtype, content]) => ({ type: rrtype, content }));
}

export async function checkManualDns(zone, hosts, runDig = dig) {
  if ([...(zone.name_servers ?? [])].sort().join() !== nameservers.join()) throw new Error('Zonens navneservere har ændret sig.');
  const names = hosts.includes(webHosts[1]) ? [...hosts, '*.' + domain] : hosts;
  for (const server of nameservers) {
    for (const host of names) {
      const types = ['A', 'AAAA', 'CNAME', 'HTTPS', 'SVCB'];
      if (host !== domain) types.push('NS');
      const results = await Promise.all(types.map(async type => {
        const { stdout } = await runDig('dig', ['@' + server, host, type, '+norecurse', '+time=4', '+tries=2',
          '+noall', '+comments', '+answer', '+authority'], { timeout: 10_000 });
        return readAuthoritativeAnswer(host, type, stdout);
      }));
      const records = results.flat();
      if (!records.length) continue;
      const [record] = records;
      const known = (record.type === 'A' && record.content === parkingAddress) ||
        (record.type === 'AAAA' && record.content === placeholder);
      if (host.startsWith('*') || records.length !== 1 || !known) throw new Error(`Kan ikke bekræfte web-DNS på ${host} hos ${server}.`);
    }
  }
}

export async function configureWeb(request, dnsRequest, zone, account, verifyManualDns = checkManualDns) {
  const zonePath = '/zones/' + zone.id;
  const routesPath = zonePath + '/workers/routes';
  const [routes, customDomains] = await Promise.all([
    request(routesPath), request(`/accounts/${account}/workers/domains?zone_id=${zone.id}`),
  ]);
  const plans = webHosts.map(host => {
    if (customDomains.some(item => item.hostname === host)) {
      throw new Error(`Der er allerede et Worker Custom Domain på ${host}.`);
    }
    return { host, routed: routeExists(host, routes) };
  });
  let manual = false;
  try {
    for (const plan of plans) {
      const records = await dnsRecords(dnsRequest, zonePath, plan.host);
      if (plan.host !== domain && !records.length) {
        const wildcard = await dnsRecords(dnsRequest, zonePath, '*.' + domain);
        if (wildcard.some(record => ['A', 'AAAA', 'CNAME', 'HTTPS', 'SVCB'].includes(record.type))) {
          throw new Error(`${plan.host} dækkes af en eksisterende wildcard-DNS-post.`);
        }
      }
      plan.dns = webRecordPlan(plan.host, records);
    }
  } catch (error) {
    if (error.status !== 403) throw error;
    manual = true;
    const missing = plans.filter(plan => !plan.routed).map(plan => plan.host);
    if (missing.length) await verifyManualDns(zone, missing);
  }
  for (const { host, dns, routed } of plans) {
    if (!routed) await request(routesPath, 'POST', { pattern: host + '/*', script: worker });
    if (manual) continue;
    if (dns.action === 'create') {
      await dnsRequest(zonePath + '/dns_records', 'POST', {
        type: 'AAAA', name: host, content: placeholder, proxied: true, ttl: 1,
      });
    } else if (dns.action === 'proxy') {
      await dnsRequest(zonePath + '/dns_records/' + dns.id, 'PATCH', { proxied: true });
    }
  }
  const updatedRoutes = await request(routesPath);
  for (const host of webHosts) {
    if (!routeExists(host, updatedRoutes)) throw new Error(`Worker-ruten mangler for ${host}.`);
    if (!manual) {
      const records = await dnsRecords(dnsRequest, zonePath, host);
      if (webRecordPlan(host, records).action !== 'ready') throw new Error(`Proxy kunne ikke bekræftes for ${host}.`);
    }
  }
  console.log(`Begge ruter er bekræftet på Worker ${worker}. Zonestatus: ${zone.status}.`);
  if (manual) console.log('DNS styres manuelt. Browseradgang og HTTPS er ikke testet i dette trin.');
}

export async function configureProof(request, zoneId, value) {
  if (!/^veyro-mail-verification=[0-9a-f]{64}$/.test(value)) throw new Error('Ugyldigt format for ejerskabsbevis.');
  const zonePath = '/zones/' + zoneId;
  const records = await dnsRecords(request, zonePath, proofName);
  const matches = record => record.type === 'TXT' && [value, '"' + value + '"'].includes(record.content);
  if (records.some(matches)) return;
  if (records.some(record => ['CNAME', 'NS'].includes(record.type))) {
    throw new Error(`Navnet ${proofName} bruges allerede som alias eller delegation.`);
  }
  await request(zonePath + '/dns_records', 'POST', { type: 'TXT', name: proofName, content: value, ttl: 300 });
  if (!(await dnsRecords(request, zonePath, proofName)).some(matches)) {
    throw new Error('TXT-posten kunne ikke bekræftes.');
  }
}

async function main(mode) {
  if (!['web', 'proof'].includes(mode)) throw new Error('Vælg web eller proof.');
  try {
    console.log(`Offentlige navneservere for ${domain}: ${(await resolveNs(domain)).sort().join(', ')}.`);
  } catch (error) {
    console.log(`Offentligt NS-opslag mislykkedes (${error.code}).`);
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!/^[0-9a-f]{32}$/i.test(account || '') || !token) throw new Error('Cloudflare-konto og API-token mangler.');
  const request = cloudflare(token);
  const dnsRequest = cloudflare(process.env.AJ_AUTO_DNS_API_TOKEN || token);
  const zones = await request(`/zones?name=${domain}&account.id=${account}`);
  const [zone] = zones;
  if (zones.length !== 1 || zone.name !== domain || zone.account?.id !== account || !/^[0-9a-f]{32}$/i.test(zone.id)) {
    throw new Error(`Zonen ${domain} er ikke synlig på den forventede Cloudflare-konto med dette token.`);
  }
  console.log(`Cloudflare-zone ${domain}: ${zone.status}. Tildelte navneservere: ${zone.name_servers.join(', ')}.`);
  if (zone.paused || !['pending', 'active'].includes(zone.status)) throw new Error('Zonen er ikke klar til opsætning.');
  if (mode === 'proof') {
    const zoneFile = await readFile(new URL('../ops/aj-auto-domain-proof.txt', import.meta.url), 'utf8');
    const record = zoneFile.match(/^_veyro-mail\.aj-auto-slagelse\.dk\.\s+\d+\s+IN\s+TXT\s+"(veyro-mail-verification=[a-f0-9]{64})"\s*$/m);
    if (!record) throw new Error('Importfilen mangler AJ Autos TXT-bevis.');
    const expected = record[1];
    try {
      await configureProof(dnsRequest, zone.id, expected);
    } catch (error) {
      if (error.status !== 403) throw error;
      for (const server of nameservers) {
        const { stdout } = await dig('dig', ['@' + server, proofName, 'TXT', '+norecurse', '+time=4', '+tries=2', '+noall', '+comments', '+answer', '+authority'], { timeout: 10_000 });
        const answers = readAuthoritativeAnswer(proofName, 'TXT', stdout);
        if (!answers.some(row => row.type === 'TXT' && row.content === JSON.stringify(expected))) throw error;
      }
    }
    console.log(`Ejerskabsbeviset er bekræftet i Cloudflare på ${proofName}.`);
  } else {
    await configureWeb(request, dnsRequest, zone, account);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
