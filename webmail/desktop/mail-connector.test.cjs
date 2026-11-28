'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const realNodemailer=require('nodemailer');
const {simpleParser}=require('mailparser');
const {createMailConnector,ImapSession,normalizeAccount,richMessage,sanitizeCSS,safeImageURL,MAX_SOURCE,MAX_ATTACHMENTS}=require('./mail-connector.cjs');

const account={email:'owner@example.test',name:'Account Owner',imap:{host:'imap.example.test',port:993,secure:true,user:'owner@example.test',password:'unit-test-password'},smtp:{host:'smtp.example.test',port:587,secure:false,user:'owner@example.test',password:'unit-test-password'}};
const raw=Buffer.from('From: Sender <sender@example.test>\r\nTo: Account Owner <owner@example.test>\r\nCc: Other <other@example.test>\r\nSubject: Test message\r\nMessage-ID: <inbound@example.test>\r\nDate: Fri, 27 Nov 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test-boundary"\r\n\r\n--test-boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello from HTML</p><img src="https://tracker.example.test/pixel"><script>window.pwned=true</script>\r\n--test-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="../../note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--test-boundary--\r\n');
function fixture(overrides={}) {
  const calls=[],options=[],transports=[];
  const folders=[{path:'INBOX',name:'INBOX',flags:new Set(),status:{messages:82,unseen:3}},{path:'Sent',name:'Sent',specialUse:'\\Sent',flags:new Set()},{path:'Archive',name:'Archive',specialUse:'\\Archive',flags:new Set()},{path:'Trash',name:'Trash',specialUse:'\\Trash',flags:new Set()},{path:'Container',name:'Container',flags:new Set(['\\Noselect'])}];
  const meta={uid:12,size:raw.length,envelope:{subject:'Test message',from:[{name:'Sender',address:'sender@example.test'}],to:[{address:account.email}],date:new Date('2026-11-27T12:00:00Z')},flags:new Set(['\\Flagged'])};
  class FakeImap extends EventEmitter {
    constructor(opts){super();options.push(opts);this.mailbox={exists:82,uidValidity:42n};this.capabilities=new Set(['MOVE','UIDPLUS']);this.closed=false;}
    async connect(){calls.push(['connect']);this.usable=true;if(overrides.connect)return overrides.connect(this);}
    async noop(){calls.push(['noop']);if(overrides.noop)return overrides.noop(this);}
    close(){this.closed=true;this.usable=false;calls.push(['close']);}
    async getMailboxLock(folder){calls.push(['lock',folder]);return {release:()=>calls.push(['release'])};}
    async list(opts){calls.push(['list',opts]);return overrides.folders || folders;}
    async search(query,opts){calls.push(['search',query,opts]);return overrides.search || [1,44,22,88,3];}
    async fetchAll(range,query,opts){calls.push(['fetchAll',range,query,opts]);return [{...meta,uid:4},{...meta,uid:9}];}
    async fetchOne(uid,query,opts){
      calls.push(['fetchOne',uid,query,opts]);
      if(overrides.missing)return false;
      if(query.bodyParts && overrides.partsError)throw overrides.partsError;
      if(query.bodyParts && overrides.parts)return overrides.parts;
      const result = {...meta,...overrides.meta};
      if(query.source) result.source = (overrides.source || raw).subarray(0,query.source.maxLength);
      return result;
    }
    async messageFlagsAdd(...args){calls.push(['addFlags',...args]);return true;}
    async messageFlagsRemove(...args){calls.push(['removeFlags',...args]);if(overrides.removeFlags)return overrides.removeFlags();return true;}
    async messageMove(...args){calls.push(['move',...args]);return true;}
    async append(...args){calls.push(['append',...args]);if(overrides.appendError)throw new Error('offline');return {uid:100};}
  }
  const nodemailer={createTransport(opts){
    if(opts.streamTransport)return realNodemailer.createTransport(opts);
    transports.push(opts);
    return {verify:async()=>{calls.push(['verifySMTP']);if(overrides.verifyError)throw new Error('Authentication failed');return true;},sendMail:async message=>{calls.push(['send',message]);if(overrides.send)return overrides.send(message);return {accepted:['receiver@example.test'],rejected:[]};},close:()=>calls.push(['closeSMTP'])};
  }};
  return {calls,options,transports,create(extra={}){return createMailConnector({account:{...account,...extra.account},dependencies:{ImapFlow:FakeImap,nodemailer},...extra});}};
}
const outbound={to:'Receiver <receiver@example.test>',cc:'copy@example.test',bcc:'secret@example.test',subject:'Subject',text:'Hello',attachments:[{filename:'note.txt',contentType:'text/plain',data:Buffer.from('contents').toString('base64')}]};

