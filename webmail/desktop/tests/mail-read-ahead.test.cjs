'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {MailReadAhead, smallMessages} = require('../mail-read-ahead.cjs');
const {RecentMessages} = require('../recent-messages.cjs');
const {createMailConnector, ImapSession} = require('../mail-connector.cjs');

const account = {email:'test@example.test', imap:{host:'imap.example.test',password:'fixture'}, smtp:{host:'smtp.example.test',password:'fixture'}};

test('list warms small messages in one bounded batch and a click can reuse a sanitized body', async () => {
  const source = Buffer.from('From: Test <test@example.test>\r\nSubject: Prøve\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Ordrebekræftelse</p><img src="https://example.test/logo.png">');
  const requests = [], cache = new RecentMessages();
  class TestImap extends EventEmitter {
    async connect() { this.usable=true; }
    async getMailboxLock() { this.mailbox={uidValidity:42n}; return {release() {}}; }
    async fetchAll(uids, query, options) {
      requests.push({uids,query,options});
      return uids.map(uid=>({uid, size:source.length, source, flags:new Set(), envelope:{subject:'Prøve'}}));
    }
    close() { this.usable=false; }
  }
  const scheduler = new MailReadAhead({makeSession:()=>new ImapSession(),cache,
    connectorFor:(account,imapSession)=>createMailConnector({account,imapSession,dependencies:{ImapFlow:TestImap}})});
  const page={uidValidity:'42',messages:[{uid:10,size:source.length},{uid:8,size:source.length}]};
  try {
    await scheduler.schedule('fixture',account,'INBOX',page);
    assert.deepEqual(requests.map(r=>r.uids),[[10,8]]);
    assert.deepEqual(requests[0].options,{uid:true});
    assert.equal(requests[0].query.source.maxLength,source.length+1);
    const request={folder:'INBOX',uidValidity:'42',uid:10,markSeen:false};
    const result=cache.get('fixture',request);
    assert.match(result.html,/Ordrebekræftelse/);
    assert.match(result.text,/Ordrebekræftelse/);
    assert.equal(result.seen,false);
    assert.deepEqual(result.remoteImages,['https://example.test/logo.png']);
    assert.equal(cache.get('fixture',{...request,uidValidity:'43'}),undefined);
    assert.equal(cache.get('other-account',request),undefined);
    await scheduler.schedule('fixture',account,'INBOX',page);
    assert.equal(requests.length,1);
  } finally {
    scheduler.clear();
    cache.clear();
  }
});

test('results from a cancelled page or a superseded UID never overwrite foreground state', async () => {
  const gates=[], stored=[];
  const scheduler=new MailReadAhead({
    makeSession:()=>({close(){}}),
    connectorFor:()=>({warmMessages:()=>new Promise(resolve=>gates.push(resolve))}),
    cache:{get(){},setViewport(){},clearViewport(){},remember(id,request){stored.push([id,request.uid]);}},
  });
  const page={uidValidity:'7',messages:[{uid:1,size:4},{uid:2,size:4}]};
  const results=[{uid:1,uidValidity:'7'},{uid:2,uidValidity:'7'}];
  const first=scheduler.schedule('A',account,'INBOX',page);
  const second=scheduler.schedule('A',account,'INBOX',page);
  assert.equal(gates.length,1, 'unchanged viewport shares its in-flight operation');
  scheduler.exclude('A',{folder:'INBOX',uidValidity:'7',uid:2});
  gates.forEach(resolve=>resolve(results));
  await Promise.all([first,second]);
  assert.deepEqual(stored,[['A',1]]);
});

test('read-ahead budgets bound transfers irrespective of mailbox size', () => {
  const rows=Array.from({length:40},(_,i)=>({uid:100-i,size:96*1024}));
  assert.equal(smallMessages(rows).size,4);
  assert.equal(smallMessages(rows.map(row=>({...row,size:10}))).size,8);
  assert.equal(smallMessages([{uid:1,size:96*1024+1},{uid:2,size:0}]).size,0);
});

test('loads all visible sizes in bounded batches, repairs a missing body, and never marks a mail read', async () => {
  const cache = new RecentMessages(), batches = [], singles = [];
  const rows = Array.from({length:18}, (_, i) => ({uid:i + 1, size:1024}));
  rows.push({uid:19,size:600_000}, {uid:20,size:0});
  const result = uid => ({uid,uidValidity:'9',seen:false,text:'test '+uid});
  let authentications = 0;
  const scheduler = new MailReadAhead({
    cache, makeSession:()=>({close(){}}),
    connectorFor:()=>({
      warmMessages:async ({messages}) => {
        batches.push(messages.map(m=>m.uid));
        return messages.filter(m=>m.uid!==2).map(m=>result(m.uid));
      },
      message:async req => {
        assert.equal(req.markSeen,false);
        singles.push(req.uid);
        return result(req.uid);
      },
    }),
  });
  const page = {uidValidity:'9',messages:rows};
  const getAccount = async () => { authentications++; return account; };
  try {
    await scheduler.schedule('X',getAccount,'INBOX',page);
    assert.deepEqual(batches.flat(),rows.slice(0,18).map(m=>m.uid));
    assert.ok(batches.every(batch=>batch.length<=8));
    assert.deepEqual(singles,[2,19,20]);
    for (const row of rows) {
      assert.equal(cache.get('X',{folder:'INBOX',uidValidity:'9',uid:row.uid,markSeen:false}).text,'test '+row.uid);
    }
    await scheduler.schedule('X',getAccount,'INBOX',page);
    assert.equal(authentications,1);
    assert.equal(cache.get('X',{folder:'INBOX',uidValidity:'9',uid:21,markSeen:false}),undefined);
  } finally { scheduler.clear(); cache.clear(); }
});

