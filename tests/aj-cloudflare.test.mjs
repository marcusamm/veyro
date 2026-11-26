import { describe, expect, it } from 'vitest';
import { configureProof, configureWeb, routeExists, webRecordPlan } from '../scripts/aj-cloudflare.mjs';

const domain = 'aj-auto-slagelse.dk';
const www = 'www.' + domain;
const zone = { id: 'a'.repeat(32), status: 'pending' };
const parking = { id: 'b'.repeat(32), type: 'A', content: '46.30.211.38', proxied: false };
const proofHost = '_veyro-mail.' + domain;
const proof = 'veyro-mail-verification=' + 'a'.repeat(64);

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
  return { request, writes, records };
}

describe('AJ Auto Cloudflare provisioning', () => {
  it('stages both exact hosts in a pending zone and preserves the parking origin and mail records on retry', async () => {
    const mail = { name: domain, type: 'MX', content: 'mail.example.test' };
    const cf = api({ [domain]: [{ ...parking, name: domain }, mail] });
    await configureWeb(cf.request, zone, 'account');
    expect(cf.writes.filter(write => write.body?.pattern).map(write => write.body)).toEqual([
      { pattern: domain + '/*', script: 'veyro' }, { pattern: www + '/*', script: 'veyro' },
    ]);
    expect(cf.records[domain]).toEqual([{ ...parking, name: domain, proxied: true }, mail]);
    expect(cf.records[www][0]).toMatchObject({ type: 'AAAA', proxied: true, content: '100::' });
    cf.writes.length = 0;
    await configureWeb(cf.request, zone, 'account');
    expect(cf.writes).toEqual([]);
  });

  it('preflights both hosts and refuses an unrecognized origin or a wildcard route without any writes', async () => {
    const unknown = api({ [www]: [{ name: www, type: 'CNAME', content: 'vendor.example' }] });
    await expect(configureWeb(unknown.request, zone, 'account')).rejects.toThrow('Ukendt web-DNS');
    expect(unknown.writes).toEqual([]);
    const wildcard = api({}, [{ pattern: '*.' + domain + '/images/*', script: 'other' }]);
    await expect(configureWeb(wildcard.request, zone, 'account')).rejects.toThrow('anden Worker-rute');
    expect(wildcard.writes).toEqual([]);
    expect(routeExists(domain, [{ pattern: 'https://other.' + domain + '/*' }])).toBe(false);
    expect(() => webRecordPlan(domain, [{ ...parking }, { type: 'AAAA', content: '::1' }])).toThrow('Ukendt');
  });

  it('publishes the one validated TXT alongside existing values and recognizes quoted records on retry', async () => {
    const previous = { name: proofHost, type: 'TXT', content: 'previous proof' };
    const cf = api({ [proofHost]: [previous] });
    await expect(configureProof(cf.request, zone.id, 'invalid')).rejects.toThrow('Ugyldigt');
    await configureProof(cf.request, zone.id, proof);
    expect(cf.records[proofHost][0]).toEqual(previous);
    cf.records[proofHost][1].content = '"' + proof + '"';
    await configureProof(cf.request, zone.id, proof);
    expect(cf.writes).toHaveLength(1);
    expect(cf.writes[0].body).toMatchObject({ type: 'TXT', name: proofHost, content: proof });
  });
});
