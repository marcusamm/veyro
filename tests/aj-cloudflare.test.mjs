import { describe, expect, it, vi } from 'vitest';
import { checkManualDns, configureProof, configureWeb, readAuthoritativeAnswer, routeExists, webRecordPlan } from '../scripts/aj-cloudflare.mjs';

const domain = 'aj-auto-slagelse.dk';
const www = 'www.' + domain;
const zone = { id: 'a'.repeat(32), status: 'pending', name_servers: ['blair.ns.cloudflare.com', 'logan.ns.cloudflare.com'] };
const parking = { id: 'b'.repeat(32), type: 'A', content: '46.30.211.38', proxied: false };
const proofHost = '_veyro-mail.' + domain;
const proof = 'veyro-mail-verification=' + 'a'.repeat(64);

function authoritative(record, status = 'NOERROR') {
  return `;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: 1\n;; flags: qr aa; QUERY: 1\n${record}\n`;
}
const emptyDns = authoritative(domain + '. 300 IN SOA blair.ns.cloudflare.com. dns.cloudflare.com. 1 1 1 1 1');

async function dnsForbidden(path, method = 'GET') {
  expect(method).toBe('GET');
  throw Object.assign(new Error('Forbidden'), { status: 403 });
}

function api(initialRecords = {}, initialRoutes = []) {
  const records = structuredClone(initialRecords);
  const routes = structuredClone(initialRoutes);
  const writes = [];
  async function request(path, method = 'GET', body) {
    const url = new URL(path, 'https://example.test');
    if (method === 'GET') {
      if (url.pathname.endsWith('/workers/domains')) return [];
      if (url.pathname.endsWith('/workers/routes')) return routes;
      if (url.pathname.endsWith('/dns_records')) return records[url.searchParams.get('name.exact')] ?? [];
    }
    writes.push({ method, body });
    if (method === 'POST' && url.pathname.endsWith('/workers/routes')) routes.push({ ...body });
    else if (method === 'POST' && url.pathname.endsWith('/dns_records')) (records[body.name] ??= []).push({ ...body });
    else if (method === 'PATCH') Object.assign(Object.values(records).flat().find(record => url.pathname.endsWith(record.id)), body);
    else throw new Error('Unexpected request');
    return {};
  }
  function workerRequest(path, ...args) {
    expect(path).toContain('/workers/');
    return request(path, ...args);
  }
  function dnsRequest(path, ...args) {
    expect(path).toContain('/dns_records');
    return request(path, ...args);
  }
  return { workerRequest, dnsRequest, writes, records };
}

