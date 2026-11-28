'use strict';
// A credential-free browser fixture. No request reaches a real mail server.
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('../../../node_modules/playwright');
const root=path.resolve(__dirname,'..');
const {richMessage}=require('../mail-connector.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwXkAAAAASUVORK5CYII=','base64');
const rich=richMessage('<style>.brand{color:rgb(191,66,20);font-size:28px;background:url(https://leak.example.test/bg)}@import "https://leak.example.test/css";</style><table width="100%"><tr><td><h1 class="brand">Et mere levende brev.</h1><p>Din mail beholder sit layout og sine indlejrede billeder.</p><img id="cid" src="cid:logo" width="60"><img id="external" src="https://images.example.test/pixel.png" alt="Eksternt billede"><a href="https://safe.example.test/read">Læs mere</a></td></tr></table><script>parent.injected=true</script><img src="javascript:alert(1)" onerror="parent.injected=true"><iframe src="https://leak.example.test/frame"></iframe>',[{cid:'logo',contentType:'image/png',content:png}]);
const assets={'/':['mail-client.html','text/html'],'/mail-client.js':['mail-client.js','text/javascript'],'/mail-client.css':['mail-client.css','text/css'],'/manrope.woff2':['assets/manrope.woff2','font/woff2']};
async function main(){
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/rich-host'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Rich mail fixture</title><script>window.veyroMail={private:true}</script><iframe title="Sandboxed email" sandbox="" style="width:90vw;height:80vh" src="/rich-child"></iframe>');return;}
    if(req.url==='/rich-child'||req.url==='/rich-child?images=1'){res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${req.url.includes('?')?' https:':''}; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox`);res.end(rich.html);return;}
    const route=assets[req.url.split('?')[0]];if(!route){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',route[1]);res.end(await fs.readFile(path.join(root,route[0])));}catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    const installFixture=()=>{
      const identity={id:'fixture-account',label:'Studio',configured:true,account:{email:'owner@example.test',name:'Test Owner',imap:{host:'imap.example.test',port:993,secure:true,user:'owner@example.test'},smtp:{host:'smtp.example.test',port:587,secure:false,user:'owner@example.test'}},oauth:{google:{available:false},microsoft:{available:false}}};
      const query=new URL(location.href).searchParams;
      if(query.has('setup')){identity.configured=false;identity.account=null;identity.oauth.google.available=!query.has('unavailable');}
      const sample={uid:12,subject:'En god begyndelse',from:[{name:'Sofie Andersen',address:'sofie@example.test'}],to:[{name:'Test Owner',address:'owner@example.test'}],cc:[{address:'team@example.test'}],date:'2026-11-27T12:00:00Z',seen:false,flagged:true,size:1200,uidValidity:'42'};
      let drafts=[];window.__calls=[];
      window.veyroMail={invoke:async(action,payload={})=>{
        window.__calls.push({action,payload:structuredClone(payload)});
        if(action==='bootstrap')return structuredClone(identity);
        if(action==='folders')return [{path:'INBOX',name:'INBOX',unseen:2},{path:'Sent',name:'Sent',specialUse:'\\Sent'},{path:'Archive',name:'Archive',specialUse:'\\Archive'},{path:'Trash',name:'Trash',specialUse:'\\Trash'}];
        if(action==='messages')return {messages:payload.query==='nothing'?[]:[{...sample},{...sample,uid:11,from:[{name:'Veyro',address:'hello@example.test'}],subject:'Dit næste projekt starter her',flagged:false,seen:true},...(query.has('readerTest')?[{...sample,uid:10,subject:'Et tredje brev'}]:[])],total:82,page:payload.page,pageSize:40,hasNext:payload.page<3,uidValidity:'42'};
        if(action==='message' && window.__holdReads){
          await new Promise(resolve=>{window.__finishRead=()=>{delete window.__finishRead;resolve();};});
        }
        if(action==='message')return {...sample,uid:payload.uid,subject:payload.uid===10?'Et tredje brev':payload.uid===11?'Dit næste projekt starter her':sample.subject,seen:true,text:'Hej Test Owner,\n\nTak for en rigtig god samtale i går. Jeg har samlet vores tanker om det nye projekt, så vi kan finde den rigtige retning sammen.\n\nLad os mødes på torsdag og se på de første skitser.\n\nBedste hilsner\nSofie\n\n<img src=x onerror="window.injected=true">',replyTo:[],messageId:'<test@example.test>',references:[],attachments:[{index:0,filename:'Projektbeskrivelse.pdf',contentType:'application/pdf',size:42800},...(query.has('readerTest')?[{index:1,filename:'Original.zip',contentType:'application/zip',size:null}]:[])]};
        if(action==='action'||action==='saveAttachment')return {ok:true};
        if(action==='drafts')return structuredClone(drafts);
        if(action==='saveDraft'){if(window.__draftDelay)await new Promise(resolve=>setTimeout(resolve,window.__draftDelay));const draft={...payload,id:payload.id || 'fixture-draft'};drafts=drafts.filter(d=>d.id!==draft.id).concat(draft);return structuredClone(draft);}
        if(action==='deleteDraft'){drafts=drafts.filter(d=>d.id!==payload.id);return {ok:true};}
        if(action==='send')return {ok:true,accepted:[payload.to],rejected:[],warning:''};
        if(action==='configure'){identity.configured=true;identity.account={...payload,imap:{...payload.imap,password:undefined},smtp:{...payload.smtp,password:undefined}};return structuredClone(identity);}
        if(action==='oauthConnect'){identity.configured=true;identity.account={email:'owner@example.test',name:'Verified Google User',authType:'oauth',oauthProvider:payload.provider,imap:{host:'imap.gmail.com',port:993,secure:true,user:'owner@example.test'},smtp:{host:'smtp.gmail.com',port:587,secure:false,user:'owner@example.test'}};return structuredClone(identity);}
        throw new Error('Unexpected mock action '+action);
      }};
    };
    await page.addInitScript(installFixture);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.getByRole('button',{name:/En god begyndelse/}).click();
    await page.locator('#message-body').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('#message-body img').count(),0);
    await page.locator('#message-attachments button').click();
    assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.action==='saveAttachment').length),1);
    await page.locator('#reply-all').click();assert.match(await page.locator('#to').inputValue(),/sofie@example.test/);assert.doesNotMatch(await page.locator('#to').inputValue(),/owner@example.test/);assert.equal(await page.locator('#cc').inputValue(),'team@example.test');
    await page.locator('#body').fill('Tak, torsdag passer fint.');await page.locator('#save-draft').click();await page.getByText('Kladde gemt på denne computer.',{exact:true}).waitFor();
    await page.locator('#close-compose').click();await page.locator('#drafts').click();await page.getByRole('button',{name:/Re: En god begyndelse/}).click();assert.equal(await page.locator('#body').inputValue(),'Tak, torsdag passer fint.');
    await page.locator('#bcc').fill('private@example.test');await page.locator('#attachment-input').setInputFiles({name:'note.txt',mimeType:'text/plain',buffer:Buffer.from('fixture attachment')});await page.getByRole('button',{name:/note.txt/}).waitFor();
    await page.evaluate(()=>{window.__draftDelay=180;const form=document.getElementById('compose-form');form.dispatchEvent(new Event('submit',{cancelable:true}));form.dispatchEvent(new Event('submit',{cancelable:true}));});await page.locator('#compose-dialog').waitFor({state:'hidden'});
    assert.equal(await page.evaluate(()=>window.__calls.filter(c=>c.action==='send').length),1,'Double submit must never send twice while saving a draft.');
    const sent=await page.evaluate(()=>window.__calls.find(c=>c.action==='send').payload);assert.equal(sent.bcc,'private@example.test');assert.equal(Buffer.from(sent.attachments[0].data,'base64').toString(),'fixture attachment');assert.equal(sent.inReplyTo,'<test@example.test>');
    await page.getByRole('button',{name:'Indbakke 2'}).click();await page.locator('#search').fill('nothing');await page.locator('#search-form button').click();await page.getByText('Ingen mails matcher din søgning.').waitFor();
    await page.locator('#search').fill('');await page.locator('#search-form button').click();await page.getByRole('button',{name:/En god begyndelse/}).click();await page.locator('#toggle-star').click();
    assert.ok(await page.evaluate(()=>window.__calls.some(c=>c.action==='action'&&c.payload.action==='unstar'&&c.payload.uidValidity==='42')));
    const output=process.env.VEYRO_SCREENSHOTS || '/tmp/veyro-mail-native';await fs.mkdir(output,{recursive:true});
    await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true,animations:"disabled"});
    await page.locator('#settings').click();assert.equal(await page.locator('#oauth-microsoft').isDisabled(),true);assert.equal(await page.locator('#oauth-google').isDisabled(),true);await page.locator('#provider').selectOption('outlook');assert.equal(await page.locator('#save-settings').isDisabled(),true);
    await page.screenshot({path:path.join(output,'settings.png'),fullPage:true,animations:"disabled"});await page.locator('#close-settings').click();
    await page.setViewportSize({width:740,height:860});await page.screenshot({path:path.join(output,'narrow.png'),fullPage:true,animations:"disabled"});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.setViewportSize({width:420,height:860});await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true,animations:"disabled"});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    const readerTest=await browser.newPage({viewport:{width:1280,height:900}});
    readerTest.on('pageerror',error=>errors.push(error.message));
    await readerTest.addInitScript(installFixture);
    await readerTest.goto(`http://127.0.0.1:${server.address().port}/?readerTest=1`);
    const first=readerTest.getByRole('button',{name:/En god begyndelse/});
    const second=readerTest.getByRole('button',{name:/Dit næste projekt/});
    const third=readerTest.getByRole('button',{name:/Et tredje brev/});
    const reads=()=>readerTest.evaluate(()=>window.__calls.filter(c=>c.action==='message').map(c=>c.payload.uid));
    const finishRead=()=>readerTest.evaluate(()=>window.__finishRead());
    await first.click();
    await readerTest.locator('#message-body').waitFor();
    assert.equal(await readerTest.locator('#message-attachments button').nth(1).innerText(),'↓ Original.zip');
    await readerTest.locator('#forward').click();
    assert.equal(await readerTest.locator('#compose-attachments button').nth(1).innerText(),'Original.zip · videresendes ×');
    await readerTest.locator('#discard-draft').click();
    await first.click();
    assert.deepEqual(await reads(),[12],'Clicking the already open, read message reuses its body.');
    await readerTest.evaluate(()=>{window.__holdReads=true;});
    await second.click();
    await readerTest.locator('#reader-pending').waitFor();
    assert.match(await readerTest.locator('#pending-subject').innerText(),/Dit næste projekt/);
    assert.equal(await readerTest.locator('#reply').isVisible(),false,'Old message actions must disappear immediately.');
    await second.click();await third.click();await first.click();
    assert.match(await readerTest.locator('#pending-subject').innerText(),/En god begyndelse/);
    assert.deepEqual(await reads(),[12,11],'Only the active fetch may reach IMAP while it is pending.');
    await finishRead();
    await readerTest.waitForFunction(()=>window.__calls.filter(c=>c.action==='message').length===3 && !!window.__finishRead);
    assert.deepEqual(await reads(),[12,11,12],'Skipped intermediate selections must not queue another fetch.');
    await finishRead();
    await readerTest.locator('#message-body').waitFor();
    assert.match(await readerTest.locator('#message-subject').innerText(),/En god begyndelse/);
    await readerTest.setViewportSize({width:420,height:860});
    await readerTest.locator('#back-list').click();await third.click();
    await readerTest.locator('#cancel-read').click();await finishRead();
    await third.waitFor();
    assert.equal(await readerTest.locator('#message').isVisible(),false,'Finishing an abandoned read must not reopen it on mobile.');
    await readerTest.close();
    const freshSetup=async(suffix='')=>{
      const setup=await browser.newPage({viewport:{width:1024,height:820}});setup.on('pageerror',error=>errors.push(error.message));
      await setup.addInitScript(installFixture);await setup.goto(`http://127.0.0.1:${server.address().port}/?setup=1${suffix}`);await setup.locator('#settings-dialog').waitFor();return setup;
    };
    const google=await freshSetup();
    assert.equal(await google.locator('#provider').inputValue(),'');assert.equal(await google.locator('#provider-fields').isVisible(),false);
    // Invalid required manual fields and an empty app-password must not block the Google button.
    await google.locator('#provider').selectOption('custom');await google.locator('#advanced-settings summary').click();await google.locator('#imap-port').fill('');
    await google.locator('#provider').selectOption('gmail');
    assert.equal(await google.locator('#identity-fields').isVisible(),false);assert.equal(await google.locator('#account-email').isDisabled(),true);
    assert.equal(await google.locator('#manual-settings').isVisible(),false);assert.equal(await google.locator('#imap-host').isDisabled(),true);
    assert.equal(await google.locator('#oauth-microsoft').isVisible(),false);assert.equal(await google.locator('#oauth-google').innerText(),'Log ind med Google');
    assert.equal(await google.locator('#settings-form input:visible').count(),0,'Google sign-in must not ask for an email, name or password.');
    assert.doesNotMatch(await google.locator('#settings-form').innerText(),/IMAP|SMTP|OAuth/);
    await google.screenshot({path:path.join(output,'setup-google.png'),animations:'disabled'});
    await google.setViewportSize({width:390,height:740});await google.screenshot({path:path.join(output,'setup-google-mobile.png'),animations:'disabled'});
    assert.equal(await google.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await google.locator('#manual-alternative').click();assert.equal(await google.locator('#imap-password').isVisible(),true);assert.equal(await google.locator('#account-email').isVisible(),true);
    await google.locator('#manual-alternative').click();assert.equal(await google.locator('#imap-password').isDisabled(),true);
    await google.locator('#oauth-google').click();await google.locator('#settings-dialog').waitFor({state:'hidden'});
    assert.deepEqual(await google.evaluate(()=>window.__calls.find(c=>c.action==='oauthConnect').payload),{provider:'google'});
    assert.equal(await google.evaluate(()=>window.__calls.some(c=>c.action==='configure')),false);
    await google.locator('#settings').click();assert.equal(await google.locator('#provider').inputValue(),'gmail');assert.equal(await google.locator('#provider').isDisabled(),true);
    assert.equal(await google.locator('#connected-account').innerText(),'owner@example.test');assert.equal(await google.locator('#identity-fields').isVisible(),false);
    assert.equal(await google.locator('#manual-alternative').isVisible(),false);assert.equal(await google.locator('#oauth-google').innerText(),'Log ind igen med Google');
    await google.locator('#oauth-google').click();await google.locator('#settings-dialog').waitFor({state:'hidden'});
    assert.equal(await google.evaluate(()=>window.__calls.filter(c=>c.action==='oauthConnect').length),2);
    const icloud=await freshSetup();await icloud.locator('#provider').selectOption('icloud');await icloud.locator('#account-email').fill('reader@icloud.com');await icloud.locator('#imap-password').fill('fixture-only-app-password');
    assert.equal(await icloud.locator('#imap-host').isVisible(),false);assert.equal(await icloud.locator('#imap-host').inputValue(),'imap.mail.me.com');
    await icloud.screenshot({path:path.join(output,'setup-icloud.png'),animations:'disabled'});
    await icloud.locator('#save-settings').click();await icloud.locator('#settings-dialog').waitFor({state:'hidden'});
    const cloudPayload=await icloud.evaluate(()=>window.__calls.find(c=>c.action==='configure').payload);
    assert.equal(cloudPayload.imap.user,'reader');assert.equal(cloudPayload.smtp.user,'reader@icloud.com');assert.equal(cloudPayload.smtp.host,'smtp.mail.me.com');assert.equal(cloudPayload.smtp.port,587);assert.equal(cloudPayload.smtp.secure,false);assert.equal(cloudPayload.imap.password,cloudPayload.smtp.password);
    // Saved password remains optional only while editing the same configured mailbox.
    await icloud.locator('#settings').click();assert.equal(await icloud.locator('#imap-password').getAttribute('required'),null);
    await icloud.locator('#account-email').fill('other@icloud.com');assert.notEqual(await icloud.locator('#imap-password').getAttribute('required'),null);
    const manual=await freshSetup();await manual.locator('#provider').selectOption('custom');await manual.locator('#account-email').fill('reader@example.test');await manual.locator('#imap-password').fill('fixture-only-password');
    await manual.locator('#save-settings').click();assert.equal(await manual.locator('#advanced-settings').getAttribute('open'),'');assert.equal(await manual.evaluate(()=>window.__calls.some(c=>c.action==='configure')),false);
    await manual.locator('#imap-host').fill('mail.example.test');await manual.locator('#smtp-host').fill('send.example.test');await manual.locator('#imap-user').fill('custom-reader');await manual.locator('#smtp-user').fill('custom-sender');await manual.locator('#smtp-port').fill('465');await manual.locator('#smtp-secure').selectOption('true');await manual.locator('#smtp-password').fill('fixture-only-smtp-password');await manual.locator('#save-sent').uncheck();
    await manual.setViewportSize({width:390,height:740});await manual.screenshot({path:path.join(output,'setup-custom-mobile.png'),animations:'disabled'});assert.equal(await manual.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await manual.locator('#save-settings').click();await manual.locator('#settings-dialog').waitFor({state:'hidden'});
    const manualPayload=await manual.evaluate(()=>window.__calls.find(c=>c.action==='configure').payload);assert.equal(manualPayload.imap.host,'mail.example.test');assert.equal(manualPayload.imap.user,'custom-reader');assert.equal(manualPayload.smtp.user,'custom-sender');assert.equal(manualPayload.smtp.port,465);assert.equal(manualPayload.smtp.secure,true);assert.equal(manualPayload.smtp.password,'fixture-only-smtp-password');assert.equal(manualPayload.saveSent,false);
    const unavailable=await freshSetup('&unavailable=1');await unavailable.locator('#provider').selectOption('gmail');assert.equal(await unavailable.locator('#oauth-google').isDisabled(),true);assert.match(await unavailable.locator('#provider-note').innerText(),/ikke tilgængeligt/);
    await unavailable.locator('#provider').selectOption('outlook');assert.equal(await unavailable.locator('#oauth-microsoft').isDisabled(),true);assert.equal(await unavailable.locator('#manual-settings').isVisible(),false);assert.equal(await unavailable.locator('#manual-alternative').isVisible(),false);assert.match(await unavailable.locator('#provider-note').innerText(),/kan derfor ikke forbindes endnu/);
    await unavailable.screenshot({path:path.join(output,'setup-microsoft-unavailable.png'),animations:'disabled'});assert.deepEqual(errors,[]);
    const richPage=await browser.newPage({viewport:{width:1100,height:800}});let imageRequests=0,unexpectedRequests=0;
    await richPage.route('https://images.example.test/pixel.png',route=>{imageRequests++;return route.fulfill({contentType:'image/png',body:png});});
    await richPage.route('https://leak.example.test/**',route=>{unexpectedRequests++;return route.abort();});
    await richPage.goto(`http://127.0.0.1:${server.address().port}/rich-host`);const frame=richPage.frames().find(f=>f.url().endsWith('/rich-child'));
    await frame.waitForFunction(()=>document.getElementById('cid').complete);assert.equal(await frame.locator('#cid').evaluate(img=>img.naturalWidth),1);
    assert.equal(await frame.locator('.brand').evaluate(el=>getComputedStyle(el).color),'rgb(191, 66, 20)');assert.equal(await frame.evaluate(()=>typeof window.veyroMail),'undefined');
    assert.equal(await frame.evaluate(()=>{try{void parent.document;return false;}catch{return true;}}),true);assert.equal(await richPage.evaluate(()=>window.injected),undefined);assert.equal(imageRequests,0);assert.equal(unexpectedRequests,0);
    await richPage.screenshot({path:path.join(output,'rich-message.png'),animations:'disabled'});
    const navigating=richPage.waitForEvent('framenavigated',frame=>frame.url().includes('images=1'));await richPage.locator('iframe').evaluate(el=>el.src='/rich-child?images=1');
    const enabled=await navigating;await enabled.waitForFunction(()=>document.getElementById('external').complete&&document.getElementById('external').naturalWidth===1);
    assert.equal(imageRequests,1);assert.equal(unexpectedRequests,0);
    console.log(JSON.stringify({ok:true,checks:'safe reader, downloads, reply-all, persistent drafts, double-submit prevention, Bcc/attachment send, search, star, provider-first setup, Google sign-in without typed identity, hidden-field validation, explicit app-password alternative, verified-profile reconnect, iCloud defaults, custom advanced settings, OAuth unavailable, responsive overflow, isolated rich HTML/CID/styles, external images blocked until consent, no bridge access',screenshots:output}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
