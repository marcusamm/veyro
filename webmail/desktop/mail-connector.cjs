'use strict';

const {sidebarViews, searchCriteria} = require('./provider-views.cjs');

// This module never reads local files or receives a renderer-selected account ID.
// The Electron shell supplies one decrypted account and owns all disk access.
const mailLabels = require('./mail-labels.cjs');
const MAX_SOURCE = 30 * 1024 * 1024;
const MAX_ATTACHMENTS = 20 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const OPERATION_TIMEOUT = 45000;

function fail(message, code = 'INVALID_INPUT') {
  const error = new Error(message); error.code = code; throw error;
}
function string(value, label, max = 1000, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function endpoint(value, label, email) {
  if (!value || typeof value !== 'object') fail(`${label} settings are required.`);
  const host = string(value.host, `${label} hostname`, 253);
  if (!/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)*[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(host)) fail(`Use a hostname for ${label}, without a URL or path.`);
  const secure = value.secure === undefined ? label === 'IMAP' : value.secure;
  if (typeof secure !== 'boolean') fail(`Invalid ${label} encryption setting.`);
  const port = Number(value.port || (label === 'IMAP' ? (secure ? 993 : 143) : (secure ? 465 : 587)));
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`Invalid ${label} port.`);
  const user = string(value.user || email, `${label} username`, 320);
  if (value.accessToken) return {host,port,secure,user,accessToken:string(value.accessToken,`${label} OAuth token`,16384)};
  if (typeof value.password !== 'string' || !value.password || value.password.length > 4096 || /[\r\n\0]/.test(value.password)) fail(`${label} password is required.`);
  return {host, port, secure, user, password:value.password};
}
function normalizeAccount(account) {
  if (!account || typeof account !== 'object') fail('Account settings are required.');
  const email = string(account.email, 'email address', 320);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) fail('Enter a valid email address.');
  return {email, name:string(account.name, 'display name', 200, true), imap:endpoint(account.imap, 'IMAP', email), smtp:endpoint(account.smtp, 'SMTP', email), saveSent:account.saveSent !== false};
}
function checkedFolder(value = 'INBOX') { return string(value, 'folder', 1000); }
function checkedUid(value) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > 4294967295) fail('Invalid message identifier.');
  return Number(value);
}
function addresses(value) {
  const list = Array.isArray(value) ? value : value?.value || [];
  return list.flatMap(item => item.group ? addresses(item.group) : item.address ? [{name:String(item.name || '').slice(0,200), address:String(item.address).slice(0,320)}] : []);
}
function dateString(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function summary(message, gmail) {
  const env = message.envelope || {};
  return {...mailLabels.messageLabels(message, gmail), uid:message.uid, subject:String(env.subject || '').slice(0,1000), from:addresses(env.from), to:addresses(env.to), date:dateString(env.date || message.internalDate), seen:message.flags?.has('\\Seen') || false, flagged:message.flags?.has('\\Flagged') || false, size:message.size || 0};
}
function filename(value) { return String(value || 'attachment').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g,'').slice(0,200) || 'attachment'; }
function timeout(promise, cleanup, timeoutMs = OPERATION_TIMEOUT, message = 'The mail server took too long to respond. Try again.') {
  let timer;
  return Promise.race([promise,new Promise((_,reject) => { timer=setTimeout(() => { try { cleanup(); } catch {} const error=new Error(message); error.code='MAIL_TIMEOUT'; reject(error); },timeoutMs); })]).finally(() => clearTimeout(timer));
}

