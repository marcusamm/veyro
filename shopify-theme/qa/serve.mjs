import http from 'http'; import fs from 'fs'; import path from 'path';
const OUT=process.argv[2];
const map={'/':'index','/pages/ydelser':'ydelser','/pages/website-optimering':'website-optimering','/pages/custom-losninger':'custom-losninger','/pages/om-os':'om-os','/pages/kontakt':'kontakt','/pages/cookiepolitik':'cookiepolitik','/pages/privatlivspolitik':'cookiepolitik'};
http.createServer((q,r)=>{const u=new URL(q.url,'http://x');let p=u.pathname;
 if(p.startsWith('/assets/')){const f=path.join(OUT,p);if(fs.existsSync(f)){r.writeHead(200,{'content-type':p.endsWith('.css')?'text/css':p.endsWith('.js')?'text/javascript':p.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});return r.end(fs.readFileSync(f));}}
 const n=map[p]||'404'; r.writeHead(map[p]?200:404,{'content-type':'text/html; charset=utf-8'}); r.end(fs.readFileSync(path.join(OUT,n+'.html')));}).listen(+process.argv[3]);