describe('AJ Auto Cloudflare provisioning', () => {
  it('only stages missing routes with DNS 403, and can confirm them afterwards without a DNS token', async () => {
    const cf = api({}, [{ pattern: domain + '/*', script: 'veyro' }]);
    const publicCheck = vi.fn(async (currentZone, hosts) => {
      expect(currentZone).toBe(zone);
      expect(hosts).toEqual([www]);
      await checkManualDns(currentZone, hosts, async (_command, [server, host, type]) => {
        expect(zone.name_servers).toContain(server.slice(1));
        return { stdout: host === www && type === 'AAAA' ? authoritative(www + '. 300 IN AAAA 100::') : emptyDns };
      });
    });
    await configureWeb(cf.workerRequest, dnsForbidden, zone, 'account', publicCheck);
    await configureWeb(cf.workerRequest, dnsForbidden, zone, 'account', publicCheck);
    expect(publicCheck).toHaveBeenCalledTimes(1);
    expect(cf.writes).toEqual([{ method: 'POST', body: { pattern: www + '/*', script: 'veyro' } }]);
  });

  it('refuses an unexpected origin on either authority before staging routes', async () => {
    const cf = api();
    const verify = (currentZone, hosts) => checkManualDns(currentZone, hosts, async (_command, [server, host, type]) => ({
      stdout: server === '@logan.ns.cloudflare.com' && host === www && type === 'A' ?
        authoritative(www + '. 300 IN A 203.0.113.7') : emptyDns,
    }));
    await expect(configureWeb(cf.workerRequest, dnsForbidden, zone, 'account', verify)).rejects.toThrow('Kan ikke bekræfte web-DNS');
    expect(cf.writes).toEqual([]);
  });

  it('reads quoted proof data and distinguishes an authoritative empty answer from resolver failure', () => {
    const txt = authoritative(proofHost + '. 300 IN TXT "' + proof + '"');
    expect(readAuthoritativeAnswer(proofHost, 'TXT', txt)).toEqual([{ type: 'TXT', content: '"' + proof + '"' }]);
    expect(readAuthoritativeAnswer(www, 'A', emptyDns.replace('NOERROR', 'NXDOMAIN'))).toEqual([]);
    expect(() => readAuthoritativeAnswer(www, 'A', emptyDns.replace('qr aa;', 'qr;'))).toThrow();
    expect(() => readAuthoritativeAnswer(www, 'A', emptyDns.replace('NOERROR', 'SERVFAIL'))).toThrow();
    expect(() => readAuthoritativeAnswer(www, 'A', authoritative(''))).toThrow();
  });

  it('stages both exact hosts in a pending zone and preserves the parking origin and mail records on retry', async () => {
    const mail = { name: domain, type: 'MX', content: 'mail.example.test' };
    const cf = api({ [domain]: [{ ...parking, name: domain }, mail] });
    await configureWeb(cf.workerRequest, cf.dnsRequest, zone, 'account');
    expect(cf.writes.filter(write => write.body?.pattern).map(write => write.body)).toEqual([
      { pattern: domain + '/*', script: 'veyro' }, { pattern: www + '/*', script: 'veyro' },
    ]);
    expect(cf.records[domain]).toEqual([{ ...parking, name: domain, proxied: true }, mail]);
    expect(cf.records[www][0]).toMatchObject({ type: 'AAAA', proxied: true, content: '100::' });
    cf.writes.length = 0;
    await configureWeb(cf.workerRequest, cf.dnsRequest, zone, 'account');
    expect(cf.writes).toEqual([]);
  });

  it('preflights both hosts and refuses an unrecognized origin or a wildcard route without any writes', async () => {
    const unknown = api({ [www]: [{ name: www, type: 'CNAME', content: 'vendor.example' }] });
    await expect(configureWeb(unknown.workerRequest, unknown.dnsRequest, zone, 'account')).rejects.toThrow('Ukendt web-DNS');
    expect(unknown.writes).toEqual([]);
    const wildcard = api({}, [{ pattern: '*.' + domain + '/images/*', script: 'other' }]);
    await expect(configureWeb(wildcard.workerRequest, wildcard.dnsRequest, zone, 'account')).rejects.toThrow('anden Worker-rute');
    expect(wildcard.writes).toEqual([]);
    expect(routeExists(domain, [{ pattern: 'https://other.' + domain + '/*' }])).toBe(false);
    expect(() => webRecordPlan(domain, [{ ...parking }, { type: 'AAAA', content: '::1' }])).toThrow('Ukendt');
  });

  it('publishes the one validated TXT alongside existing values and recognizes quoted records on retry', async () => {
    const previous = { name: proofHost, type: 'TXT', content: 'previous proof' };
    const cf = api({ [proofHost]: [previous] });
    await expect(configureProof(cf.dnsRequest, zone.id, 'invalid')).rejects.toThrow('Ugyldigt');
    await configureProof(cf.dnsRequest, zone.id, proof);
    expect(cf.records[proofHost][0]).toEqual(previous);
    cf.records[proofHost][1].content = '"' + proof + '"';
    await configureProof(cf.dnsRequest, zone.id, proof);
    expect(cf.writes).toHaveLength(1);
    expect(cf.writes[0].body).toMatchObject({ type: 'TXT', name: proofHost, content: proof });
  });
});