test('validates account and hostname without accepting transport option injection',()=>{
  assert.throws(()=>normalizeAccount({...account,email:'owner@example.test\r\nBcc: victim@example.test'}),/Invalid/);
  assert.throws(()=>normalizeAccount({...account,imap:{...account.imap,host:'https://mail.example.test/path'}}),/hostname/);
  assert.throws(()=>normalizeAccount({...account,smtp:{...account.smtp,port:0.5}}),/port/);
  const normalized=normalizeAccount({...account,imap:{...account.imap,tls:{rejectUnauthorized:false},proxy:'http://unsafe.test'}});
  assert.equal(normalized.imap.tls,undefined);assert.equal(normalized.imap.proxy,undefined);
});

test('verifies IMAP and SMTP with verified TLS and bounded transport settings',async()=>{
  const f=fixture();assert.deepEqual(await f.create().verify(),{ok:true});
  assert.equal(f.options[0].secure,true);assert.equal(f.options[0].tls.rejectUnauthorized,true);assert.equal(f.options[0].tls.minVersion,'TLSv1.2');assert.equal(f.options[0].logger,false);
  assert.equal(f.transports[0].requireTLS,true);assert.equal(f.transports[0].tls.rejectUnauthorized,true);assert.equal(f.transports[0].disableFileAccess,true);assert.equal(f.transports[0].disableUrlAccess,true);
  assert.ok(f.calls.some(c=>c[0]==='close'));assert.ok(f.calls.some(c=>c[0]==='closeSMTP'));
});

test('requires STARTTLS explicitly when configured for IMAP port 143',async()=>{
  const f=fixture();await f.create({account:{...account,imap:{...account.imap,port:143,secure:false}}}).folders();
  assert.equal(f.options[0].doSTARTTLS,true);assert.equal(f.options[0].secure,false);
});

test('OAuth access tokens use XOAUTH2 without retaining a password in transport options',async()=>{
  const f=fixture();await f.create({account:{...account,imap:{...account.imap,password:undefined,accessToken:'mock-access-token'},smtp:{...account.smtp,password:undefined,accessToken:'mock-access-token'}}}).verify();
  assert.deepEqual(f.options[0].auth,{user:account.email,accessToken:'mock-access-token'});assert.deepEqual(f.transports[0].auth,{type:'OAuth2',user:account.email,accessToken:'mock-access-token'});
});

test('folders omit non-selectable containers and include counts',async()=>{
  const folders=await fixture().create().folders();assert.equal(folders[0].path,'INBOX');assert.equal(folders[0].unseen,3);assert.equal(folders.some(f=>f.path==='Container'),false);
});

test('Gmail sidebar uses one LIST, preserving custom labels and localized system folder paths',async()=>{
  const folders = [
    {path:'INBOX',status:{messages:22,unseen:9}},
    {path:'[Gmail]/Alle meddelelser',specialUse:'\\All'},
    {path:'[Gmail]/Vigtig',flags:new Set(['\\Important'])},
    {path:'[Imap]/Drafts',specialUse:'\\Drafts',specialUseSource:'name'},
  ];
  const f = fixture({folders,connect:client=>client.capabilities.add('X-GM-EXT-1')});
  const result = await f.create().sidebar();
  assert.equal(f.calls.filter(c=>c[0]==='list').length,1);
  assert.equal(result.gmail,true);
  assert.equal(result.folders.find(folder=>folder.path==='[Imap]/Drafts').label,true);
  const view = id=>result.views.find(item=>item.id===id);
  assert.deepEqual(result.views.map(item=>item.id),['inbox','starred','snoozed','important','sent','drafts','purchases','social','updates','forums','promotions','scheduled','all','spam','trash','subscriptions']);
  assert.equal(view('inbox').unseen,9);
  assert.equal(view('important').folder,'[Gmail]/Vigtig');
  for(const id of ['snoozed','purchases','social','updates','forums','promotions']){
    assert.equal(view(id).folder,'[Gmail]/Alle meddelelser');
    assert.equal(view(id).filter,id);
    assert.equal(view(id).unseen,undefined);
  }
  assert.equal(view('scheduled').webView,'scheduled');
  assert.equal(view('subscriptions').webView,'subscriptions');
  assert.equal(view('drafts').webView,'drafts');
});

test('a hidden All Mail folder offers Gmail web views, while generic IMAP honestly scopes Starred',async()=>{
  const folders=[{path:'INBOX'},{path:'Sent',specialUse:'\\Sent'}];
  const generic=await fixture({folders}).create().sidebar();
  assert.deepEqual(generic.views.map(item=>item.id),['inbox','starred','sent']);
  assert.match(generic.views[1].name,/indbakken/i);
  assert.equal(generic.views[1].folder,'INBOX');
  const gmail=await fixture({folders,connect:client=>client.capabilities.add('X-GM-EXT-1')}).create().sidebar();
  assert.equal(gmail.views.find(item=>item.id==='social').webView,'social');
});

