import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import { discoverAppleCalendars,readAppleBusy } from '../src/aj/apple-caldav.ts';
import { calendarConnection,connectPrivateCalendar,disconnectCalendar,getStaffBusyWindows,listPrivateCalendars,setCalendarSelection } from '../src/aj/external-busy.ts';
vi.mock('../src/aj/apple-caldav.ts',()=>({ discoverAppleCalendars:vi.fn(),readAppleBusy:vi.fn() }));

const owner={email:'staff@example.test',sessionHash:'test-session'};
const auth={email:'owner@icloud.test',password:'abcd-efgh-ijkl-mnop'};
const key=Buffer.alloc(32,42).toString('base64');
const now=()=>Math.floor(Date.now()/1000);
const sources=[
  {name:'Min fritid',url:'https://p01-caldav.icloud.com/123/calendars/A/'},
  {name:'Familie',url:'https://p01-caldav.icloud.com/123/calendars/B/'},
  {name:'AJ Auto – Anas',url:'https://p01-caldav.icloud.com/123/calendars/feed/'}
];
let db,env;
function adapter(sql,values=[]){ return {
  bind:(...v)=>adapter(sql,v),async first(){return db.prepare(sql).get(...values)??null;},
  async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};}
};}
beforeEach(()=>{
  vi.resetAllMocks();db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE aj_staff(id INTEGER PRIMARY KEY,email TEXT,active INTEGER); CREATE TABLE aj_sessions(token_hash TEXT PRIMARY KEY,email TEXT,expires_at INTEGER);');
  db.exec(readFileSync(new URL('../migrations/0028_aj_private_calendar.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO aj_staff VALUES(1,?,1),(2,?,1)').run(owner.email,'peer@example.test');
  db.prepare('INSERT INTO aj_sessions VALUES(?,?,?)').run(owner.sessionHash,owner.email,now()+3600);
  env={DB:{prepare:q=>adapter(q)},AJ_ICLOUD_ENABLED:'1',AJ_CALENDAR_TOKEN_KEY:key};
  discoverAppleCalendars.mockResolvedValue(sources);
  readAppleBusy.mockResolvedValue({status:'ok',busy:[]});
});
afterEach(()=>db.close());
async function pending(){await connectPrivateCalendar(env,1,auth,owner);return listPrivateCalendars(env,1);}
async function connected(){const choices=await pending();await setCalendarSelection(env,1,choices.map(c=>c.id),owner);readAppleBusy.mockClear();return choices;}

describe('private calendar credentials, selection and booking boundary',()=>{
  it('only reads explicitly selected, probed calendars and keeps private names, URLs and passwords out of D1',async()=>{
    expect(await getStaffBusyWindows(env,1,100,200)).toEqual([]);
    const list=await pending(); expect(list).toHaveLength(2); expect(list[0]).toEqual({id:expect.stringMatching(/^[0-9a-f]{64}$/),name:'Min fritid'});
    expect(await getStaffBusyWindows(env,1,100,200)).toEqual([]);
    await expect(setCalendarSelection(env,1,['a'.repeat(64)],owner)).rejects.toThrow();
    await setCalendarSelection(env,1,[list[1].id],owner);
    expect(await calendarConnection(env,1)).toEqual({state:'connected',selectedIds:[list[1].id]});
    readAppleBusy.mockResolvedValue({status:'ok',busy:[{start:new Date(90000).toISOString(),end:new Date(150000).toISOString()}]});
    expect(await getStaffBusyWindows(env,1,100,200)).toEqual([{start:100,end:150}]);
    expect(readAppleBusy.mock.calls.every(([x])=>x.collectionUrl===sources[1].url)).toBe(true);
    const persisted=JSON.stringify(db.prepare('SELECT * FROM aj_icloud_connections').get());
    for(const secret of [auth.email,auth.password,sources[1].url,'Familie',list[1].id])expect(persisted).not.toContain(secret);
    expect(await getStaffBusyWindows(env,2,100,200)).toEqual([]);
  });
  it('withholds all intervals after one provider error, marks a lost link and allows local-only disconnect without a key',async()=>{
    const choices=await connected();
    readAppleBusy.mockResolvedValueOnce({status:'ok',busy:[]}).mockResolvedValueOnce({status:'unknown',reason:'unauthorized'});
    expect(await getStaffBusyWindows(env,1,100,200)).toBeNull();
    expect((await calendarConnection(env,1)).state).toBe('reconnect');
    await expect(connectPrivateCalendar(env,1,auth,owner)).resolves.toBeUndefined();
    expect((await calendarConnection(env,1)).state).toBe('pending');
    expect(await getStaffBusyWindows(env,1,100,200)).toBeNull();
    await setCalendarSelection(env,1,[choices[0].id],owner);
    const off={...env,AJ_CALENDAR_TOKEN_KEY:'',AJ_ICLOUD_ENABLED:'0'};
    expect(await getStaffBusyWindows(off,1,100,200)).toBeNull();
    await disconnectCalendar(off,1,owner);
    expect(await getStaffBusyWindows(off,1,100,200)).toEqual([]);
  });
  it('retains the last good selection if a replacement cannot be verified',async()=>{
    const list=await connected();
    readAppleBusy.mockResolvedValue({status:'unknown',reason:'unsupported'});
    await expect(setCalendarSelection(env,1,[list[0].id],owner)).rejects.toThrow();
    expect((await calendarConnection(env,1)).selectedIds).toEqual(list.map(c=>c.id));
    expect(await getStaffBusyWindows(env,1,100,200)).toBeNull();
  });
  it('does not save credentials following logout during discovery or disconnect while connecting',async()=>{
    let resume; discoverAppleCalendars.mockImplementation(()=>new Promise(r=>{resume=r;}));
    const first=connectPrivateCalendar(env,1,auth,owner);
    await vi.waitFor(()=>expect(resume).toBeTypeOf('function'));
    await disconnectCalendar(env,1,owner);resume(sources);await expect(first).rejects.toThrow();
    resume=undefined;
    const second=connectPrivateCalendar(env,1,auth,owner);
    await vi.waitFor(()=>expect(resume).toBeTypeOf('function'));
    db.prepare('DELETE FROM aj_sessions').run();resume(sources);await expect(second).rejects.toThrow();
    expect(await calendarConnection(env,1)).toEqual({state:'disconnected',selectedIds:[]});
  });
  it('enforces own staff identity and purges the link on email change or deactivation',async()=>{
    await expect(connectPrivateCalendar(env,2,auth,owner)).rejects.toThrow();
    const list=await pending();await expect(setCalendarSelection(env,1,[list[0].id],{...owner,email:'peer@example.test'})).rejects.toThrow();
    await disconnectCalendar(env,1,{...owner,email:'peer@example.test'});expect((await calendarConnection(env,1)).state).toBe('pending');
    db.exec("UPDATE aj_staff SET email='replacement@example.test' WHERE id=1");
    expect((await calendarConnection(env,1)).state).toBe('disconnected');
    db.prepare('UPDATE aj_staff SET email=? WHERE id=1').run(owner.email);
    await connected();db.exec('UPDATE aj_staff SET active=0 WHERE id=1');
    expect((await calendarConnection(env,1)).state).toBe('disconnected');
  });
  it('treats a new config without its migration or an unavailable DB as unknown rather than free',async()=>{
    db.exec('DROP TABLE aj_icloud_connections');
    expect(await getStaffBusyWindows(env,1,100,200)).toBeNull();
    expect(await getStaffBusyWindows({...env,AJ_ICLOUD_ENABLED:undefined},1,100,200)).toEqual([]);
    expect(await getStaffBusyWindows({DB:{prepare:()=>{throw Error('D1 unavailable');}}},1,100,200)).toBeNull();
  });
  it('does not release a stale free result if selection was disconnected during a read',async()=>{
    await connected();
    let release; const wait=new Promise(resolve=>{release=resolve;});
    readAppleBusy.mockImplementation(async()=>{await wait;return {status:'ok',busy:[]};});
    const result=getStaffBusyWindows(env,1,100,200);
    await vi.waitFor(()=>expect(readAppleBusy).toHaveBeenCalled());
    await disconnectCalendar(env,1,owner);release();
    expect(await result).toBeNull();
    expect(await getStaffBusyWindows(env,1,100,200)).toEqual([]);
  });
  it('unauthentic ciphertext or a different key never produces free time',async()=>{
    await connected();readAppleBusy.mockClear();
    expect(await getStaffBusyWindows({...env,AJ_CALENDAR_TOKEN_KEY:Buffer.alloc(32,43).toString('base64')},1,100,200)).toBeNull();
    db.exec("UPDATE aj_icloud_connections SET link_id='reassigned'");
    expect(await getStaffBusyWindows(env,1,100,200)).toBeNull();
    expect(readAppleBusy).not.toHaveBeenCalled();
  });
  it('rejects credentials that are not in app-specific format without making a network request',async()=>{
    await expect(connectPrivateCalendar(env,1,{...auth,password:'regular Apple password'},owner)).rejects.toThrow();
    expect(discoverAppleCalendars).not.toHaveBeenCalled();
  });
});
