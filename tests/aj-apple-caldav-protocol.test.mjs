import {describe,it,expect} from 'vitest';
import {discoverAppleCalendars, readAppleBusy} from '../src/aj/apple-caldav.ts';
const host='https://p32-caldav.icloud.com',base='/abc/calendars/',col=base+'work/',obj=col+'event.ics';
const auth={username:'someone@example.invalid',appSpecificPassword:'not-an-apple-password'};
const args={...auth,collectionUrl:host+col,start:'2026-11-25T10:00:00Z',end:'2026-11-25T12:00:00Z'};
const text=(s,status=207,mime='application/xml; charset=utf-8')=>new Response(s,{status,headers:{'Content-Type':mime}});
const ms=s=>text('<multistatus xmlns="DAV:" xmlns:x="urn:ietf:params:xml:ns:caldav">'+s+'</multistatus>');
const row=(href,pr,status=200)=>'<response><href>'+href+'</href><propstat><prop>'+pr+'</prop><status>HTTP/1.1 '+status+' Status</status></propstat></response>';
const access=(priv='read')=>ms(row(col,'<current-user-privilege-set><privilege><'+priv+'/></privilege></current-user-privilege-set><x:calendar-timezone-id>Europe/Copenhagen</x:calendar-timezone-id>'));
const item=(h=obj,v='v1')=>row(h,'<resourcetype/><getetag>"'+v+'"</getetag>');
const inv=(s=item())=>ms(row(col,'<resourcetype><collection/><x:calendar/></resourcetype>')+s);
const ical=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//test//EN','BEGIN:VEVENT','UID:test-recurring','DTSTAMP:20261001T120000Z','DTSTART:20261118T110000Z','DTEND:20261118T113000Z','RRULE:FREQ=WEEKLY;COUNT=3','END:VEVENT','END:VCALENDAR'].join('\r\n');
const objRow=(s=ical,v='v1',href=obj)=>row(href,'<getetag>"'+v+'"</getetag><x:calendar-data><![CDATA['+s+']]></x:calendar-data>');
const fb=(extra='')=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//fixture//EN','BEGIN:VFREEBUSY','UID:test','DTSTAMP:20261001T120000Z','DTSTART:20261125T100000Z','DTEND:20261125T120000Z',...(extra?[extra]:[]),'END:VFREEBUSY','END:VCALENDAR'].join('\r\n');
function mock(responses, callbacks=[]){let n=0;return {get n(){return n},fetchImpl:async(url,init)=>{const i=n++;expect(init.redirect).toBe('manual');expect(['PROPFIND','REPORT']).toContain(init.method);expect(init.headers.Authorization).toMatch(/^Basic /);callbacks[i]?.(url,init);if(!responses[i])throw Error('unexpected network request');return responses[i]}}}
const denied=()=>text('',400);
const read=mock=>readAppleBusy({...args,fetchImpl:mock.fetchImpl});
describe('Apple read-only DAV protocol',()=>{
 it('discovers the authenticated calendar principal/home, filters non-event calendars, resolves shard, decodes names',async()=>{
 const m=mock([text('',301),ms(row('/','<current-user-principal><href>/abc/principal/</href></current-user-principal>')),ms(row('/abc/principal/','<x:calendar-home-set><href>'+base+'</href></x:calendar-home-set>')),ms(row(base,'<resourcetype><collection/></resourcetype>')+row(col,'<resourcetype><collection/><x:calendar/></resourcetype><displayname>Værksted &amp; bil</displayname><x:supported-calendar-component-set><x:comp name="VEVENT"/></x:supported-calendar-component-set>')+row(base+'tasks/','<resourcetype><x:calendar/></resourcetype><x:supported-calendar-component-set><x:comp name="VTODO"/></x:supported-calendar-component-set>'))]);
 // Replace anonymous fixture with real Location header (only a trusted Apple shard).
 const fetchImpl=async(u,i)=>{const v=await m.fetchImpl(u,i);return v.status===301?new Response(null,{status:301,headers:{Location:host+'/'}}):v};
 await expect(discoverAppleCalendars(auth,fetchImpl)).resolves.toEqual([{url:host+col,name:'Værksted & bil'}]);expect(m.n).toBe(4);
 });
 it('never sends credentials to untrusted redirects or hrefs and sanitises exceptions',async()=>{let calls=0;await expect(discoverAppleCalendars(auth,async()=>{calls++;return new Response(null,{status:307,headers:{Location:'https://caldav.icloud.com.example.invalid/path/'}})})).rejects.toThrow('invalid-collection');expect(calls).toBe(1);
 const r=await readAppleBusy({...args,collectionUrl:'https://wrong.invalid/path',fetchImpl:async()=>{throw Error(auth.appSpecificPassword)}});expect(r).toEqual({status:'unknown',reason:'invalid-collection'});
 const original=await read(mock([text('',401)]));expect(original).toEqual({status:'unknown',reason:'unauthorized'});
 });
 it('rejects a different numbered partition, ignores subscribed even when also marked a VEVENT calendar',async()=>{
 const p=ms(row('/','<current-user-principal><href>'+host+'/abc/principal/</href></current-user-principal>'));
 const h=ms(row('/abc/principal/','<x:calendar-home-set><href>'+base+'</href></x:calendar-home-set>'));
 const ds=ms(row(col,'<resourcetype><x:calendar/><s:subscribed xmlns:s="http://calendarserver.org/ns/"/></resourcetype>'));
 const d=await discoverAppleCalendars(auth,mock([p,h,ds]).fetchImpl);expect(d).toEqual([]);
 const r=await read(mock([denied(),access(),inv(),ms(objRow(ical,'v1','https://p11-caldav.icloud.com'+obj))]));
 expect(r).toEqual({status:'unknown',reason:'invalid-collection'});
 });
 it('honors a complete server VFREEBUSY, clips/unions folded busy types; never interprets a malformed freebusy as empty',async()=>{
 const s=fb('FREEBUSY:20261125T093000Z/PT1H,\r\n 20261125T101500Z/PT45M\r\nFREEBUSY;FBTYPE=FREE:20261125T110000Z/PT1H');
 expect(await read(mock([text(s,200,'text/calendar')]))).toEqual({status:'ok',busy:[{start:'2026-11-25T10:00:00.000Z',end:'2026-11-25T11:00:00.000Z'}]});
 for(const s of [fb().replace('20261125T120000Z','20261125T110000Z'),fb('FREEBUSY;FBTYPE=X-CUSTOM:20261125T110000Z/PT1H'),fb().replace('DTSTAMP:20261001T120000Z','DTSTAMP:not-a-date')])expect((await read(mock([text(s,200,'text/calendar')]))).status).toBe('unknown');
 });
 it('falls back from actual iCloud 400 to full inventory, temporal multiget and local recurrence expansion',async()=>{
 let projected='';const m=mock([denied(),access(),inv(),ms(objRow(ical,'v1','https://caldav.icloud.com'+obj)),inv()],[null,null,(url,opt)=>{expect(opt.method).toBe('PROPFIND');expect(opt.headers.Depth).toBe('1')},(url,opt)=>{projected=opt.body;expect(opt.headers.Depth).toBeUndefined()}]);
 const r=await read(m);expect(r).toEqual({status:'ok',busy:[{start:'2026-11-25T11:00:00.000Z',end:'2026-11-25T11:30:00.000Z'}]});
 expect(projected).toContain('calendar-multiget');expect(projected).toContain(obj);expect(projected).toContain('VTIMEZONE');expect(projected).toContain('RECURRENCE-ID');expect(projected).not.toMatch(/time-range|calendar-query|name="(?:description|summary|location|attendee)"/i);expect(m.n).toBe(5);
 });
 it('correctly distinguishes an empty readable calendar from an incomplete result',async()=>{
 expect(await read(mock([denied(),access(),inv('')]))).toEqual({status:'ok',busy:[]});
 for(const responses of [[denied(),access('write')],[denied(),access(),inv(),ms('')],[denied(),access(),inv(),ms(objRow(ical,'new'))],[denied(),access(),inv(),ms(objRow()),inv(item()+item(col+'concurrent.ics','v2'))],
 [denied(),access(),inv(),ms(objRow(ical,'v1','https://outside.invalid/event.ics'))],[denied(),access(),text('<!DOCTYPE fake SYSTEM "https://outside.invalid/dtd"><multistatus xmlns="DAV:"/>')],[denied(),access(),inv('<response><href>/too-big</href><status>HTTP/1.1 507 Limit</status></response>')]]){
 const r=await read(mock(responses));expect(r.status).toBe('unknown');expect(r).not.toHaveProperty('busy');
 }
 });
 it('bounds resources and response bytes; never partially processes overflow',async()=>{
 const s=Array.from({length:161},(_,i)=>item(col+'evt'+i+'.ics')).join('');expect(await read(mock([denied(),access(),inv(s)]))).toEqual({status:'unknown',reason:'calendar-too-large'});
 expect((await read(mock([text('x'.repeat(385*1024),200,'text/calendar')]))).status).toBe('unknown');
 });
});