test('category filters and text search share one IMAP UID search anchored to the selected real folder',async()=>{
  const path='[Gmail]/Alle mails';
  const f=fixture({connect:client=>client.capabilities.add('X-GM-EXT-1')});
  const result=await f.create().messages({folder:path,filter:'purchases',query:'category:forums',page:2,pageSize:2});
  assert.deepEqual(f.calls.find(c=>c[0]==='lock'),['lock',path]);
  assert.deepEqual(f.calls.find(c=>c[0]==='search'),['search',{text:'category:forums',gmraw:'category:purchases'},{uid:true}]);
  const fetch=f.calls.find(c=>c[0]==='fetchAll');
  assert.deepEqual(fetch[1],[22,3]);
  assert.equal(fetch[2].labels,true);
  assert.equal(fetch[3].uid,true);
  assert.equal(result.uidValidity,'42');
  await assert.rejects(f.create().messages({folder:path,filter:'anything else'}),/visning/);
  await assert.rejects(fixture().create().messages({filter:'social'}),/visning/);
  const fallback=fixture();
  await fallback.create().messages({filter:'starred'});
  assert.deepEqual(fallback.calls.find(c=>c[0]==='search')[1],{flagged:true});
});

test('Gmail handoffs carry the account on a fixed origin and only accept recognized views',()=>{
  const {gmailWebViewUrl,isGmailHost}=require('./provider-views.cjs');
  const target=new URL(gmailWebViewUrl('subscriptions','someone+work@example.test'));
  assert.equal(target.origin,'https://mail.google.com');
  assert.equal(target.searchParams.get('authuser'),'someone+work@example.test');
  assert.equal(target.hash,'#sub');
  assert.equal(new URL(gmailWebViewUrl('purchases','a@example.test')).hash,'#search/category%3Apurchases');
  assert.throws(()=>gmailWebViewUrl('https://example.test','a@example.test'));
  assert.equal(isGmailHost('imap.gmail.com'),true);
  assert.equal(isGmailHost('imap.gmail.com.example.test'),false);
});

test('changing importance and archiving a filtered Gmail message only changes its intended system label',async()=>{
  const f=fixture({connect:client=>client.capabilities.add('X-GM-EXT-1')});
  const selection={folder:'[Gmail]/Alle mails',uid:12,uidValidity:'42'};
  await f.create().action({...selection,action:'important'});
  await f.create().action({...selection,action:'unimportant'});
  await f.create().action({...selection,action:'archive'});
  assert.deepEqual(f.calls.filter(call=>['addFlags','removeFlags'].includes(call[0])),[
    ['addFlags',12,['\\Important'],{uid:true,useLabels:true}],
    ['removeFlags',12,['\\Important'],{uid:true,useLabels:true}],
    ['removeFlags',12,['\\Inbox'],{uid:true,useLabels:true}],
  ]);
  await assert.rejects(f.create().action({...selection,action:'unimportant',uidValidity:'13'}),{code:'STALE_MAILBOX'});
  await assert.rejects(f.create().action({uid:12,action:'important'}),{code:'STALE_MAILBOX'});
  await assert.rejects(fixture().create().action({...selection,action:'important'}),/understøtter/);
  assert.ok(!f.calls.some(call=>call[0]==='move'));
});

test('archive works in Inbox with hidden All Mail, and restoring a trashed Gmail message requires the real All Mail target',async()=>{
  const inbox={path:'INBOX',specialUse:'\\Inbox'};
  const all={path:'[Gmail]/Alle mails',specialUse:'\\All'};
  function gmail(selected, folders) {
    return fixture({folders, connect:client=>{
      client.capabilities.add('X-GM-EXT-1');
      client.mailbox.specialUse=selected;
    }});
  }
  const request={uid:12,uidValidity:'42',action:'archive'};
  const hidden=gmail('\\Inbox',[inbox]);
  await hidden.create().action({...request,folder:'INBOX'});
  assert.deepEqual(hidden.calls.find(c=>c[0]==='removeFlags'),['removeFlags',12,['\\Inbox'],{uid:true,useLabels:true}]);
  assert.ok(!hidden.calls.some(c=>c[0]==='list'));
  for(const selected of ['\\Trash','\\Junk']) {
    const f=gmail(selected,[inbox,all]);
    await f.create().action({...request,folder:'[Gmail]/Deleted'});
    assert.deepEqual(f.calls.find(c=>c[0]==='move'),['move',12,all.path,{uid:true}]);
  }
  const noTarget=gmail('\\Trash',[inbox,{path:'All mail',name:'All mail',specialUse:'\\All',specialUseSource:'name'}]);
  await assert.rejects(noTarget.create().action({...request,folder:'[Gmail]/Trash'}),{code:'FOLDER_MISSING'});
  assert.ok(!noTarget.calls.some(c=>c[0]==='move'));
});

