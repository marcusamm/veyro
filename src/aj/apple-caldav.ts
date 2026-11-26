import { appleEventWindows } from './apple-event-windows';

// Server-only CalDAV. All outbound methods are read-only; there is no event-title request,
// raw response logging, persistence, or scheduling POST. See RFC 4791 §§7.9–7.10 and RFC 3744 §5.4.
export interface AppleAuth { username:string; appSpecificPassword:string }
export type AppleBusyResult = {status:'ok';busy:{start:string;end:string}[]}|{status:'unknown';reason:string};
type Fetcher=typeof fetch;
type Pair=[number,number];
const DAV='DAV:', CS='http://calendarserver.org/ns/', CAL='urn:ietf:params:xml:ns:caldav', BASE='https://caldav.icloud.com/';
const NS='xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"';
const LIMIT=384*1024, SECONDS=1000;
const reject = (reason='unsupported-response'):never=>{throw new Error(reason)};
const reasons=new Set(['unsupported-response','invalid-collection','invalid-credentials','invalid-range','unauthorized','transport-error','report-unavailable','limited-read-access','calendar-too-large','calendar-changed']);
const reason=(e:unknown)=>e instanceof Error && reasons.has(e.message)?e.message:'transport-error';
const utc=(n:number)=>new Date(n).toISOString();
const fmt=(n:number)=>utc(n).replace(/[-:]/g,'').replace('.000Z','Z');
function instant(s:string):number{
 if(typeof s!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.000)?Z$/.test(s))reject('invalid-range');
 const n=Date.parse(s);if(!Number.isFinite(n)||utc(n).replace('.000Z','Z')!==s.replace('.000Z','Z'))reject('invalid-range');return n;
}
function date(s:string):number{
 const m=/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/.exec(s);
 if(!m)return reject();try{return instant(m[1]+'-'+m[2]+'-'+m[3]+'T'+m[4]+':'+m[5]+':'+m[6]+'Z')}catch{return reject()}
}
function duration(s:string):number{
 const w=/^\+?P(\d+)W$/.exec(s),d=/^\+?P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
 if(!w&&(!d||/[PT]$/.test(s)))return reject();
 const n=SECONDS*(w?Number(w[1])*604800:Number(d![1]||0)*86400+Number(d![2]||0)*3600+Number(d![3]||0)*60+Number(d![4]||0));
 return Number.isSafeInteger(n)&&n>0?n:reject();
}
function merge(intervals:Pair[],a:number,b:number):AppleBusyResult{
 const out:Pair[]=[];for(const [x,y] of intervals.sort((p,q)=>p[0]-q[0])){if(!Number.isSafeInteger(x)||!Number.isSafeInteger(y)||y<=x)reject(); if(y<=a||x>=b)continue;const l=Math.max(a,x),r=Math.min(b,y),last=out.at(-1);if(last&&last[1]>=l)last[1]=Math.max(last[1],r);else out.push([l,r]);}
 return {status:'ok',busy:out.map(([x,y])=>({start:utc(x),end:utc(y)}))};
}
function url(raw:string,base?:string):string{
 let u:URL;try{u=base?new URL(raw,base):new URL(raw)}catch{return reject('invalid-collection')}
 if(typeof raw!=='string'||!raw||raw.length>2048||/[\s\\\x00-\x1f]/.test(raw)||/%(?:2f|5c|00)/i.test(raw)||u.protocol!=='https:'||!/^(?:p\d+-)?caldav\.icloud\.com$/.test(u.hostname)||u.port||u.username||u.password||u.search||u.hash)return reject('invalid-collection');
 return u.href;
}
// Generic/partition aliases occur in the same authenticated iCloud response. Pin aliases to
// the request origin for comparisons; never combine two non-generic Apple shard hosts.
function appleHref(raw:string,base:string,pin=true):string{
 const got=new URL(url(raw,base)), at=new URL(base);if(got.origin===at.origin)return got.href;
 if(got.hostname!=='caldav.icloud.com'&&at.hostname!=='caldav.icloud.com')return reject('invalid-collection');
 return (pin||got.hostname==='caldav.icloud.com')?at.origin+got.pathname:got.href;
}
async function body(r:Response):Promise<string>{
 if(Number(r.headers.get('content-length'))>LIMIT||!r.body)return reject();
 const stream=r.body.getReader(), chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {done,value}=await stream.read();if(done)break;total+=value.length;if(total>LIMIT){await stream.cancel();reject()}chunks.push(value)}}finally{stream.releaseLock()}
 const bytes=new Uint8Array(total);let n=0;for(const c of chunks){bytes.set(c,n);n+=c.length}
 return new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes);
}
function transport(auth:AppleAuth,fetcher:Fetcher){
 if(!auth||typeof auth.username!=='string'||!auth.username||/[:\x00-\x1f\x7f]/.test(auth.username)||typeof auth.appSpecificPassword!=='string'||!auth.appSpecificPassword||/[\x00-\x1f\x7f]/.test(auth.appSpecificPassword)||auth.username.length+auth.appSpecificPassword.length>1024)reject('invalid-credentials');
 const basic=btoa(String.fromCharCode(...new TextEncoder().encode(auth.username+':'+auth.appSpecificPassword)));
 const signal=AbortSignal.timeout(14000);
 return async (where:string,method:'PROPFIND'|'REPORT',depth:0|1|undefined,xml:string)=>{
  let target=url(where);for(let hop=0;hop<=2;hop++){
   const r=await fetcher(target,{method,signal,redirect:'manual',cache:'no-store',headers:{Authorization:'Basic '+basic,...(depth===undefined?{}:{Depth:String(depth)}),Accept:'application/xml, text/xml, text/calendar','Content-Type':'application/xml; charset=utf-8'},body:'<?xml version="1.0" encoding="utf-8"?>'+xml});
   if([301,302,307,308].includes(r.status)){const loc=r.headers.get('location');if(!loc||method!=='PROPFIND'||hop===2)reject('transport-error');const next=new URL(url(loc!,target)),previous=new URL(target);if(next.hostname!==previous.hostname && previous.hostname!=='caldav.icloud.com' && next.hostname!=='caldav.icloud.com')reject('invalid-collection');if(where!==BASE && next.pathname.replace(/\/$/,'')!==previous.pathname.replace(/\/$/,''))reject('invalid-collection');target=next.href;continue;}
   if(r.status===401)reject('unauthorized');return {r,target};
  }return reject('transport-error');
 };
}
// Small bounded XML reader for DAV multistatus trees. Names match by namespace URI,
// not prefix; DTD, external entities, processing instructions and excess depth are rejected.
type X={uri:string;name:string;kids:X[];text:string;attrs:Record<string,string>};
function xmlText(s:string):string{
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s))reject();
 return s.replace(/&([^;]*);|&/g,(_raw,k:string|undefined)=>{
  if(!k)return reject();const t:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(t,k))return t[k]!;
  if(!/^#(?:[0-9]+|x[\dA-Fa-f]+)$/.test(k))return reject();
  const n=k.startsWith('#x')?parseInt(k.slice(2),16):Number(k.slice(1));return (n===9||n===10||n===13||n>=32&&n<=0xd7ff||n>=0xe000&&n<=0xfffd||n>=65536&&n<=0x10ffff)?String.fromCodePoint(n):reject();
 });
}
function tree(s:string):X{
 let i=0,nodes=0,root:X|undefined;const stack:{tag:string;ns:Map<string,string>;x:X}[]=[];
 const tag=/<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
 const skip=(n:number,end:string)=>{const j=s.indexOf(end,i+n);if(j<0)reject();const v=s.slice(i+n,j);i=j+end.length;return v};
 const put=(v:string)=>{const p=stack.at(-1);if(!p){if(v.trim())reject()}else p.x.text+=v};
 if(s.startsWith('<?xml'))skip(5,'?>');
 while(i<s.length){
  if(s[i]!=='<'){const e=s.indexOf('<',i),j=e<0?s.length:e;put(xmlText(s.slice(i,j)));i=j;continue}
  if(s.startsWith('<!--',i)){if(skip(4,'-->').includes('--'))reject();continue}
  if(s.startsWith('<![CDATA[',i)){if(!stack.length)reject();put(skip(9,']]>'));continue}
  if(s.startsWith('</',i)){const q=skip(2,'>').trimEnd();if(stack.pop()?.tag!==q)reject();continue}
  tag.lastIndex=i;const m=tag.exec(s);if(!m||++nodes>12000||stack.length>28)return reject();i=tag.lastIndex;
  const parent=stack.at(-1), ns=new Map(parent?.ns||[['xml','http://www.w3.org/XML/1998/namespace']]),attrs:Record<string,string>=Object.create(null);
  for(const a of m[2]!.matchAll(/\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)){const k=a[1]!,v=xmlText(a[2]??a[3]??'');if(Object.hasOwn(attrs,k)||Object.keys(attrs).length>32)reject();attrs[k]=v;if(k==='xmlns')ns.set('',v);else if(k.startsWith('xmlns:'))ns.set(k.slice(6),v)}
  const q=m[1]!,parts=q.split(':'),prefix=parts.length===2?parts[0]!:'',uri=ns.get(prefix);if(prefix&&!uri)reject();const x:X={uri:uri||'',name:parts.at(-1)!,kids:[],text:'',attrs};if(parent)parent.x.kids.push(x);else{if(root)reject();root=x}
  if(!m[3])stack.push({tag:q,ns,x});
 }
 if(!root||stack.length)return reject();return root;
}
const xs=(x:X,uri:string,name:string)=>x.kids.filter(t=>t.uri===uri&&t.name===name);
function only(xs:X[]):X{return xs.length===1?xs[0]!:reject()}
const one=(x:X,uri:string,name:string)=>only(xs(x,uri,name));
const text=(x:X)=>x.kids.length?reject():x.text.trim();
const status=(x:X)=>{const m=/^HTTP\/\d+(?:\.\d+)?\s+([1-5]\d\d)(?:\s|$)/i.exec(text(x));return m?Number(m[1]):reject()};
const propBody=(p:string)=>'<D:propfind '+NS+'><D:prop>'+p+'</D:prop></D:propfind>';
type Transport=ReturnType<typeof transport>;
async function responses(r:Response){
 if(r.status===403)reject('unauthorized');if(r.status!==207)reject('report-unavailable');
 const mime=r.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();if(mime!=='text/xml'&&mime!=='application/xml')reject();
 const root=tree(await body(r));if(root.uri!==DAV||root.name!=='multistatus'||root.kids.some(x=>x.uri!==DAV||!['response','responsedescription'].includes(x.name)))reject();
 const rows=xs(root,DAV,'response');if(rows.length>1500)reject();return rows;
}
function props(row:X,strict=false):X[]{
 if(xs(row,DAV,'status').length||xs(row,DAV,'error').length)reject();const ps=xs(row,DAV,'propstat');if(!ps.length)reject();
 return ps.flatMap(s=>{const code=status(one(s,DAV,'status'));if(code!==200){if(strict||code!==404)reject();return []}return one(s,DAV,'prop').kids});
}
const prop=(p:X[],ns:string,n:string)=>only(p.filter(x=>x.uri===ns&&x.name===n));
async function getHref(t:Transport,base:string,p:string,uri:string,name:string){
 const {r,target}=await t(base,'PROPFIND',0,propBody(p));const pr=props(only(await responses(r)));return appleHref(text(one(prop(pr,uri,name),DAV,'href')),target,false);
}
export async function discoverAppleCalendars(auth:AppleAuth, fetchImpl:Fetcher=fetch):Promise<{url:string;name:string}[]>{
 try{
  const t=transport(auth,fetchImpl), principal=await getHref(t,BASE,'<D:current-user-principal/>',DAV,'current-user-principal'),home=await getHref(t,principal,'<C:calendar-home-set/>',CAL,'calendar-home-set');
  const {r,target}=await t(home,'PROPFIND',1,propBody('<D:resourcetype/><D:displayname/><C:supported-calendar-component-set/><cs:source xmlns:cs="http://calendarserver.org/ns/"/>'));
  const all=await responses(r);if(all.length>150)reject();const found=new Map<string,string>();
  for(const row of all){const p=props(row),type=prop(p,DAV,'resourcetype');if(!xs(type,CAL,'calendar').length||xs(type,CS,'subscribed').length||xs(type,CS,'source').length||p.some(x=>x.uri===CS&&x.name==='source'))continue;const set=p.filter(x=>x.uri===CAL&&x.name==='supported-calendar-component-set');if(set.length&& !xs(only(set),CAL,'comp').some(c=>c.attrs.name?.toUpperCase()==='VEVENT'))continue;
   const addr=appleHref(text(one(row,DAV,'href')),target),dn=p.filter(x=>x.uri===DAV&&x.name==='displayname');if(!related(addr,target)||found.has(addr))reject();found.set(addr,(dn.length?text(only(dn)):'').replace(/[\x00-\x1f\x7f]/g,' ').slice(0,160).trim()||'Kalender');
  }return [...found].map(([url,name])=>({url,name}));
 }catch(e){throw Error(reason(e))}
}
type Field={name:string;key:string;val:string};
function fields(s:string):Field[]{
 if(s.length>LIMIT||/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(s))reject();const lines=s.replace(/\r\n/g,'\n').replace(/\n[ \t]/g,'').trimEnd().split('\n');if(lines.length>18000)reject();
 return lines.map(line=>{const i=line.indexOf(':');if(i<1||line.includes('\r'))return reject();const key=line.slice(0,i).toUpperCase(),name=key.split(';')[0]!;if(!/^[A-Z\d-]+$/.test(name))reject();return{name,key,val:line.slice(i+1)}});
}
function components(s:string,kind:'VEVENT'|'VFREEBUSY'):Field[][]{
 const f=fields(s);const begin=f.shift(),end=f.pop();if(begin?.key!=='BEGIN'||begin.val.toUpperCase()!=='VCALENDAR'||end?.key!=='END'||end.val.toUpperCase()!=='VCALENDAR')reject();
 let version=false,prod=false,inside:Field[]|undefined;const out:Field[][]=[];
 for(const x of f){const val=x.val.toUpperCase();if(x.name==='BEGIN'){if(inside||x.key!=='BEGIN'||val!==kind)reject();inside=[];continue}
 if(x.name==='END'){if(!inside||x.key!=='END'||val!==kind)return reject();out.push(inside);inside=undefined;continue}
 if(inside){inside.push(x);continue}
 if(x.key==='VERSION'&&x.val==='2.0'&&!version)version=true;else if(x.key==='PRODID'&&x.val.trim()&&!prod)prod=true;else if((x.key==='CALSCALE'&&val==='GREGORIAN')||(x.key==='METHOD'&&(val==='REPLY'||val==='PUBLISH'))||x.name.startsWith('X-'))continue;else reject();
 }
 if(inside||!version||!out.length||(kind==='VFREEBUSY'&&!prod))reject();return out;
}
function freebusy(s:string,a:number,b:number):AppleBusyResult{
 const comp=components(s,'VFREEBUSY');if(comp.length!==1)reject();const fields=comp[0]!,ints:Pair[]=[];let lo:number|undefined,hi:number|undefined,uid=false,stamp=false;
 for(const f of fields){const {name,key,val}=f;if(key==='DTSTART'&&lo===undefined)lo=date(val);else if(key==='DTEND'&&hi===undefined)hi=date(val);
 else if(key==='UID'&&!uid&&val.trim())uid=true;else if(key==='DTSTAMP'&&!stamp){date(val);stamp=true}
 else if(name==='FREEBUSY'){
  if(!/^FREEBUSY(?:;FBTYPE=(?:BUSY|BUSY-TENTATIVE|BUSY-UNAVAILABLE|FREE))?$/.test(key))reject();
  for(const period of val.split(',')){const p=period.split('/');if(p.length!==2)reject();const x=date(p[0]!),ev=p[1]!,y=/^\+?P/.test(ev)?x+duration(ev):date(ev);if(!(y>x)||!Number.isSafeInteger(y))reject();if(!key.endsWith('=FREE'))ints.push([x,y])}
 }else if(!['ATTENDEE','ORGANIZER','COMMENT','CONTACT','URL'].includes(name)&&!name.startsWith('X-'))reject();
 }
 if(!uid||!stamp||lo===undefined||hi===undefined||lo>a||hi<b)reject();return merge(ints,a,b);
}
const MAX_EVENTS=160, BATCH=20;
const clean=(val:string)=>val.replace(/\/$/,'');
const escaping=(val:string)=>val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const strong=(s:string)=>/^"[^"\s\x00-\x1f]{1,250}"$/.test(s)?s:reject();
const project=(n:string[])=>n.map(k=>'<C:prop name="'+k+'"/>').join('');
const zoneProjection='<C:comp name="VTIMEZONE">'+project(['TZID','X-LIC-LOCATION'])+['STANDARD','DAYLIGHT'].map(k=>'<C:comp name="'+k+'">'+project(['DTSTART','RRULE','RDATE','TZOFFSETFROM','TZOFFSETTO','TZNAME'])+'</C:comp>').join('')+'</C:comp>';
const projection='<C:calendar-data><C:comp name="VCALENDAR">'+project(['VERSION','PRODID','CALSCALE','METHOD','X-WR-TIMEZONE'])+'<C:comp name="VEVENT">'+project(['UID','DTSTAMP','SEQUENCE','LAST-MODIFIED','DTSTART','DTEND','DURATION','TRANSP','STATUS','RECURRENCE-ID','RRULE','RDATE','EXDATE','EXRULE'])+'</C:comp>'+zoneProjection+'</C:comp></C:calendar-data>';
function hrefOf(row:X,target:string,scope=target){return appleHref(appleHref(text(one(row,DAV,'href')),target),scope)}
function related(href:string,where:string){const x=new URL(href),base=new URL(where),prefix=clean(base.pathname)+'/';return x.origin===base.origin&&x.pathname.startsWith(prefix)&&!!clean(x.pathname).slice(prefix.length)&&!clean(x.pathname).slice(prefix.length).includes('/')}
async function inventory(t:Transport,where:string):Promise<Map<string,string>>{
 const {r,target}=await t(where,'PROPFIND',1,propBody('<D:resourcetype/><D:getetag/>'));const rows=await responses(r);if(rows.length>MAX_EVENTS+1)reject('calendar-too-large');
 let self=false;const map=new Map<string,string>();
 for(const row of rows){const href=hrefOf(row,target,where),p=props(row),type=prop(p,DAV,'resourcetype');
  if(clean(href)===clean(where)){if(self||!xs(type,CAL,'calendar').length)reject();self=true;continue}
  if(!related(href,where)||type.kids.length||map.has(href))reject();
  map.set(href,strong(text(prop(p,DAV,'getetag'))));
 }
 if(!self)reject();return map;
}
function maybeZone(p:X[]):string|undefined{
 const read=(name:string)=>{const a=p.filter(x=>x.uri===CAL&&x.name===name);return a.length?text(only(a)):undefined};
 let zone=read('calendar-timezone-id');if(!zone){const raw=read('calendar-timezone');if(raw){const ids=fields(raw).filter(f=>f.key==='TZID').map(f=>f.val);if(ids.length===1)zone=ids[0];}}
 if(!zone||zone.length>100||!/^[A-Za-z0-9_+./-]+$/.test(zone))return undefined;
 try{new Intl.DateTimeFormat('en',{timeZone:zone});return zone}catch{return undefined}
}
// iCloud historically rejects free-busy REPORT and can omit implicit occurrences in even a
// correctly scoped time-range query. Inventory every directly contained resource with no time filter;
// then fetch *only temporal semantics* by multiget. Any ambiguity aborts the whole calendar.
async function eventFallback(t:Transport,where:string,a:number,b:number){
 const access=await t(where,'PROPFIND',0,propBody('<D:current-user-privilege-set/><C:calendar-timezone/><C:calendar-timezone-id/>'));
 const ar=only(await responses(access.r));if(clean(hrefOf(ar,access.target,where))!==clean(where))reject('limited-read-access');
 const ap=props(ar), privileges=prop(ap,DAV,'current-user-privilege-set');if(!xs(privileges,DAV,'privilege').some(p=>xs(p,DAV,'read').length||xs(p,DAV,'all').length))reject('limited-read-access');
 const zone=maybeZone(ap), listed=await inventory(t,where), hrefs=Array.from(listed.keys()), allICS:string[]=[];
 for(let i=0;i<hrefs.length;i+=BATCH){
  const wanted=new Set(hrefs.slice(i,i+BATCH)), hs=[...wanted].map(href=>'<D:href>'+escaping(new URL(href).pathname)+'</D:href>').join('');
  const {r,target}=await t(where,'REPORT',undefined,'<C:calendar-multiget '+NS+'><D:prop><D:getetag/>'+projection+'</D:prop>'+hs+'</C:calendar-multiget>');
  const rows=await responses(r);if(rows.length!==wanted.size)reject('calendar-changed');
  for(const row of rows){const href=hrefOf(row,target,where);if(!wanted.delete(href))reject();const p=props(row,true);
   if(strong(text(prop(p,DAV,'getetag')))!==listed.get(href))reject('calendar-changed');const ics=text(prop(p,CAL,'calendar-data'));
   if(!ics||ics.length>LIMIT)reject();allICS.push(ics);
  }if(wanted.size)reject('calendar-changed');
 }
 // Catch insertions/deletions and revisions during batched reads, including moved exceptions.
 if(hrefs.length){const after=await inventory(t,where);if(after.size!==listed.size||hrefs.some(h=>after.get(h)!==listed.get(h)))reject('calendar-changed')}
 try {const intervals=appleEventWindows(allICS,a/SECONDS,b/SECONDS,zone);return merge(intervals.map(x=>[x.start*SECONDS,x.end*SECONDS] as Pair),a,b)}catch{return reject()}
}
export async function readAppleBusy(opts: AppleAuth & {collectionUrl:string;start:string;end:string;fetchImpl?:Fetcher}):Promise<AppleBusyResult>{
 try{
  const {collectionUrl,start,end,fetchImpl=fetch}=opts,where=url(collectionUrl);if(new URL(where).pathname==='/')reject('invalid-collection');
  const a=instant(start),b=instant(end);if(!(b>a)||b-a>366*86_400_000)reject('invalid-range');const t=transport(opts,fetchImpl);
  const {r}=await t(where,'REPORT',1,'<C:free-busy-query '+NS+'><C:time-range start="'+fmt(a)+'" end="'+fmt(b)+'"/></C:free-busy-query>');
  if(r.status===200){if(r.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='text/calendar')reject();return freebusy(await body(r),a,b)}
  // Refused FREEBUSY may mean unsupported REPORT or missing privileges. Never derive free time from
  // the rejection; fallback performs a new successful privilege check, complete inventory and projected multigets.
  if([400,403,405,501].includes(r.status))return await eventFallback(t,where,a,b);
  return reject('report-unavailable');
 }catch(e){return {status:'unknown',reason:reason(e)}}
}