const CSS_PROPERTIES=new Set(('color background background-color width height min-width max-width min-height max-height display box-sizing table-layout border-collapse border-spacing caption-side empty-cells margin padding border border-radius border-width border-style border-color font font-family font-size font-weight font-style font-variant line-height letter-spacing text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-transform vertical-align white-space word-break overflow-wrap word-wrap list-style-type list-style-position float clear direction flex flex-direction flex-wrap justify-content align-content align-items align-self gap row-gap column-gap opacity').split(' '));
for(const side of ['top','right','bottom','left'])for(const name of [`padding-${side}`,`margin-${side}`,`border-${side}`,`border-${side}-width`,`border-${side}-style`,`border-${side}-color`])CSS_PROPERTIES.add(name);
for(const vertical of ['top','bottom'])for(const horizontal of ['left','right'])CSS_PROPERTIES.add(`border-${vertical}-${horizontal}-radius`);
function safeDeclarations(nodes) {
  const result=[];
  for(const node of (nodes || []).slice(0,200)){
    const name=String(node.prop || '').toLowerCase(),value=String(node.value || '').trim();
    if(node.type!=='decl'||!CSS_PROPERTIES.has(name)||!value||value.length>1024||/[\\@{}<>;\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||/\/\*|(?:url|expression|(?:-webkit-)?image-set|image|src|paint|element|attr|var)\s*\(/i.test(value))continue;
    result.push(`${name}:${value}${node.important?'!important':''}`);
  }
  return result.join(';');
}
function sanitizeCSS(source, inline=false) {
  if(typeof source!=='string'||source.length>(inline?8192:128*1024))return '';
  try{
    const root=require('postcss').parse(inline?`a{${source}}`:source);
    if(inline)return safeDeclarations(root.first?.nodes);
    let rules=0;
    function emit(nodes,depth=0){
      if(depth>1)return '';
      return (nodes || []).map(rule=>{
        if(++rules>2000)return '';
        if(rule.type==='rule'){
          const selector=rule.selector || '';
          if(selector.length>512||!selector.length||!/^[a-z\d\s.*#_>+~:,()[\]="'^|-]+$/i.test(selector))return '';
          const values=safeDeclarations(rule.nodes);return values?`${selector}{${values}}`:'';
        }
        if(rule.type==='atrule'&&rule.name.toLowerCase()==='media'&&rule.params.length<=500&&/^[a-z\d\s():.,%/-]+$/i.test(rule.params)){
          const child=emit(rule.nodes,depth+1);return child?`@media ${rule.params}{${child}}`:'';
        }
        return '';
      }).join('\n');
    }
    return emit(root.nodes);
  }catch{return '';}
}
function safeImageURL(value) {
  if(typeof value!=='string'||value.length>8192||/[\s\\\x00-\x1f\x7f]/.test(value))return null;
  try{
    const url=new URL(value),host=url.hostname.toLowerCase().replace(/\.$/,'');
    if(url.protocol!=='https:'||!/^https:\/\//i.test(value)||url.username||url.password||(url.port&&url.port!=='443')||!host.includes('.')||host.includes(':')||/^\d+(?:\.\d+){3}$/.test(host)||/(?:^|\.)(?:localhost|local|localdomain|internal|intranet|home|lan)$/.test(host))return null;
    return url.href;
  }catch{return null;}
}
function safeLinkURL(value) {
  if(typeof value!=='string'||value.length>8192||/[\s\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(value))return null;
  try{
    const url=new URL(value);
    if(/^https?:\/\/[^/\\]/i.test(value)&&url.hostname&&!url.username&&!url.password)return url.href;
    if(url.protocol==='mailto:'&&/^[^@/?#%\\,;:\s]+@[^@/?#%\\,;:\s]+$/.test(url.pathname)&&!url.hash&&!/%(?:00|0a|0d)/i.test(value)&&[...url.searchParams.keys()].every(key=>/^(subject|body)$/i.test(key)))return url.href;
  }catch{}
  return null;
}
function richMessage(source,attachments=[]) {
  if(typeof source!=='string'||!source.trim()||Buffer.byteLength(source)>2*MAX_TEXT)return {html:'',remoteImages:[]};
  const sanitizeHtml=require('sanitize-html'),remoteImages=new Set(),inlineImages=new Map();let inlineSize=0,embeddedOutput=0,imageCount=0;
  const raster=/^image\/(?:png|gif|jpe?g|webp|avif|bmp)$/i;
  for(const file of attachments){
    const cid=String(file.contentId || file.cid || '').replace(/^<|>$/g,'');
    if(!cid||!raster.test(file.contentType || '')||!Buffer.isBuffer(file.content)||file.content.length>8*1024*1024||inlineSize+file.content.length>12*1024*1024)continue;
    inlineSize+=file.content.length;inlineImages.set(cid,`data:${file.contentType.toLowerCase()};base64,${file.content.toString('base64')}`);
  }
  const common=['class','id','title','dir','lang','align','valign','bgcolor','color','face','size','width','height','cellpadding','cellspacing','border','colspan','rowspan','nowrap','role','aria-label','style'];
  let body=sanitizeHtml(source,{
    allowedTags:'a address article b bdi bdo blockquote br caption center code col colgroup dd del div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr i img li main mark ol p pre s section small span strong style sub sup table tbody td tfoot th thead tr u ul wbr'.split(' '),
    allowedAttributes:{'*':common,a:['href','target','rel','referrerpolicy'],img:['src','alt','referrerpolicy','decoding'],style:['media']},
    allowedSchemes:['https','http','mailto'],allowedSchemesByTag:{img:['https','data']},allowProtocolRelative:false,allowVulnerableTags:true,parseStyleAttributes:false,
    nonTextTags:['script','textarea','option','iframe','object','embed','noscript','svg','math','template'],
    transformTags:{'*':(tagName,attributes)=>{
      const attrs={...attributes};
      for(const [name,value] of Object.entries(attrs))if(value.length>(tagName==='img'&&name==='src'?12*1024*1024:8192)||name.startsWith('on'))delete attrs[name];
      if(attrs.style){attrs.style=sanitizeCSS(attrs.style,true);if(!attrs.style)delete attrs.style;}
      if(tagName==='a'){
        const href=safeLinkURL(attrs.href);if(href){attrs.href=href;attrs.target='_self';attrs.rel='noopener noreferrer';attrs.referrerpolicy='no-referrer';attrs.title=href;}else delete attrs.href;
      }
      if(tagName==='img'){
        let src=attrs.src || '';
        if(/^cid:/i.test(src)){try{src=inlineImages.get(decodeURIComponent(src.slice(4)).replace(/^<|>$/g,'')) || '';}catch{src='';}}
        if(/^data:/i.test(src)){
          if(src.length>12*1024*1024||!/^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);base64,[a-z\d+/]+={0,2}$/i.test(src))src='';
          if(embeddedOutput+src.length>16*1024*1024)src='';else embeddedOutput+=src.length;
        }else{src=safeImageURL(src) || '';if(src&&!remoteImages.has(src)&&remoteImages.size>=200)src='';if(src)remoteImages.add(src);}
        if(++imageCount>500)src='';
        if(src)attrs.src=src;else delete attrs.src;
        attrs.alt=String(attrs.alt || 'Billede').slice(0,2000);attrs.referrerpolicy='no-referrer';attrs.decoding='async';
      }
      if(tagName==='style'&&attrs.media&&!/^[a-z\d\s():.,%/-]{1,500}$/i.test(attrs.media))delete attrs.media;
      return {tagName,attribs:attrs};
    }},
  });
  // sanitize-html deliberately does not textFilter <style> raw text. Its HTML
  // parser has now normalized/closed every permitted style element; sanitize
  // each of those stylesheet bodies separately before the document is used.
  body=body.replace(/(<style\b[^>]*>)([\s\S]*?)<\/style>/gi,(_match,opening,css)=>`${opening}${sanitizeCSS(css)}</style>`);
  const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}body{margin:16px;color:#25241f;font:14px/1.65 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}img:not([src]){display:none}table{max-width:100%}a{color:#9b3914}pre{white-space:pre-wrap}</style></head><body>'+body+'</body></html>';
  return {html,remoteImages:[...remoteImages]};
}

// Owned by one account in the Electron main process. A client is checked out
// exclusively; a second simultaneous operation can never switch its mailbox.
class ImapSession {
  constructor(idleMs = 120_000) {
    this.idleMs = idleMs;
    this.clients = new Set();
  }
  take(key) {
    const idle = this.idle;
    if (!idle) return null;
    this.idle = undefined;
    clearTimeout(this.timer);
    if (idle.key === key && idle.client.usable) return idle.client;
    this.discard(idle.client);
    return null;
  }
  track(client) {
    if (this.closed) fail('The account session was closed.', 'SESSION_CLOSED');
    this.clients.add(client);
    return client;
  }
  keep(key, client) {
    if (!this.clients.has(client) || !client.usable) {
      this.discard(client);
      return;
    }
    if (this.idle) this.discard(this.idle.client);
    this.idle = {key, client};
    this.timer = setTimeout(() => this.discard(client), this.idleMs);
    this.timer.unref();
  }
  discard(client) {
    if (this.idle?.client === client) {
      this.idle = undefined;
      clearTimeout(this.timer);
    }
    if (this.clients.delete(client)) client.close();
  }
  close() {
    this.closed = true;
    for (const client of this.clients) this.discard(client);
  }
}

function createMailConnector({account, dependencies = {}, timeoutMs = OPERATION_TIMEOUT, imapSession}) {
  const config = normalizeAccount(account);
  const mailboxKey=require('node:crypto').createHash('sha256').update(JSON.stringify([config.email.toLowerCase(),config.imap.host.toLowerCase(),config.imap.port,config.imap.secure,config.imap.user])).digest('hex');
  // This digest stays in memory and is never logged or written to disk. A
  // changed identity, endpoint or token must authenticate a new connection.
  const sessionKey = imapSession && require('node:crypto').createHash('sha256')
    .update(JSON.stringify([mailboxKey, account.oauthSubject, config.imap])).digest('hex');
  const ImapFlow = dependencies.ImapFlow || require('imapflow').ImapFlow;
  const nodemailer = dependencies.nodemailer || require('nodemailer');
  const parse = dependencies.simpleParser || require('mailparser').simpleParser;
  const addressparser = dependencies.addressparser || require('nodemailer/lib/addressparser');
  const MailComposer = dependencies.MailComposer || require('nodemailer/lib/mail-composer');
  const tls = {rejectUnauthorized:true,minVersion:'TLSv1.2'};
  function imap() {
    const s=config.imap;
    // The session owns idle expiry. In-flight requests still have their
    // separate, shorter operation timeout in withImap().
    const socketTimeout = imapSession ? imapSession.idleMs + OPERATION_TIMEOUT : 30_000;
    const client = new ImapFlow({host:s.host,port:s.port,secure:s.secure,...(!s.secure ? {doSTARTTLS:true} : {}),auth:s.accessToken?{user:s.user,accessToken:s.accessToken}:{user:s.user,pass:s.password},tls:{...tls,servername:s.host},logger:false,disableAutoIdle:true,connectionTimeout:15000,greetingTimeout:10000,socketTimeout,maxLineLength:1024*1024,maxLiteralSize:MAX_SOURCE+1,maxResponseSize:MAX_SOURCE+2*1024*1024});
    // Network failures must reject the operation rather than crash the process.
    client.on('error', () => {});
    return client;
  }
  function smtp() {
    const s=config.smtp;
    return nodemailer.createTransport({host:s.host,port:s.port,secure:s.secure,requireTLS:!s.secure,ignoreTLS:false,opportunisticTLS:false,auth:s.accessToken?{type:'OAuth2',user:s.user,accessToken:s.accessToken}:{user:s.user,pass:s.password},tls:{...tls,servername:s.host},logger:false,debug:false,connectionTimeout:15000,greetingTimeout:10000,socketTimeout:30000,dnsTimeout:10000,disableFileAccess:true,disableUrlAccess:true});
  }
  async function withImap(folder, operation, expectedValidity) {
    let client = imapSession?.take(sessionKey);
    let expired = false;
    function discard() {
      if (!client) return;
      if (imapSession) imapSession.discard(client);
      else client.close();
    }
    const work = (async () => {
      let lock, success = false;
      try {
        if (client) {
          // Flush pending EXISTS/EXPUNGE updates before pagination reads the
          // selected mailbox count. Only this side-effect-free probe is retried.
          try {
            await client.noop();
            if (!client.usable) fail('The mail server disconnected.', 'MAIL_DISCONNECTED');
          }
          catch (error) {
            discard();
            if (expired || imapSession.closed) throw error;
            client = null;
          }
        }
        if (!client) {
          client = imapSession ? imapSession.track(imap()) : imap();
          await client.connect();
        }
        if (expired || imapSession?.closed) fail('The account session was closed.', 'SESSION_CLOSED');
        if (folder !== null) {
          lock=await client.getMailboxLock(checkedFolder(folder));
          if (expectedValidity !== undefined && String(client.mailbox.uidValidity) !== String(expectedValidity)) fail('This folder has changed on the server. Refresh it before opening or changing this message.', 'STALE_MAILBOX');
        }
        if (expired || imapSession?.closed) fail('The account session was closed.', 'SESSION_CLOSED');
        const result = await operation(client);
        success = true;
        return result;
      } finally {
        if (lock) lock.release();
        if (imapSession && success && !expired) imapSession.keep(sessionKey, client);
        else discard();
      }
    })();
    return timeout(work, () => { expired = true; discard(); }, timeoutMs);
  }
  const parseOptions = {skipHtmlToText:false,skipTextToHtml:true,skipImageLinks:true,maxHtmlLengthToParse:MAX_TEXT};
  async function parseSource(source) {
    if (source.length > MAX_SOURCE) fail('This message exceeds the 30 MB reading limit.', 'MESSAGE_TOO_LARGE');
    const mail = await parse(source,parseOptions);
    // MailParser may omit the text version of HTML nested in multipart/mixed.
    if (!mail.text && typeof mail.html === 'string' && Buffer.byteLength(mail.html) <= MAX_TEXT) {
      const htmlPart = Buffer.from(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${mail.html}`);
      const fallback = await parse(htmlPart,parseOptions);
      mail.text = fallback.text || '';
    }
    return mail;
  }
  function parsedMessage(meta, mail, uidValidity, gmail) {
    const text = String(mail.text || '');
    return {
      ...summary(meta, gmail), mailboxKey, uidValidity:String(uidValidity),
      text:text.slice(0,MAX_TEXT), textTruncated:text.length > MAX_TEXT,
      ...richMessage(mail.html,mail.attachments),
      from:addresses(mail.from), to:addresses(mail.to), cc:addresses(mail.cc),
      bcc:addresses(mail.bcc), replyTo:addresses(mail.replyTo), messageId:mail.messageId || '',
      references:Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [],
      attachments:(mail.attachments || []).map((file,index) => ({
        index, filename:filename(file.filename), contentType:file.contentType,
        size:file.deferred ? null : file.size || file.content.length,
      })),
    };
  }
  async function read(client, uid, preview = false, sizeHint) {
    // A row's size is only a hint. Ask for one extra byte so a truncated
    // response cannot be mistaken for a complete message, even on a bad hint.
    const readAhead = preview && Number.isSafeInteger(sizeHint) && sizeHint > 0 && sizeHint < 512 * 1024;
    const query = {uid:true,envelope:true,flags:true,labels:true,size:true,internalDate:true};
    if (preview) query.bodyStructure = true;
    if (readAhead) query.source = {start:0,maxLength:sizeHint + 1};
    const meta = await client.fetchOne(uid, query, {uid:true});
    if (!meta) fail('This message is no longer in this folder. Refresh the folder.', 'NOT_FOUND');
    if (meta.size > MAX_SOURCE || meta.source?.length > MAX_SOURCE) fail('This message exceeds the 30 MB reading limit. Open it in your provider’s webmail.', 'MESSAGE_TOO_LARGE');
    const complete = readAhead && Buffer.isBuffer(meta.source) && meta.source.length === meta.size && meta.size <= sizeHint;
    let mail;
    if (complete) mail = await parseSource(meta.source);
    else if (preview) mail = await require('./message-preview.cjs').messagePreview(client,uid,meta,parseSource,parseOptions);
    if (!mail) {
      const fetched=await client.fetchOne(uid,{source:{start:0,maxLength:MAX_SOURCE+1}},{uid:true});
      if (!fetched?.source) fail('The server did not return this message.', 'NOT_FOUND');
      mail=await parseSource(fetched.source);
    }
    return {meta,mail};
  }
  function recipients(value, label) {
    if (value === undefined || value === null || value === '') return [];
    if (typeof value !== 'string' || value.length > 10000 || /[\r\n\0]/.test(value)) fail(`Invalid ${label} recipients.`);
    const parsed=addresses(addressparser(value));
    if (!parsed.length || parsed.some(item => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(item.address))) fail(`Enter valid ${label} email addresses, separated by commas.`);
    return parsed;
  }
  function compose(payload) {
    if (!payload || typeof payload !== 'object') fail('A message is required.');
    const to=recipients(payload.to,'To'),cc=recipients(payload.cc,'Cc'),bcc=recipients(payload.bcc,'Bcc');
    if (!to.length && !cc.length && !bcc.length) fail('Add at least one recipient.');
    if (to.length+cc.length+bcc.length > 100) fail('A message can have at most 100 recipients.');
    const subject=string(payload.subject,'subject',998,true);
    if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text)>MAX_TEXT || payload.text.includes('\0')) fail('The message text must be smaller than 1 MB.');
    if (payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length>30)) fail('Attach at most 30 files.');
    let total=0;
    const attachments=(payload.attachments || []).map(item => {
      if (!item || typeof item.data !== 'string' || item.data.length>Math.ceil(MAX_ATTACHMENTS/3)*4 || item.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) fail('Invalid attachment data.');
      const content=Buffer.from(item.data,'base64'); total+=content.length;
      if (total>MAX_ATTACHMENTS) fail('Attachments must total 20 MB or less.');
      return {filename:filename(item.filename),content,contentType:string(item.contentType || 'application/octet-stream','attachment type',150)};
    });
    const inReplyTo=string(payload.inReplyTo,'reply identifier',1000,true);
    const references=(Array.isArray(payload.references) ? payload.references : payload.references ? [payload.references] : []).slice(-50).map(item => string(item,'reference',1000));
    return {from:{name:config.name,address:config.email},to,cc,bcc,subject,text:payload.text,attachments,...(inReplyTo?{inReplyTo}:{}),...(references.length?{references}:{}),disableFileAccess:true,disableUrlAccess:true};
  }
  async function specialFolder(client, specialUse, names) {
    const folders=await client.list();
    if (client.capabilities?.has('X-GM-EXT-1')) {
      return folders.find(f=>!f.flags?.has('\\Noselect') && !mailLabels.isGmailUserLabel(f) &&
        (f.specialUse===specialUse || f.flags?.has(specialUse)))?.path;
    }
    return folders.find(f=>f.specialUse===specialUse)?.path || folders.find(f=>names.includes(String(f.name || f.path).toLowerCase()))?.path;
  }
  async function listMailboxSidebar(client) {
    const gmail = client.capabilities?.has('X-GM-EXT-1') || false;
    const listed = await client.list({statusQuery:{messages:true,unseen:true}});
    const folders = listed.filter(f => !f.flags?.has('\\Noselect') && !f.flags?.has('\\NonExistent')).map(f => {
      // ImapFlow recognizes the standard roles, but leaves Gmail's Important
      // role (and newer optional server roles) in the original LIST flags.
      const flags = new Set(Array.from(f.flags || [], flag => flag.toLowerCase()));
      const role = ['\\Important', '\\Snoozed', '\\Scheduled'].find(flag => flags.has(flag.toLowerCase())) || f.specialUse || '';
      const label = gmail && mailLabels.isGmailUserLabel(f);
      return {path:f.path, name:f.name || f.path, specialUse:label ? '' : role,
        total:f.status?.messages || 0, unseen:f.status?.unseen || 0, gmailLabels:gmail, label};
    }).sort((a,b) => a.path==='INBOX' ? -1 : b.path==='INBOX' ? 1 : a.path.localeCompare(b.path));
    return {folders, gmail, views:sidebarViews(folders, {gmail})};
  }
  return Object.freeze({
    async verify() {
      await withImap(null,client=>client.list());
      const transport=smtp();
      try { await timeout(transport.verify(),()=>transport.close(),timeoutMs); return {ok:true}; }
      finally { transport.close(); }
    },
    async folders() {
      return withImap(null, async client => (await listMailboxSidebar(client)).folders);
    },
    async sidebar() {
      return withImap(null, listMailboxSidebar);
    },
    async manageLabel(payload = {}) {
      return withImap(null, client => mailLabels.manageLabel(client, payload));
    },
    async messageLabel({folder='INBOX',uid,uidValidity,add,remove,name,enabled}={}) {
      uid=checkedUid(uid);
      if (typeof uidValidity !== 'string' || !/^[1-9]\d{0,9}$/.test(uidValidity)) fail('Opdater mappen, og prøv igen.', 'STALE_MAILBOX');
      if (name !== undefined || enabled !== undefined) {
        if (typeof enabled !== 'boolean' || add !== undefined || remove !== undefined) fail('Ugyldig etiketændring.');
        if (enabled) add = [name];
        else remove = [name];
      }
      return withImap(folder, client => mailLabels.messageLabel(client,uid,{add,remove}),uidValidity);
    },
    async warmMessages({folder, uidValidity, messages}) {
      const wanted = require('./mail-read-ahead.cjs').smallMessages(messages);
      if (!wanted.size) return [];
      return withImap(folder, async client => {
        const maxLength = Math.max(...wanted.values()) + 1;
        // ImapFlow uses BODY.PEEK for source, including a bounded partial.
        const fetched = await client.fetchAll([...wanted.keys()], {
          uid:true, envelope:true, flags:true, labels:true, size:true, internalDate:true,
          source:{start:0, maxLength},
        }, {uid:true});
        const results = [];
        for (const meta of fetched) {
          if (imapSession?.closed) break;
          if (!wanted.has(meta.uid) || meta.size !== wanted.get(meta.uid) ||
              !Buffer.isBuffer(meta.source) || meta.source.length !== meta.size) continue;
          wanted.delete(meta.uid);
          try {
            const mail = await parseSource(meta.source);
            results.push(parsedMessage(meta, mail, String(client.mailbox.uidValidity), !!client.capabilities?.has('X-GM-EXT-1')));
          } catch {
            // A malformed body in this batch must not hold up its neighbours.
          }
        }
        return results;
      }, uidValidity);
    },
    async messages({folder='INBOX',filter,keywordLabel,query='',page=1,pageSize=40}={}) {
      if (!Number.isInteger(page) || page<1 || page>100000 || !Number.isInteger(pageSize) || pageSize<1 || pageSize>100) fail('Invalid message page.');
      query=string(query,'search',250,true);
      return withImap(folder,async client => {
        let total=client.mailbox.exists || 0,range,byUid=false;
        const gmail = !!client.capabilities?.has('X-GM-EXT-1');
        let criteria = searchCriteria(filter, query, gmail);
        if (keywordLabel !== undefined) {
          if (gmail) fail('Denne mappe bruger Gmail-etiketter.');
          criteria = {...criteria, keyword:mailLabels.labelKeyword(keywordLabel)};
        }
        if (criteria) {
          const matches=await client.search(criteria,{uid:true});
          if (!Array.isArray(matches)) fail('The server could not complete this search.');
          if (matches.length>250000) fail('Too many matches. Use a more specific search.');
          matches.sort((a,b)=>b-a); total=matches.length;
          range=matches.slice((page-1)*pageSize,page*pageSize); byUid=true;
        } else {
          const end=total-(page-1)*pageSize;
          range=end>0 ? `${Math.max(1,end-pageSize+1)}:${end}` : [];
        }
        const result=Array.isArray(range)&&range.length===0 ? [] : await client.fetchAll(range,{uid:true,envelope:true,flags:true,labels:true,size:true,internalDate:true},{uid:byUid});
        const messages = result.sort((a,b)=>b.uid-a.uid).map(message => summary(message, gmail));
        const availableLabels = gmail ? [] : [...new Set([
          ...mailLabels.keywordNames(client.mailbox.flags), ...messages.flatMap(message => message.labels),
        ])].sort((a,b) => a.localeCompare(b, 'da'));
        return {messages,total,page,pageSize,hasNext:page*pageSize<total,uidValidity:String(client.mailbox.uidValidity),
          keywordLabels:!gmail && mailLabels.supportsKeywordLabels(client.mailbox), availableLabels};
      });
    },
    async message({folder='INBOX',uid,uidValidity,sizeHint,markSeen=true}={}) {
      uid=checkedUid(uid);
      return withImap(folder,async client => {
        const {meta,mail}=await read(client,uid,true,sizeHint);
        const message = parsedMessage(meta,mail,client.mailbox.uidValidity,!!client.capabilities?.has('X-GM-EXT-1'));
        if (!message.seen && markSeen !== false) {
          await client.messageFlagsAdd(uid,['\\Seen'],{uid:true});
          message.seen = true;
        }
        return message;
      },uidValidity);
    },
    async attachment({folder='INBOX',uid,index,uidValidity}={}) {
      uid=checkedUid(uid);
      if (!Number.isInteger(index) || index<0 || index>10000) fail('Invalid attachment.');
      return withImap(folder,async client => {
        const {mail}=await read(client,uid),file=mail.attachments?.[index];
        if (!file) fail('Attachment not found.', 'NOT_FOUND');
        return {filename:filename(file.filename),contentType:file.contentType,data:Buffer.from(file.content)};
      },uidValidity);
    },
    async action({folder='INBOX',uid,action,uidValidity}={}) {
      uid=checkedUid(uid);
      if (!['read','unread','star','unstar','important','unimportant','archive','trash'].includes(action)) fail('Unknown message action.');
      const changeImportant = action==='important' || action==='unimportant';
      if (changeImportant && !/^\d+$/.test(String(uidValidity))) fail('Opdater listen, og vælg mailen igen.', 'STALE_MAILBOX');
      return withImap(folder,async client => {
        if (!await client.fetchOne(uid,{uid:true},{uid:true})) fail('This message is no longer in this folder.', 'NOT_FOUND');
        const gmail = client.capabilities.has('X-GM-EXT-1');
        const restoreToArchive = gmail && action==='archive' && ['\\Junk','\\Trash'].includes(client.mailbox.specialUse);
        if (action==='archive' && gmail && !restoreToArchive) {
          // A category row belongs to All Mail. Moving it into its own folder
          // would do nothing, and moving from a label could remove that label.
          if (!await client.messageFlagsRemove(uid,['\\Inbox'],{uid:true,useLabels:true})) fail('Mailen kunne ikke arkiveres.');
        } else if (['archive','trash'].includes(action)) {
          let target;
          if (restoreToArchive) target=await specialFolder(client,'\\All',[]);
          else if (action==='archive') target=await specialFolder(client,'\\Archive',['archive','archives']);
          else target=await specialFolder(client,'\\Trash',['trash','deleted items','deleted messages','bin']);
          if(!target&&!gmail&&action==='archive'&&/(^|\.)(?:gmail|googlemail)\.com$/i.test(config.imap.host))target=await specialFolder(client,'\\All',['all mail']);
          if(!target&&restoreToArchive) fail('Aktivér Alle mails i Gmails IMAP-indstillinger, eller flyt mailen i Gmail.','FOLDER_MISSING');
          if (!target) fail(`Your server has no ${action==='archive'?'Archive':'Trash'} folder. Create one in your provider’s webmail, then refresh.`,'FOLDER_MISSING');
          if (target===folder) return {ok:true};
          if (!client.capabilities.has('MOVE')&&!client.capabilities.has('UIDPLUS')) fail('This server cannot move one message safely. Use your provider’s webmail for this action.','MOVE_UNSUPPORTED');
          if (!await client.messageMove(uid,target,{uid:true})) fail('The server did not move this message.');
        } else if (changeImportant) {
          if (!client.capabilities?.has('X-GM-EXT-1')) fail('Denne konto understøtter ikke markering som vigtig.');
          const method = action==='important' ? 'messageFlagsAdd' : 'messageFlagsRemove';
          if (!await client[method](uid,['\\Important'],{uid:true,useLabels:true})) fail('Markeringen kunne ikke gemmes.');
        } else {
          const flag=['read','unread'].includes(action)?'\\Seen':'\\Flagged';
          const method=['read','star'].includes(action)?'messageFlagsAdd':'messageFlagsRemove';
          if (!await client[method](uid,[flag],{uid:true})) fail('The server did not update this message.');
        }
        return {ok:true};
      },uidValidity);
    },
    async send(payload) {
      // Forwarded files are resolved from this account's IMAP message, never a
      // renderer-supplied path or URL. Revalidate UIDVALIDITY before reading.
      if (payload?.forwardedAttachments !== undefined) {
        if (!Array.isArray(payload.forwardedAttachments) || payload.forwardedAttachments.length>30) fail('Invalid forwarded attachments.');
        if (payload.attachments!==undefined&&!Array.isArray(payload.attachments)) fail('Invalid attachments.');
        const files=[...(payload.attachments || [])],groups=new Map();let forwardedBytes=0;
        for (const file of payload.forwardedAttachments) {
          if (!file || !Number.isInteger(file.index) || file.index<0 || file.index>10000) fail('Invalid forwarded attachment.');
          if(file.mailboxKey!==mailboxKey)fail('This forwarded attachment belongs to a different mailbox. Open the original message in that account and forward it again.','MAILBOX_CHANGED');
          const source={folder:checkedFolder(file.folder),uid:checkedUid(file.uid),uidValidity:string(file.uidValidity,'folder version',30)};
          const key=JSON.stringify(source);if(!groups.has(key))groups.set(key,{source,indexes:[]});groups.get(key).indexes.push(file.index);
        }
        for(const {source,indexes} of groups.values()) {
          await withImap(source.folder,async client=>{
            const {mail}=await read(client,source.uid);
            for(const index of indexes){const file=mail.attachments?.[index];if(!file)fail('A forwarded attachment is no longer available.','NOT_FOUND');forwardedBytes+=file.content.length;if(forwardedBytes>MAX_ATTACHMENTS)fail('Attachments must total 20 MB or less.');files.push({filename:filename(file.filename),contentType:file.contentType,data:file.content.toString('base64')});}
          },source.uidValidity);
        }
        payload={...payload,attachments:files};
      }
      const mail=compose(payload);
      // Compile once: transport and Sent copy must have the same Message-ID.
      // Bcc remains in the envelope, never in the raw message saved or sent.
      const mime=new MailComposer(mail).compile();
      mime.keepBcc=false;
      const compiled={envelope:mime.getEnvelope(),messageId:mime.messageId(),message:await mime.build()};
      if (!Buffer.isBuffer(compiled.message) || compiled.message.length>MAX_SOURCE) fail('The encoded message exceeds 30 MB. Remove an attachment.');
      const transport=smtp(); let sent;
      try { sent=await timeout(transport.sendMail({envelope:compiled.envelope,raw:compiled.message,disableFileAccess:true,disableUrlAccess:true}),()=>transport.close(),timeoutMs,'Sending timed out. Delivery status is unknown. Check Sent or contact the recipient before trying again.'); }
      finally { transport.close(); }
      let warning='';
      // Gmail adds sent messages itself. Most other IMAP providers need APPEND.
      if (config.saveSent&&!/(^|\.)gmail\.com$/i.test(config.smtp.host)&&!/(^|\.)googlemail\.com$/i.test(config.smtp.host)) {
        try {
          await withImap(null,async client => {
            const target=await specialFolder(client,'\\Sent',['sent','sent items','sent messages']);
            if (!target) fail('No Sent folder was found.');
            await client.append(target,compiled.message,['\\Seen']);
          });
        } catch { warning='Message sent, but a copy could not be saved to your Sent folder. Do not resend it.'; }
      }
      return {ok:true,messageId:compiled.messageId,accepted:(sent.accepted || []).map(String),rejected:(sent.rejected || []).map(String),warning};
    }
  });
}

module.exports={createMailConnector,ImapSession,normalizeAccount,richMessage,sanitizeCSS,safeImageURL,MAX_SOURCE,MAX_ATTACHMENTS};