test('pagination fetches only a bounded reverse sequence window, newest first',async()=>{
  const f=fixture(),result=await f.create().messages({page:2,pageSize:40});
  assert.equal(f.calls.find(c=>c[0]==='fetchAll')[1],'3:42');assert.equal(result.total,82);assert.equal(result.hasNext,true);assert.deepEqual(result.messages.map(m=>m.uid),[9,4]);assert.equal(result.uidValidity,'42');
  assert.deepEqual(f.calls.filter(c=>c[0]==='release'),[['release']]);
});

test('search is a server search with UID-based pagination, not sequence IDs',async()=>{
  const f=fixture(),result=await f.create().messages({query:'invoice',page:2,pageSize:2});
  assert.deepEqual(f.calls.find(c=>c[0]==='search'),['search',{text:'invoice'},{uid:true}]);
  const fetch=f.calls.find(c=>c[0]==='fetchAll');assert.deepEqual(fetch[1],[22,3]);assert.equal(fetch[3].uid,true);assert.equal(result.total,5);
});

test('empty result pages do not fetch a wildcard range',async()=>{
  const f=fixture();const result=await f.create().messages({page:4,pageSize:40});assert.deepEqual(result.messages,[]);assert.equal(f.calls.some(c=>c[0]==='fetchAll'),false);
});

test('reads MIME as text plus sanitized private HTML for the isolated viewer',async()=>{
  const f=fixture(),message=await f.create().message({uid:12,uidValidity:'42'});
  assert.match(message.text,/Hello from HTML/);assert.doesNotMatch(message.html,/<script|window.pwned/);assert.deepEqual(message.remoteImages,['https://tracker.example.test/pixel']);assert.equal(message.seen,true);assert.equal(message.attachments[0].filename,'note.txt');assert.equal(message.attachments[0].data,undefined);
  assert.deepEqual(f.calls.find(c=>c[0]==='addFlags'),['addFlags',12,['\\Seen'],{uid:true}]);assert.equal(message.messageId,'<inbound@example.test>');
});

test('small inbox rows fetch complete source and metadata together without marking a preview read', async () => {
  const f = fixture();
  const message = await f.create().message({uid:12,uidValidity:'42',sizeHint:raw.length,markSeen:false});
  const reads = f.calls.filter(c => c[0] === 'fetchOne');
  assert.equal(reads.length, 1);
  assert.equal(reads[0][1], 12);
  assert.equal(reads[0][2].envelope, true);
  assert.deepEqual(reads[0][2].source, {start:0,maxLength:raw.length + 1});
  assert.deepEqual(reads[0][3], {uid:true});
  assert.equal(message.seen, false);
  assert.equal(f.calls.some(c => c[0] === 'addFlags'), false);
  assert.match(message.text, /Hello from HTML/);
  assert.equal(message.attachments[0].filename, 'note.txt');
});

test('an inaccurate size hint cannot expose a partial message or bypass the source size limit', async () => {
  const f = fixture();
  const message = await f.create().message({uid:12,sizeHint:8});
  assert.match(message.text, /Hello from HTML/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'fetchOne').map(c => c[2].source.maxLength), [9, MAX_SOURCE + 1]);
  const oversized = fixture({meta:{size:MAX_SOURCE + 1}});
  await assert.rejects(oversized.create().message({uid:12,sizeHint:8}), {code:'MESSAGE_TOO_LARGE'});
  assert.equal(oversized.calls.filter(c => c[0] === 'fetchOne').length, 1);
});

test('attachment uses UID and MIME index and strips path components',async()=>{
  const f=fixture(),file=await f.create().attachment({folder:'INBOX',uid:12,index:0,uidValidity:'42'});
  assert.equal(file.filename,'note.txt');assert.equal(file.data.toString(),'hello');assert.equal(f.calls.some(c=>c[0]==='addFlags'),false);
  await assert.rejects(()=>f.create().attachment({uid:12,index:1}),/Attachment not found/);
});

test('UIDVALIDITY mismatch fails before fetching or changing a message',async()=>{
  const f=fixture();await assert.rejects(()=>f.create().action({uid:12,uidValidity:'41',action:'trash'}),{code:'STALE_MAILBOX'});
  await assert.rejects(f.create().message({uid:12,uidValidity:'41',sizeHint:raw.length}),{code:'STALE_MAILBOX'});
  assert.equal(f.calls.some(c=>['fetchOne','move'].includes(c[0])),false);assert.ok(f.calls.some(c=>c[0]==='release'));assert.ok(f.calls.some(c=>c[0]==='close'));
});

