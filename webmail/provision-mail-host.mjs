// Provision the web hosts independently of the domain's mail delivery.
const zoneName = 'veyro.dk';
const hostnames = ['post.veyro.dk', 'konto.veyro.dk'];
const address = '31.56.4.59';
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[0-9a-f]{32}$/i.test(account || '') || !token) {
  throw new Error('Cloudflare-konto og API-token er påkrævet.');
}

async function request(path, body) {
  const response = await fetch('https://api.cloudflare.com/client/v4' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok || !data.success) {
    const codes = (data.errors || []).map(error => error.code).join(', ');
    throw new Error(`Cloudflare svarede HTTP ${response.status} (kode ${codes}).`);
  }
  return data;
}

const { result: zones } = await request(`/zones?name=${zoneName}&account.id=${account}`);
const [zone] = zones;
if (zones.length !== 1 || zone.name !== zoneName || zone.status !== 'active' ||
    zone.account?.id !== account || !/^[0-9a-f]{32}$/i.test(zone.id)) {
  throw new Error('Den aktive Cloudflare-zone for veyro.dk kunne ikke bekræftes på kontoen.');
}

const recordsPath = `/zones/${zone.id}/dns_records`;
async function checkRecord(hostname) {
  const { result, result_info } = await request(`${recordsPath}?name.exact=${hostname}&per_page=100`);
  if (result_info?.total_count !== result.length || result.some(record => record.name !== hostname)) {
    throw new Error('Cloudflare returnerede en uventet liste over DNS-poster.');
  }
  if (result.length === 0) return false;
  const [record] = result;
  if (result.length !== 1 || record.type !== 'A' || record.content !== address || record.proxied !== false) {
    throw new Error(`Der findes allerede en anden DNS-post på ${hostname}. Kontrollér posten i Cloudflare.`);
  }
  return true;
}

for (const hostname of hostnames) {
  if (!(await checkRecord(hostname))) {
    await request(recordsPath, { type: 'A', name: hostname, content: address, proxied: false, ttl: 300 });
    if (!(await checkRecord(hostname))) throw new Error('Den oprettede A-post kunne ikke genfindes.');
  }
  console.log(`Bekræftet i Cloudflare: ${hostname} A ${address}, DNS only.`);
}