test('scroll interrupts only an obsolete batch and a late result never warms offscreen mail', async () => {
  const cache = new RecentMessages(), gates = [], sessions = [];
  const settled = Promise.withResolvers();
  const scheduler = new MailReadAhead({
    cache,makeSession:()=>{const session={closed:false,close(){this.closed=true;}};sessions.push(session);return session;},
    connectorFor:()=>({warmMessages:({messages})=>new Promise(resolve=>{
      gates.push({uids:messages.map(row=>row.uid), finish:()=>resolve(messages.map(row=>({uid:row.uid,uidValidity:'7'})))});
      if (gates.length===2) settled.resolve();
    })}),
  });
  const page=(...uids)=>({uidValidity:'7',messages:uids.map(uid=>({uid,size:8}))});
  const request=uid=>({folder:'box',uidValidity:'7',uid,markSeen:false});
  try {
    const old = scheduler.schedule('A',account,'box',page(1,2));
    const wait = scheduler.inFlight('A',request(1));
    assert.ok(wait);
    assert.equal(scheduler.inFlight('A',request(9)),undefined);
    scheduler.schedule('A',account,'box',page(1,2,3));
    assert.equal(sessions.length,1);
    const newest = scheduler.schedule('A',account,'box',page(2,3));
    assert.equal(sessions[0].closed,true);
    await wait;
    await settled.promise;
    gates.forEach(gate=>gate.finish());
    await Promise.all([old,newest]);
    assert.deepEqual(gates.map(g=>g.uids),[[1,2],[2,3]]);
    assert.equal(cache.get('A',request(1)),undefined);
    assert.equal(cache.get('A',request(2)).uid,2);
    assert.equal(cache.get('A',request(3)).uid,3);
    const lateAccount = Promise.withResolvers();
    const waiting = scheduler.schedule('A',()=>lateAccount.promise,'other',page(6));
    scheduler.cancel('A');
    lateAccount.resolve(account);
    await waiting;
    assert.equal(gates.length,2);
  } finally { scheduler.clear(); cache.clear(); }
});

test('declined batch and an individual parser failure leave other visible bodies ready', async () => {
  const cache = new RecentMessages(), singles = [], batches = [];
  const scheduler = new MailReadAhead({cache,makeSession:()=>({close(){}}),connectorFor:()=>({
    async warmMessages({messages}) {
      batches.push(messages.length);
      throw Object.assign(new Error('partial batch unsupported'),{responseStatus:'NO'});
    },
    async message({uid}) {
      singles.push(uid);
      if (uid===2) throw new Error('malformed MIME fixture');
      return {uid,uidValidity:'2',text:'message '+uid,seen:false};
    },
  })});
  try {
    const messages=Array.from({length:10},(_,i)=>({uid:i+1,size:123}));
    await scheduler.schedule('A',account,'box',{uidValidity:'2',messages});
    assert.deepEqual(batches,[8]);
    assert.deepEqual(singles,messages.map(row=>row.uid));
    assert.equal(cache.get('A',{folder:'box',uidValidity:'2',uid:10,markSeen:false}).text,'message 10');
  } finally { scheduler.clear(); cache.clear(); }
});

test('an offline server does not start a new connection for each scroll event', async () => {
  const cache = new RecentMessages();
  let connects=0;
  const scheduler = new MailReadAhead({cache,makeSession:()=>({close(){}}),connectorFor:()=>({
    async warmMessages() { connects++; throw Object.assign(new Error('offline'),{code:'ECONNREFUSED'}); },
  })});
  try {
    for (let i=1;i<=20;i++) {
      await scheduler.schedule('A',account,'box',{uidValidity:'2',messages:[{uid:i,size:60}]});
    }
    assert.equal(connects,1);
  } finally { scheduler.clear(); cache.clear(); }
});

test('a trackpad fling coalesces intermediate viewports and reuses the authenticated background socket', async () => {
  let connections=0, closes=0;
  const batches=[], cache=new RecentMessages(), source=Buffer.from('Subject: Test\r\n\r\nBody');
  class TestImap extends EventEmitter {
    async connect(){connections++;this.usable=true;}
    async noop(){}
    async getMailboxLock(){this.mailbox={uidValidity:17n};return {release(){}};}
    async fetchAll(uids){
      batches.push(uids);
      return uids.map(uid=>({uid,source,size:source.length,flags:new Set()}));
    }
    close(){this.usable=false;closes++;}
  }
  const scheduler=new MailReadAhead({cache,makeSession:()=>new ImapSession(),
    connectorFor:(account,imapSession)=>createMailConnector({account,imapSession,dependencies:{ImapFlow:TestImap}})});
  const page=uid=>({uidValidity:'17',messages:[{uid,size:source.length}]});
  try {
    await scheduler.schedule('A',account,'box',page(1));
    const changes=[];
    for(let uid=2;uid<=25;uid++) changes.push(scheduler.schedule('A',account,'box',page(uid)));
    assert.deepEqual(batches,[[1]]);
    await Promise.all(changes);
    assert.deepEqual(batches,[[1],[25]]);
    assert.equal(connections,1);
    assert.equal(closes,0);
    // A delayed fetch receives no credentials if its viewport disappears.
    const cancelled=scheduler.schedule('A',()=>assert.fail('cancelled viewport authenticated'),'box',page(26));
    scheduler.cancel('A');
    await cancelled;
    assert.equal(closes,1);
    assert.deepEqual(batches,[[1],[25]]);
  } finally { scheduler.clear(); cache.clear(); }
});
