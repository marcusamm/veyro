// Works on projected VCALENDAR payloads only. No raw fields or parser exceptions leave this module.
import ICAL from 'ical.js';
type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;
type Window = {start:number;end:number};
type Context = {root:Component; defaultZone?:string; fmts:Map<string,Intl.DateTimeFormat>};
type Span = {days:number;seconds:number};
const DAY=86400;
const fail=():never=>{throw new Error('unsupported-calendar-data')};
function valid(ok:unknown): asserts ok { if(!ok) fail(); }
const prop=(v:Component,k:string)=>{const a=v.getAllProperties(k);valid(a.length<=1);return a[0]};
function text(v:Component,k:string){const p=prop(v,k);if(!p)return '';const s=p.getFirstValue();valid(typeof s==='string'&&s.length>0);return s}
function asTime(p:Property){const t=p.getFirstValue();valid(t instanceof ICAL.Time);return t}
function naive(t:Time){return Date.UTC(t.year,t.month-1,t.day,t.hour,t.minute,t.second)/1000}
function wall(fmt:Intl.DateTimeFormat,s:number){
  const ds:Record<string,number>={};for(const p of fmt.formatToParts(new Date(s*1000))) if(p.type!=='literal') ds[p.type]=Number(p.value);
  return Date.UTC(ds.year!,ds.month!-1,ds.day!,ds.hour!,ds.minute!,ds.second!)/1000;
}
function instant(t:Time,p:Property|undefined,c:Context):number {
  const local=naive(t);valid(Number.isSafeInteger(local) && t.year>=1600&&t.year<=2300);
  const explicit=p?.getParameter('tzid');valid(!explicit||typeof explicit==='string');
  if(t.zone.tzid==='UTC' && !t.isDate && !explicit)return local;
  const tz=(explicit || (t.zone.tzid!=='floating' && !t.isDate ? t.zone.tzid : c.defaultZone)) as string|undefined;
  valid(tz && tz.length<=200);
  if(tz==='UTC'||tz==='Etc/UTC'||tz==='GMT')return local;
  const embedded=c.root.getTimeZoneByID(tz);
  if(embedded){
    const midnight=t.clone();midnight.isDate=false;midnight.zone=embedded;
    // Refuse the hours immediately adjacent to an embedded-zone offset change when
    // the local wall clock has multiple (or no) interpretations. Do not select one silently.
    const delta=midnight.utcOffset();
    for(const direction of [-1,1]){
      const near=midnight.clone();near.adjust(0,0,0,3*3600*direction);
      const nearOffset=near.utcOffset();
      if(nearOffset!==delta) {
        const shift=Math.abs(nearOffset-delta);
        const probe=midnight.clone();probe.adjust(0,0,0,shift*direction);
        valid(probe.utcOffset()===delta);
      }
    }
    return local-delta;
  }
  let fmt=c.fmts.get(tz);
  if(!fmt){valid(c.fmts.size<80);fmt=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',minute:'2-digit',second:'2-digit'});c.fmts.set(tz,fmt)}
  const offsets=new Set([wall(fmt,local-DAY)-local+DAY,wall(fmt,local+DAY)-local-DAY]);
  const hits=[...offsets].map(o=>local-o).filter(s=>wall(fmt!,s)===local);
  valid(hits.length===1);return hits[0]!;
}
function rawRule(s:string) {
  const fields:Record<string,string>={};
  for(const entry of s.toUpperCase().split(';')){const [key,x,...rest]=entry.split('=');valid(key&&x&&!rest.length&&!Object.hasOwn(fields,key));fields[key]=x}
  const freq=fields.FREQ;valid(freq && ['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(freq));
  const wd='(?:MO|TU|WE|TH|FR|SA|SU)';
  const interval=Number(fields.INTERVAL||1);valid(/^\d{1,3}$/.test(String(fields.INTERVAL||1))&&interval>=1&&interval<=365);
  if(fields.WKST)valid(new RegExp('^'+wd+'$').test(fields.WKST));
  if(fields.COUNT)valid(/^[1-9]\d{0,6}$/.test(fields.COUNT)&&!fields.UNTIL);
  if(fields.UNTIL)valid(/^\d{8}(?:T\d{6}Z?)?$/.test(fields.UNTIL));
  for (const k of Object.keys(fields))valid(['FREQ','INTERVAL','COUNT','UNTIL','WKST','BYDAY','BYMONTHDAY','BYMONTH'].includes(k));
  valid(!(fields.BYDAY&&fields.BYMONTHDAY));
  if(fields.BYDAY){
    const ds=fields.BYDAY.split(',');valid(ds.length<=7&&ds.every(d=>new RegExp('^'+(['MONTHLY','YEARLY'].includes(freq)?'(?:-?[1-4])?':'')+wd+'$').test(d)));
    if(freq==='DAILY') valid(interval===1);
    if(freq==='YEARLY') valid(!!fields.BYMONTH);
  }
  if(fields.BYMONTHDAY){valid(['MONTHLY','YEARLY'].includes(freq));
    const ds=fields.BYMONTHDAY.split(',').map(Number);valid(ds.length>0&&ds.length<=31&&ds.every(n=>Number.isInteger(n)&&n!==0&&Math.abs(n)<=31));
    if(interval>1 || (freq==='YEARLY' && !fields.BYMONTH))valid(ds.every(n=>Math.abs(n)<=28));
  }
  if(fields.BYMONTH){valid(freq==='YEARLY' && /^(?:[1-9]|1[0-2])$/.test(fields.BYMONTH));if(fields.BYMONTHDAY){const max=Number(fields.BYMONTH)===2?29:[4,6,9,11].includes(Number(fields.BYMONTH))?30:31;valid(fields.BYMONTHDAY.split(',').every(n=>Math.abs(Number(n))<=max));}}
}
function preflight(raw:string){
  const stack:string[]=[];let roots=0,steps=0;
  for(const line of raw.replace(/\r?\n[ \t]/g,'').split(/\r?\n/)){
    if(!line)continue;
    valid(++steps<=4000 && line.length<=16000);
    const i=line.indexOf(':');valid(i>0);const name=line.slice(0,i).split(';')[0]!.toUpperCase(),v=line.slice(i+1);
    if(name==='BEGIN'){if(!stack.length){roots++;valid(v.toUpperCase()==='VCALENDAR')}stack.push(v.toUpperCase());valid(stack.length<=8)}
    else if(name==='END')valid(stack.pop()===v.toUpperCase());
    else {valid(stack.length);if(name==='RRULE'){
        rawRule(v);
        if(['STANDARD','DAYLIGHT'].includes(stack.at(-1)!)) valid(v.toUpperCase().split(';').includes('FREQ=YEARLY'));
      }
      if(name==='TZOFFSETFROM'||name==='TZOFFSETTO') valid(/^[+-](?:0[0-9]|1[0-9]|2[0-3])[0-5][0-9](?:[0-5][0-9])?$/.test(v));
      if(['DTSTART','DTEND','RECURRENCE-ID','EXDATE','RDATE'].includes(name)){
        for(const atom of v.split(',')){
          const m=/^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)Z?)?$/.exec(atom);
          valid(m);
          const head=line.slice(0,i).toUpperCase();
          const kind=/(?:^|;)VALUE=([^;]+)/.exec(head)?.[1];
          valid((kind===undefined || kind==='DATE' || kind==='DATE-TIME') && (kind==='DATE' ? !m[4] : !!m[4]));
          valid(!(/;TZID=/.test(head)&&(!m[4]||atom.endsWith('Z'))));
          const [year,month,day,hour,min,sec]=m.slice(1).map(x=>Number(x||0));
          const d=new Date(Date.UTC(year!,month!-1,day!,hour!,min!,sec!));
          valid(year!>=1600&&year!<=2300&&d.getUTCFullYear()===year&&d.getUTCMonth()+1===month&&d.getUTCDate()===day&&hour!<24&&min!<60&&sec!<60);
        }
      }
    }
  }
  valid(roots===1&&stack.length===0);
}
function span(e:Component,start:Time,sp:Property,c:Context,inherit?:Span):Span {
  const end=prop(e,'dtend'),duration=prop(e,'duration');valid(!(end&&duration));
  if(end){const t=asTime(end);valid(t.isDate===start.isDate);
    if(start.isDate){const days=(naive(t)-naive(start))/DAY;valid(Number.isInteger(days)&&days>0);return {days,seconds:0}}
    const seconds=instant(t,end,c)-instant(start,sp,c);valid(seconds>0);return {days:0,seconds};
  }
  if(duration){const d=duration.getFirstValue();valid(d instanceof ICAL.Duration && !d.isNegative);
    const days=d.weeks*7+d.days,seconds=d.hours*3600+d.minutes*60+d.seconds;valid(Number.isSafeInteger(days)&&Number.isSafeInteger(seconds)&&days+seconds>0&&(!start.isDate||seconds===0));
    return {days,seconds};
  }
  return inherit??{days:start.isDate?1:0,seconds:0};
}
function active(v:Component,master?:Component):boolean{
  const tr=(text(v,'transp') || (master?text(master,'transp'):'') || 'OPAQUE').toUpperCase();
  const status=(text(v,'status') || (master?text(master,'status'):'') || 'CONFIRMED').toUpperCase();
  valid(['OPAQUE','TRANSPARENT'].includes(tr)&&['CONFIRMED','TENTATIVE','CANCELLED'].includes(status));return tr!=='TRANSPARENT'&&status!=='CANCELLED';
}
function read(resources:string[], from:number,to:number, defaultZone?:string):Window[] {
  valid(Number.isSafeInteger(from)&&Number.isSafeInteger(to)&&to>from&&to-from<=370*DAY&&resources.length<=1500);
  let size=0,budget=18000;const intervals:Window[]=[],fmt=new Map<string,Intl.DateTimeFormat>(),seen=new Set<string>();
  for(const raw of resources){
    valid(typeof raw==='string'&&(size+=raw.length)<=4*1024*1024&&raw.length<=384*1024);
    preflight(raw);const root=ICAL.Component.fromString(raw);
    valid(root.name==='vcalendar' && !root.getFirstProperty('method'));
    let items=root.getAllSubcomponents();valid(items.every(v=>v.name==='vevent'||v.name==='vtimezone')&&items.length<=256);
    const zoneNames=new Set<string>();for(const z of root.getAllSubcomponents('vtimezone')){const name=text(z,'tzid');valid(name&&!zoneNames.has(name));zoneNames.add(name);const obs=z.getAllSubcomponents();valid(obs.length>0&&obs.length<=64&&obs.every(o=>['standard','daylight'].includes(o.name)&&prop(o,'dtstart')&&prop(o,'tzoffsetfrom')&&prop(o,'tzoffsetto')))}
    const c:Context={root,defaultZone:text(root,'x-wr-timezone')||defaultZone,fmts:fmt};
    const ev=root.getAllSubcomponents('vevent');valid(ev.length>0);const groups=new Map<string,Component[]>();
    for(const e of ev){const uid=text(e,'uid');valid(uid&&uid.length<=1024&&!prop(e,'exrule'));const group=groups.get(uid)??[];group.push(e);groups.set(uid,group)}
    function add(t:Time,p:Property,d:Span,a:number){
      let end=a+d.seconds;
      if(d.days){valid(d.days<=36525);const et=t.clone();et.adjust(d.days,0,0,0);end=instant(et,p,c)+d.seconds;}
      valid(Number.isSafeInteger(end)&&end>=a);
      if(end>from&&a<to&&end>a){valid(intervals.length<10000);intervals.push({start:Math.max(from,a),end:Math.min(to,end)})}
    }
    for(const [uid,group] of groups){
      valid(!seen.has(uid));seen.add(uid);
      const masters=group.filter(e=>!prop(e,'recurrence-id'));valid(masters.length===1);
      const master=masters[0]!,sp=prop(master,'dtstart');valid(sp);
      const st=asTime(sp),base=instant(st,sp,c),duration=span(master,st,sp,c),excepts=new Set<number>(),exdates=new Set<number>();
      const rp=prop(master,'rrule'),rdates=master.getAllProperties('rdate');valid(group.length===1 || rp || rdates.length);
      for(const ex of group){
        if(ex===master)continue;
        const id=prop(ex,'recurrence-id')!;valid(!id.getParameter('range')&&!prop(ex,'rrule')&&!ex.getFirstProperty('rdate')&&!ex.getFirstProperty('exdate'));
        const original=asTime(id);valid(original.isDate===st.isDate);const key=instant(original,id,c);valid(!excepts.has(key));excepts.add(key);
        if(!active(ex,master))continue;
        const ep=prop(ex,'dtstart');valid(ep);const et=asTime(ep);valid(et.isDate===st.isDate || prop(ex,'dtend') || prop(ex,'duration'));add(et,ep,span(ex,et,ep,c,duration),instant(et,ep,c));
      }
      if(!active(master))continue;
      for(const xp of master.getAllProperties('exdate'))for(const t of xp.getValues()){valid(--budget>0&&t instanceof ICAL.Time&&t.isDate===st.isDate);exdates.add(instant(t,xp,c))}
      const seenTimes=new Set<number>();
      function occurrence(t:Time,p:Property,at:number){if(!excepts.has(at)&&!exdates.has(at)&&!seenTimes.has(at)){seenTimes.add(at);add(t,p,duration,at)}}
      occurrence(st,sp,base);
      for(const p of rdates)for(const t of p.getValues()){valid(--budget>0&&t instanceof ICAL.Time&&t.isDate===st.isDate);occurrence(t,p,instant(t,p,c))}
      if(!rp||base>=to)continue;
      const r=rp.getFirstValue();valid(r instanceof ICAL.Recur);
      if(r.freq==='YEARLY' && r.parts.BYMONTH && !r.parts.BYMONTHDAY && !r.parts.BYDAY) valid(st.day<=28 || r.parts.BYMONTH[0]===st.month);
      const until=r.until;let limit=to;
      if(until){valid(until.isDate===st.isDate);const cutoff=instant(until,until.zone.tzid==='UTC'?undefined:sp,c);limit=Math.min(limit,cutoff+1)}
      // Compute UNTIL against the actual timezone (ical.js may represent an external IANA TZID as floating).
      const rule=r.clone();rule.until=null;const iter=rule.iterator(st);let prior=-Infinity;
      for(;;){
        valid(--budget>0);const t=iter.next();if(!t)break;
        const a=instant(t,sp,c);valid(a>prior);prior=a;if(a>=limit)break;occurrence(t,sp,a);
      }
    }
  }
  const out:Window[]=[];for(const w of intervals.sort((a,b)=>a.start-b.start)){const last=out.at(-1);if(last&&w.start<=last.end)last.end=Math.max(last.end,w.end);else out.push(w)}
  return out;
}
/** Unix-second half-open windows; throw on incomplete/unsupported content, never return false-free on parse error. */
export function appleEventWindows(resources:string[],from:number,to:number,defaultTimezone?:string):Window[]{
  try{return read(resources,from,to,defaultTimezone)}catch{throw new Error('unsupported-calendar-data')}
}
