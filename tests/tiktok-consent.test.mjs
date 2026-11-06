import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {describe,it,expect} from 'vitest';
const code=readFileSync(new URL('../site/theme/assets/tiktok.js',import.meta.url),'utf8');
function fixture({host='veyro.dk',path='/',record=null,gpc=false}={}){let stored=record;const events={},scripts=[],requests=[];const c={crypto:webcrypto,URLSearchParams,AbortController,fetch:(url,options)=>{requests.push({url,options});return Promise.resolve({ok:true});},location:{hostname:host,pathname:path,search:'?email=private&ttclid=valid-click'},navigator:{globalPrivacyControl:gpc},localStorage:{getItem:()=>JSON.stringify(stored)},setTimeout:()=>1,clearTimeout:()=>{},document:{cookie:'',hidden:false,createElement:()=>({}),head:{appendChild:s=>scripts.push(s)},addEventListener:(k,v)=>events[k]=v},addEventListener:(k,v)=>events[k]=v};c.window=c;vm.runInNewContext(code,c);return {c,scripts,requests,events,set:r=>stored=r};}
const consent=(tiktok=true)=>({v:2,t:Date.now(),consent:{marketing:true,tiktok}});
describe('TikTok consent boundary',()=>{
it.each([null,consent(false),{v:2,t:Date.now(),consent:{marketing:true}}])('never fetches the SDK without fresh TikTok consent %j',record=>expect(fixture({record}).scripts).toHaveLength(0));
it.each(['veyro.se','ny.veyro.dk','kunde.veyro.dk','localhost'])('does not run on %s',host=>expect(fixture({host,record:consent()}).scripts).toHaveLength(0));
it.each(['/cart','/login','/demo/lervaerk/'])('does not run on %s',path=>expect(fixture({path,record:consent()}).scripts).toHaveLength(0));
it('respects privacy signal and expired choice',()=>{expect(fixture({record:consent(),gpc:true}).scripts).toHaveLength(0);expect(fixture({record:{...consent(),t:0}}).scripts).toHaveLength(0)});
it('loads once after consent, records one page, then revokes on withdrawal',()=>{const f=fixture();f.set(consent());f.events['theme:consent']();f.events['theme:consent']();expect(f.scripts).toHaveLength(1);expect(f.scripts[0].src).toContain('DBMMVK3C77UDLIGRBECG');const tracked=f.c.ttq.filter(x=>x[0]==='track');expect(tracked).toHaveLength(1);expect(tracked[0][1]).toBe('Pageview');expect(f.requests).toHaveLength(1);const body=JSON.parse(f.requests[0].options.body);expect(body.eventId).toBe(tracked[0][3].event_id);expect(body.ttclid).toBe('valid-click');expect(f.requests[0].options.body).not.toContain('private');expect(f.c.ttq[0][0]).toBe('holdConsent');f.set(null);f.events['theme:consent']();expect(f.c.ttq.at(-2)[0]).toBe('revokeConsent');expect(f.c.ttq.at(-1)[0]).toBe('disableCookie');expect(f.requests[0].options.signal.aborted).toBe(true);f.set(consent());f.events['theme:consent']();expect(f.requests).toHaveLength(1);});
});