test('oversized messages are refused before downloading source',async()=>{
  const f=fixture({meta:{size:MAX_SOURCE+1}});await assert.rejects(()=>f.create().message({uid:12}),{code:'MESSAGE_TOO_LARGE'});
  assert.equal(f.calls.filter(c=>c[0]==='fetchOne').length,1);
});

test('checks actual source size even when server size metadata is incorrect',async()=>{
  const f=fixture({source:Buffer.alloc(MAX_SOURCE+1)});await assert.rejects(()=>f.create().message({uid:12}),{code:'MESSAGE_TOO_LARGE'});
});

test('read/star changes target only the explicit UID',async()=>{
  const f=fixture(),connector=f.create();await connector.action({uid:12,action:'unread'});await connector.action({uid:12,action:'star'});
  assert.deepEqual(f.calls.find(c=>c[0]==='removeFlags'),['removeFlags',12,['\\Seen'],{uid:true}]);assert.deepEqual(f.calls.find(c=>c[0]==='addFlags'),['addFlags',12,['\\Flagged'],{uid:true}]);
});

test('trash and archive use the server special-use folders',async()=>{
  const f=fixture(),connector=f.create();await connector.action({uid:12,action:'trash'});await connector.action({uid:12,action:'archive'});
  assert.deepEqual(f.calls.filter(c=>c[0]==='move'),[['move',12,'Trash',{uid:true}],['move',12,'Archive',{uid:true}]]);
});

test('Gmail archives into its All Mail special-use folder',async()=>{
  const f=fixture({folders:[{path:'[Gmail]/All Mail',name:'All Mail',specialUse:'\\All'}]});
  await f.create({account:{...account,imap:{...account.imap,host:'imap.gmail.com'}}}).action({uid:12,action:'archive'});
  assert.deepEqual(f.calls.find(c=>c[0]==='move'),['move',12,'[Gmail]/All Mail',{uid:true}]);
});

test('refuses a move if the server could expunge unrelated deleted messages',async()=>{
  const f=fixture({connect:client=>{client.capabilities.clear();}});await assert.rejects(()=>f.create().action({uid:12,action:'trash'}),{code:'MOVE_UNSUPPORTED'});assert.equal(f.calls.some(c=>c[0]==='move'),false);
});

test('missing messages and missing archive folder fail without mutating',async()=>{
  const f=fixture({missing:true});await assert.rejects(()=>f.create().action({uid:12,action:'star'}),{code:'NOT_FOUND'});assert.equal(f.calls.some(c=>c[0]==='addFlags'),false);
  await assert.rejects(()=>fixture({folders:[]}).create().action({uid:12,action:'archive'}),{code:'FOLDER_MISSING'});
});

test('sends MIME with fixed From, Bcc only in envelope, and the identical Sent copy',async()=>{
  const f=fixture(),result=await f.create().send({...outbound,from:'attacker@example.test',attachments:[{...outbound.attachments[0],path:'/etc/passwd',href:'https://example.test/private'}],inReplyTo:'<inbound@example.test>',references:['<inbound@example.test>']});
  const sent=f.calls.find(c=>c[0]==='send')[1],copy=f.calls.find(c=>c[0]==='append');
  const parsed=await simpleParser(sent.raw);
  assert.equal(parsed.from.value[0].address,account.email);assert.equal(parsed.bcc,undefined);assert.ok(sent.envelope.to.includes('secret@example.test'));assert.equal(parsed.attachments[0].content.toString(),'contents');assert.equal(parsed.inReplyTo,'<inbound@example.test>');
  assert.equal(parsed.messageId,result.messageId);assert.ok(copy[2].equals(sent.raw));assert.equal(copy[1],'Sent');assert.deepEqual(copy[3],['\\Seen']);
});

test('Gmail does not receive a duplicate Sent APPEND',async()=>{
  const f=fixture();await f.create({account:{...account,smtp:{...account.smtp,host:'smtp.gmail.com'}}}).send(outbound);assert.equal(f.calls.some(c=>c[0]==='append'),false);
});

test('forwarded attachments are fetched from the bound account and included in MIME',async()=>{
  const f=fixture(),message=await f.create().message({uid:12});await f.create().send({...outbound,forwardedAttachments:[{folder:'INBOX',uid:12,uidValidity:'42',index:0,mailboxKey:message.mailboxKey}]});
  const parsed=await simpleParser(f.calls.find(c=>c[0]==='send')[1].raw);assert.equal(parsed.attachments.length,2);assert.equal(parsed.attachments[1].filename,'note.txt');assert.equal(parsed.attachments[1].content.toString(),'hello');
});

