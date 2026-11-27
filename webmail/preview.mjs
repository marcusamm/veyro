// Local visual fixture. No mailbox credentials, outbound mail or production writes.
import {createServer} from 'node:http';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const here = fileURLToPath(new URL('.', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'veyro-mail-preview-'));
const bundle = join(temporary, 'gateway.mjs');
await build({entryPoints:[join(here, 'worker.ts')], outfile:bundle, bundle:true, platform:'node', format:'esm', logLevel:'silent'});
const {default:gateway, messageFramePolicy} = await import(pathToFileURL(bundle));
const port = 58901, origin = `http://127.0.0.1:${port}`;
const mime = {html:'text/html; charset=utf-8', js:'text/javascript; charset=utf-8', css:'text/css; charset=utf-8', svg:'image/svg+xml', woff2:'font/woff2'};
const folders = [{id:'inbox',name:'Indbakke',role:'inbox',unread:1}];
const assets = {async fetch(request) {
  const name = new URL(request.url).pathname.slice(1);
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) return new Response('', {status:404});
  try { return new Response(await readFile(join(here, 'assets', name)), {headers:{'Content-Type':mime[name.split('.').pop()] || 'application/octet-stream'}}); }
  catch { return new Response('', {status:404}); }
}};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    let result;
    if (url.pathname.startsWith('/api/')) {
      const {newsletter} = await import('./fixtures/rich-newsletter.mjs');
      const item = {id:'1.2',from:'Nord Studio <nyheder@example.test>',to:'test@veyro.dk',subject:'Nyt fra studiet',date:'2026-11-27T12:00:00Z',unread:false,labels:[],attachments:[],...newsletter};
      const data = url.pathname === '/api/session' ? {email:'test@veyro.dk',csrfToken:'local-preview',canManageRecovery:false,canManageOrganizations:false}
        : url.pathname === '/api/folders' ? {folders}
        : url.pathname === '/api/messages' ? {messages:[{...item,html:undefined,text:'Et fiktivt nyhedsbrev med billeder og original opsætning.'}],nextCursor:null,availableLabels:[]}
        : url.pathname === '/api/messages/' + item.id ? item : null;
      result = Response.json(data || {error:'Kun lokal testvisning.'}, {status:data ? 200 : 404,headers:{'Cache-Control':'no-store'}});
    } else {
      result = await gateway.fetch(new Request('https://mail.veyro.dk' + url.pathname + url.search), {WEBMAIL_ENABLED:'1',ASSETS:assets});
      if (url.pathname === '/message-frame') result.headers.set('Content-Security-Policy', messageFramePolicy(url.searchParams.get('images') === '1', origin));
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch(error) { response.writeHead(500); response.end(String(error)); }
});
server.listen(port, '127.0.0.1', () => console.log(`Veyro Mail — fiktiv testvisning: ${origin}`));
async function stop() { server.close(); await rm(temporary,{recursive:true,force:true}); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
