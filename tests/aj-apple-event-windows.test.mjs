import { describe,it,expect } from 'vitest';
import { appleEventWindows as read } from '../src/aj/apple-event-windows';
const sec=str=>Date.parse(str)/1000, map=ws=>ws.map(({start,end})=>[new Date(start*1000).toISOString().slice(0,16),new Date(end*1000).toISOString().slice(0,16)]);
const event=(lines,id='example-1')=>['BEGIN:VEVENT','UID:'+id,...lines,'END:VEVENT'].join('\r\n');
const cal=(...items)=>['BEGIN:VCALENDAR','VERSION:2.0',...items,'END:VCALENDAR',''].join('\r\n');
const run=(items,a,b,z)=>map(read([cal(...items)],sec(a),sec(b),z));
const sx='2026-03-26T00:00Z',ex='2026-04-04T00:00Z';
describe('Apple projected VEVENT busy spans',()=>{
 it('runs local weekly calendar times across Copenhagen DST and clips half-open boundaries',()=>{
 const e=event(['DTSTART;TZID=Europe/Copenhagen:20260323T090000','DTEND;TZID=Europe/Copenhagen:20260323T100000','RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4']);
 expect(run([e],sx,ex)).toEqual([['2026-03-30T07:00','2026-03-30T08:00'],['2026-04-01T07:00','2026-04-01T08:00']]);
 expect(run([e],'2026-03-30T07:20Z','2026-03-30T07:40Z')).toEqual([['2026-03-30T07:20','2026-03-30T07:40']]);
 });
 it('keeps moved-in overrides whose original falls beyond the query, and suppresses moved-out, canceled and free overrides',()=>{
 const e=event(['DTSTART:20260327T090000Z','DURATION:PT1H','RRULE:FREQ=DAILY;COUNT=30']);
 const ev=(id,...ps)=>event(['RECURRENCE-ID:2026'+id+'T090000Z',...ps]);
 expect(run([e,ev('0328','DTSTART:20260410T090000Z'),ev('0329','STATUS:CANCELLED'),ev('0330','TRANSP:TRANSPARENT'),ev('0415','DTSTART:20260329T140000Z')],'2026-03-28T00:00Z','2026-03-31T00:00Z')).toEqual([['2026-03-29T14:00','2026-03-29T15:00']]);
 });
 it('applies every EXDATE and RDATE, merges overlapping or identical occurrences, and excludes tentative only when transparent',()=>{
 const e=event(['DTSTART:20260326T090000Z','DURATION:PT1H','RRULE:FREQ=DAILY;COUNT=5','EXDATE:20260326T090000Z,20260328T090000Z','EXDATE:20260330T090000Z','RDATE:20260327T093000Z,20260401T090000Z','RDATE:20260402T080000Z','STATUS:TENTATIVE']);
 const e2=event(['DTSTART:20260326T050000Z','DURATION:PT1H','TRANSP:TRANSPARENT'],'other');
 expect(run([e,e2],sx,ex)).toEqual([['2026-03-27T09:00','2026-03-27T10:30'],['2026-03-29T09:00','2026-03-29T10:00'],['2026-04-01T09:00','2026-04-01T10:00'],['2026-04-02T08:00','2026-04-02T09:00']]);
 });
 it('represents all-day local midnight to midnight on a 23-hour Danish day and floating hours in the supplied calendar timezone',()=>{
 const e=event(['DTSTART;VALUE=DATE:20260329','DTEND;VALUE=DATE:20260330']);
 const f=event(['DTSTART:20260331T090000','DURATION:PT1H'],'separate');
 expect(run([e,f],sx,ex,'Europe/Copenhagen')).toEqual([['2026-03-28T23:00','2026-03-29T22:00'],['2026-03-31T07:00','2026-03-31T08:00']]);
 expect(()=>run([e,f],sx,ex)).toThrow('unsupported-calendar-data');
 });
 it('respects embedded VTIMEZONE independent of worker locale or other calendars',()=>{
 const v=['BEGIN:VTIMEZONE','TZID:Apple/Local-Office','BEGIN:STANDARD','DTSTART:19701025T030000','RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU','TZOFFSETFROM:+0200','TZOFFSETTO:+0100','END:STANDARD','BEGIN:DAYLIGHT','DTSTART:19700329T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU','TZOFFSETFROM:+0100','TZOFFSETTO:+0200','END:DAYLIGHT','END:VTIMEZONE'].join('\r\n');
 const e=event(['DTSTART;TZID=Apple/Local-Office:20260327T100000','DURATION:PT1H','RRULE:FREQ=DAILY;COUNT=4']);
 expect(run([v,e],sx,ex)).toEqual([['2026-03-27T09:00','2026-03-27T10:00'],['2026-03-28T09:00','2026-03-28T10:00'],['2026-03-29T08:00','2026-03-29T09:00'],['2026-03-30T08:00','2026-03-30T09:00']]);
 });
 it('compares UNTIL in UTC against IANA wall-clock recurrence',()=>{
 const e=event(['DTSTART;TZID=Europe/Copenhagen:20260328T100000','DURATION:PT1H','RRULE:FREQ=DAILY;UNTIL=20260329T080000Z']);
 expect(run([e],sx,ex)).toEqual([['2026-03-28T09:00','2026-03-28T10:00'],['2026-03-29T08:00','2026-03-29T09:00']]);
 });
 it('honors difference between nominal one-day DURATION and fixed DTEND duration on timed recurrences',()=>{
 const e=end=>event(['DTSTART;TZID=Europe/Copenhagen:20260327T090000',end,'RRULE:FREQ=DAILY;COUNT=2']);
 const window=[sx,ex,'Europe/Copenhagen'];
 expect(run([e('DURATION:P1D')],...window)).toEqual([['2026-03-27T08:00','2026-03-29T07:00']]);
 expect(run([e('DTEND;TZID=Europe/Copenhagen:20260328T090000')],...window)).toEqual([['2026-03-27T08:00','2026-03-29T08:00']]);
 });
 it.each([
 ['DTSTART;TZID=Not/AZone:20260327T100000','DURATION:PT1H'],
 ['DTSTART:20260332T100000Z','DURATION:PT1H'],['DTSTART:20260327T100000Z','RRULE:FREQ=SECONDLY'],
 ['DTSTART:20260327T100000Z','RDATE;VALUE=PERIOD:20260327T090000Z/PT1H'],
 ['DTSTART;TZID=Europe/Copenhagen:20261025T023000','DURATION:PT1H'],
 ['DTSTART;TZID=Europe/Copenhagen:20260329T023000','DURATION:PT1H'],
 ])('fails closed without leaking private source for %s',(...lines)=>expect(()=>run([event(lines)],sx,ex)).toThrow('unsupported-calendar-data'));
 it('rejects orphan overrides, THISANDFUTURE, duplicate master and bounded-work exhaustion',()=>{
 const master=event(['DTSTART:20260327T100000Z','DURATION:PT1H','RRULE:FREQ=DAILY']);
 const moved=event(['RECURRENCE-ID;RANGE=THISANDFUTURE:20260327T100000Z','DTSTART:20260327T110000Z']);
 for (const list of [[moved],[master,moved],[master,master],[event(['DTSTART:19400101T090000Z','DURATION:PT1H','RRULE:FREQ=DAILY'])]]) expect(()=>run(list,sx,ex)).toThrow('unsupported-calendar-data');
 });
});