test('stale forwarded attachment identity fails before sending',async()=>{
  const f=fixture(),message=await f.create().message({uid:12});await assert.rejects(()=>f.create().send({...outbound,forwardedAttachments:[{folder:'INBOX',uid:12,uidValidity:'41',index:0,mailboxKey:message.mailboxKey}]}),{code:'STALE_MAILBOX'});assert.equal(f.calls.some(c=>c[0]==='send'),false);
});

test('changing a configured mailbox cannot retarget an old forwarded draft',async()=>{
  const message=await fixture().create().message({uid:12}),f=fixture();
  await assert.rejects(()=>f.create({account:{...account,email:'other@example.test'}}).send({...outbound,forwardedAttachments:[{folder:'INBOX',uid:12,uidValidity:'42',index:0,mailboxKey:message.mailboxKey}]}),{code:'MAILBOX_CHANGED'});
  assert.equal(f.calls.length,0);
});

test('rich mail preserves passive table/typography/media styles and strips active content',()=>{
  const result=richMessage('<style>@import "https://tracker.example/style";.brand{color:#f60;background:url(https://tracker.example/p);font-size:24px}@media(max-width:600px){td{padding:10px}}@font-face{font-family:evil;src:url(https://tracker.example/font)}</style><table cellpadding="8"><tr><td class="brand" style="font-weight:700;background-image:url(https://tracker.example/b)">Welcome</td></tr></table><script>parent.veyroMail.invoke("send")</script><form action="https://bad.test"><input name="password"></form><iframe src="https://bad.test"></iframe><svg><script>alert(1)</script></svg><img src="https://images.example.test/photo.png" onerror="alert(1)" srcset="https://bad.test/a 1x"><a href="javascript:alert(1)">Bad</a><a href="https://safe.example.test/read" target="_top">Read</a>');
  assert.match(result.html,/\.brand\{color:#f60;font-size:24px\}/);assert.match(result.html,/@media \(max-width:600px\)\{td\{padding:10px\}\}/);assert.match(result.html,/style="font-weight:700"/);assert.match(result.html,/<table cellpadding="8">/);assert.match(result.html,/target="_self"/);
  assert.doesNotMatch(result.html,/<(?:script|iframe|svg|form|input)|onerror|srcset|javascript:|@import|@font-face|tracker\.example|parent\.veyroMail/);assert.deepEqual(result.remoteImages,['https://images.example.test/photo.png']);
});

test('CID image decoding permits only bounded raster images and blocks SVG/data documents',()=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwXkAAAAASUVORK5CYII=','base64');
  const result=richMessage('<img src="cid:logo"><img src="cid:svg"><img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/svg+xml;base64,PHN2Zz4=">',[{cid:'logo',contentType:'image/png',content:png},{cid:'svg',contentType:'image/svg+xml',content:Buffer.from('<svg/>')}]);
  assert.match(result.html,/src="data:image\/png;base64,/);assert.doesNotMatch(result.html,/src="cid:|src="data:(?:text|image\/svg)/);assert.deepEqual(result.remoteImages,[]);
});

test('repeated CID references and large remote-image lists cannot expand output without bounds',()=>{
  const file={cid:'photo',contentType:'image/png',content:Buffer.alloc(512*1024)};
  const result=richMessage('<img src="cid:photo">'.repeat(60)+Array.from({length:220},(_,i)=>`<img src="https://images.example.test/${i}.png">`).join(''),[file]);
  assert.ok(Buffer.byteLength(result.html)<18*1024*1024);assert.equal(result.remoteImages.length,200);
});

test('remote images require public HTTPS host syntax and exact URLs',()=>{
  for(const url of ['http://images.example.test/a','https://127.0.0.1/a','https://[::1]/a','https://localhost/a','https://machine.local/a','https://user:pass@images.example.test/a','https://images.example.test:8443/a','file:///etc/passwd','//images.example.test/a'])assert.equal(safeImageURL(url),null,url);
  assert.equal(safeImageURL('https://images.example.test/a?x=1'),'https://images.example.test/a?x=1');
});

test('CSS URL escape/comment/function tricks and malformed HTML cannot reopen active tags',()=>{
  for(const css of ['background:u\\72l(https://bad.test)','background:u/**/rl(https://bad.test)','background:image-set("https://bad.test")','width:expression(alert(1))','color:var(--secret)','behavior:url(test)','font-family:"</style><script>alert(1)</script>"'])assert.equal(sanitizeCSS(css,true),'',css);
  const result=richMessage('<math><annotation-xml encoding="text/html"><style><img src=x onerror=alert(1)></style></annotation-xml></math><style>.x{color:red}</style><a href="mailto:a@example.test?bcc=evil@example.test">x</a>');
  assert.doesNotMatch(result.html,/<math|<annotation|onerror|href="mailto/);assert.match(result.html,/\.x\{color:red\}/);
});

test('Sent-copy failure is a successful send with a warning, never a retry error',async()=>{
  const f=fixture({appendError:true}),result=await f.create().send(outbound);assert.equal(result.ok,true);assert.match(result.warning,/Do not resend/);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});

test('reports partially rejected recipients without resending to accepted recipients',async()=>{
  const f=fixture({send:()=>({accepted:['receiver@example.test'],rejected:['copy@example.test']})}),result=await f.create().send(outbound);assert.deepEqual(result.rejected,['copy@example.test']);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});

test('rejects header injection, missing recipients, invalid base64, too many and oversized attachments before SMTP',async()=>{
  const f=fixture(),connector=f.create();
  for(const payload of [{...outbound,to:'a@example.test\r\nBcc: b@example.test'},{...outbound,subject:'Subject\r\nX-Test: bad'},{...outbound,to:'',cc:'',bcc:''},{...outbound,attachments:[{filename:'bad',data:'not base64'}]},{...outbound,attachments:Array.from({length:31},()=>outbound.attachments[0])},{...outbound,attachments:[{filename:'huge',data:'A'.repeat(Math.ceil(MAX_ATTACHMENTS/3)*4+4)}]}])await assert.rejects(()=>connector.send(payload));
  assert.equal(f.calls.some(c=>c[0]==='send'),false);
});

test('rejects wildcard UIDs, unknown operations and unbounded list parameters',async()=>{
  const connector=fixture().create();for(const uid of ['*','1:*',0,-1,4294967296])await assert.rejects(()=>connector.action({uid,action:'trash'}));
  await assert.rejects(()=>connector.action({uid:1,action:'expunge'}));await assert.rejects(()=>connector.messages({pageSize:10000}));await assert.rejects(()=>connector.messages({query:'x\0y'}));
});

test('operation timeout closes the transport and reports bounded failure',async()=>{
  const f=fixture({connect:()=>new Promise(()=>{})});await assert.rejects(()=>f.create({timeoutMs:20}).folders(),{code:'MAIL_TIMEOUT'});assert.ok(f.calls.some(c=>c[0]==='close'));
});

test('SMTP timeout warns that delivery is unknown and does not append or retry',async()=>{
  const f=fixture({send:()=>new Promise(()=>{})});await assert.rejects(()=>f.create({timeoutMs:20}).send(outbound),/Delivery status is unknown/);assert.equal(f.calls.filter(c=>c[0]==='send').length,1);assert.equal(f.calls.some(c=>c[0]==='append'),false);assert.ok(f.calls.some(c=>c[0]==='closeSMTP'));
});

test('reuses one authenticated IMAP session across separate inbox and message IPC connectors', async () => {
  const f = fixture();
  const session = new ImapSession();
  try {
    await f.create({imapSession:session}).folders();
    await f.create({imapSession:session}).messages();
    await f.create({imapSession:session}).message({uid:12,uidValidity:'42'});
    assert.equal(f.calls.filter(c => c[0] === 'connect').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'noop').length, 2);
    assert.equal(f.calls.filter(c => c[0] === 'release').length, 2);
  } finally { session.close(); }
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
});

test('never borrows a session authenticated with previous credentials', async () => {
  const f = fixture(), session = new ImapSession();
  try {
    for (const token of ['fixture-one','fixture-two']) {
      const authenticated = {...account, imap:{...account.imap,accessToken:token}};
      await f.create({account:authenticated, imapSession:session}).messages();
    }
    assert.deepEqual(f.options.map(opts => opts.auth.accessToken), ['fixture-one','fixture-two']);
    assert.equal(f.calls.filter(c => c[0] === 'noop').length, 0);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  } finally { session.close(); }
});

test('recovers an idle disconnect before work and never replays a failed mutation', async () => {
  const f = fixture({noop(client){client.usable=false;}, removeFlags(){throw Error('uncertain result');}});
  const session = new ImapSession();
  try {
    const mail = f.create({imapSession:session});
    await mail.messages();
    await assert.rejects(mail.action({uid:12,uidValidity:'42',action:'unread'}), /uncertain result/);
    assert.equal(f.calls.filter(c => c[0] === 'connect').length, 2);
    assert.equal(f.calls.filter(c => c[0] === 'removeFlags').length, 1);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 2);
  } finally { session.close(); }
});

test('expires idle connections and flushes mailbox updates before computing a page', async () => {
  const f = fixture({noop(client){client.mailbox.exists=83;}});
  const session = new ImapSession(15);
  try {
    const mail = f.create({imapSession:session});
    await mail.messages();
    assert.equal((await mail.messages()).total, 83);
    assert.equal(f.calls.filter(c => c[0] === 'fetchAll').at(-1)[1], '44:83');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
    await mail.messages();
    assert.equal(f.calls.filter(c => c[0] === 'connect').length, 2);
  } finally { session.close(); }
});

test('keeps a default connection through normal reading time and closes it after two idle minutes', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const f = fixture(), session = new ImapSession(), mail = f.create({imapSession:session});
  try {
    await mail.messages();
    assert.ok(f.options[0].socketTimeout > 120_000);
    t.mock.timers.tick(45_000);
    await mail.messages();
    assert.equal(f.calls.filter(c => c[0] === 'connect').length, 1);
    t.mock.timers.tick(119_999);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 0);
    t.mock.timers.tick(1);
    assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  } finally { session.close(); }
});

