'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const realNodemailer=require('nodemailer');
const {simpleParser}=require('mailparser');
const {createMailConnector,normalizeAccount,richMessage,sanitizeCSS,safeImageURL,MAX_SOURCE,MAX_ATTACHMENTS}=require('./mail-connector.cjs');

const account={email:'owner@example.test',name:'Account Owner',imap:{host:'imap.example.test',port:993,secure:true,user:'owner@example.test',password:'unit-test-password'},smtp:{host:'smtp.example.test',port:587,secure:false,user:'owner@example.test',password:'unit-test-password'}};
const raw=Buffer.from('From: Sender <sender@example.test>\r\nTo: Account Owner <owner@example.test>\r\nCc: Other <other@example.test>\r\nSubject: Test message\r\nMessage-ID: <inbound@example.test>\r\nDate: Fri, 27 Nov 2026 12:00:00 +0000\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="test-boundary"\r\n\r\n--test-boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello from HTML</p><img src="https://tracker.example.test/pixel"><script>window.pwned=true</script>\r\n--test-boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="../../note.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n--test-boundary--\r\n');
function fixture(overrides={}) {
  const calls=[],options=[],transports=[];
  const folders=[{path:'INBOX',name:'INBOX',flags:new Set(),status:{messages:82,unseen:3}},{path:'Sent',name:'Sent',specialUse:'\\Sent',flags:new Set()},{path:'Archive',name:'Archive',specialUse:'\\Archive',flags:new Set()},{path:'Trash',name:'Trash',specialUse:'\\Trash',flags:new Set()},{path:'Container',name:'Container',flags:new Set(['\\Noselect'])}];
  const meta={uid:12,size:raw.length,envelope:{subject:'Test message',from:[{name:'Sender',address:'sender@example.test'}],to:[{address:account.email}],date:new Date('2026-11-27T12:00:00Z')},flags:new Set(['\\Flagged'])};
  class FakeImap extends EventEmitter {
    constructor(opts){super();options.push(opts);this.mailbox={exists:82,uidValidity:42n};this.capabilities=new Set(['MOVE','UIDPLUS']);this.closed=false;}
    async connect(){calls.push(['connect']);if(overrides.connect)return overrides.connect(this);}
    close(){this.closed=true;calls.push(['close']);}
    async getMailboxLock(folder){calls.push(['lock',folder]);return {release:()=>calls.push(['release'])};}
    async list(opts){calls.push(['list',opts]);return overrides.folders || folders;}
    async search(query,opts){calls.push(['search',query,opts]);return overrides.search || [1,44,22,88,3];}
    async fetchAll(range,query,opts){calls.push(['fetchAll',range,query,opts]);return [{...meta,uid:4},{...meta,uid:9}];}
    async fetchOne(uid,query,opts){calls.push(['fetchOne',uid,query,opts]);if(overrides.missing)return false;if(query.source)return {source:overrides.source || raw};return {...meta,...overrides.meta};}
    async messageFlagsAdd(...args){calls.push(['addFlags',...args]);return true;}
    async messageFlagsRemove(...args){calls.push(['removeFlags',...args]);return true;}
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

test('attachment uses UID and MIME index and strips path components',async()=>{
  const f=fixture(),file=await f.create().attachment({folder:'INBOX',uid:12,index:0,uidValidity:'42'});
  assert.equal(file.filename,'note.txt');assert.equal(file.data.toString(),'hello');assert.equal(f.calls.some(c=>c[0]==='addFlags'),false);
  await assert.rejects(()=>f.create().attachment({uid:12,index:1}),/Attachment not found/);
});

test('UIDVALIDITY mismatch fails before fetching or changing a message',async()=>{
  const f=fixture();await assert.rejects(()=>f.create().action({uid:12,uidValidity:'41',action:'trash'}),{code:'STALE_MAILBOX'});
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