test('a connection that finishes after cancellation cannot mutate or become reusable', async () => {
  let finishConnect;
  const f = fixture({connect: () => new Promise(resolve => {finishConnect = resolve;})});
  const session = new ImapSession();
  const mail = f.create({imapSession:session, timeoutMs:15});
  await assert.rejects(mail.action({uid:12,action:'unread'}), {code:'MAIL_TIMEOUT'});
  finishConnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(c => c[0] === 'removeFlags'), false);
  assert.equal(f.calls.filter(c => c[0] === 'close').length, 1);
  session.close();
});

test('opens a PDF mail without fetching the attachment bytes, and saves the original on demand', async () => {
  const attachment = Buffer.alloc(2 * 1024 * 1024, 0x35);
  const headers = Buffer.from('From: Alice <alice@example.test>\r\nReferences: <old@example.test>\r\n\r\n');
  const htmlHeader = Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n');
  const fileHeader = Buffer.from('Content-Type: application/pdf\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n');
  const html = Buffer.from('<b>Se fakturaen</b>');
  const source = Buffer.from(headers.toString().trimEnd() + '\r\nContent-Type: multipart/mixed; boundary="test"\r\n\r\n--test\r\n' +
    htmlHeader + html + '\r\n--test\r\n' + fileHeader + attachment.toString('base64') + '\r\n--test--\r\n');
  const meta = {size:source.length, flags:new Set(['\\Seen']), bodyStructure:{type:'multipart/mixed',childNodes:[
    {part:'1',type:'text/html'}, {part:'2',type:'application/pdf',disposition:'attachment',dispositionParameters:{filename:'invoice.pdf'}},
  ]}};
  const parts = {headers,bodyParts:new Map([['1',html],['1.mime',htmlHeader],['2.mime',fileHeader]])};
  const fake=fixture({source,meta,parts}), connector=fake.create();
  const mail=await connector.message({uid:12,uidValidity:'42'});
  assert.match(mail.text,/Se fakturaen/);
  assert.equal(mail.from[0].address,'alice@example.test');
  assert.deepEqual(mail.references,['<old@example.test>']);
  assert.deepEqual(mail.attachments,[{index:0,filename:'invoice.pdf',contentType:'application/pdf',size:null}]);
  assert.ok(fake.calls.some(c=>c[0]==='fetchOne' && c[2].bodyParts));
  assert.ok(!fake.calls.some(c=>c[0]==='fetchOne' && c[2].source || c[0]==='addFlags'));
  const query=fake.calls.find(c=>c[0]==='fetchOne' && c[2].bodyParts)[2];
  assert.deepEqual(query.bodyParts.map(x=>x.key),['1.mime','2.mime','1']);
  const original=await connector.attachment({uid:12,index:0,uidValidity:'42'});
  assert.ok(original.data.equals(attachment));
  const missingPart=fixture({source,meta,parts:{headers,bodyParts:new Map()}});
  assert.match((await missingPart.create().message({uid:12})).text,/Se fakturaen/);
  assert.ok(missingPart.calls.some(c=>c[0]==='fetchOne' && c[2].source));
  const rejectedSections=fixture({source,meta,partsError:Object.assign(new Error('section unavailable'),{responseStatus:'NO'})});
  assert.equal((await rejectedSections.create().message({uid:12})).attachments[0].size,attachment.length);
  const disconnected=fixture({source,meta,partsError:Object.assign(new Error('disconnected'),{responseStatus:'BYE'})});
  await assert.rejects(()=>disconnected.create().message({uid:12}),/disconnected/);
  assert.ok(!disconnected.calls.some(c=>c[0]==='fetchOne' && c[2].source));
});
