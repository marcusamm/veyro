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
    const route=assets[req.url];if(!route){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',route[1]);res.end(await fs.readFile(path.join(root,route[0])));}catch{res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{
      const identity={id:'fixture-account',label:'Studio',configured:true,account:{email:'owner@example.test',name:'Test Owner',imap:{host:'imap.example.test',port:993,secure:true,user:'owner@example.test'},smtp:{host:'smtp.example.test',port:587,secure:false,user:'owner@example.test'}},oauth:{google:{available:false},microsoft:{available:false}}};
      const sample={uid:12,subject:'En god begyndelse',from:[{name:'Sofie Andersen',address:'sofie@example.test'}],to:[{name:'Test Owner',address:'owner@example.test'}],cc:[{address:'team@example.test'}],date:'2026-11-27T12:00:00Z',seen:false,flagged:true,size:1200,uidValidity:'42'};
      let drafts=[];window.__calls=[];
      window.veyroMail={invoke:async(action,payload={})=>{
        window.__calls.push({action,payload:structuredClone(payload)});
        if(action==='bootstrap')return structuredClone(identity);
        if(action==='folders')return [{path:'INBOX',name:'INBOX',unseen:2},{path:'Sent',name:'Sent',specialUse:'\\Sent'},{path:'Archive',name:'Archive',specialUse:'\\Archive'},{path:'Trash',name:'Trash',specialUse:'\\Trash'}];
        if(action==='messages')return {messages:payload.query==='nothing'?[]:[{...sample},{...sample,uid:11,from:[{name:'Veyro',address:'hello@example.test'}],subject:'Dit næste projekt starter her',flagged:false,seen:true}],total:82,page:payload.page,pageSize:40,hasNext:payload.page<3,uidValidity:'42'};
        if(action==='message')return {...sample,uid:payload.uid,seen:true,text:'Hej Test Owner,\n\nTak for en rigtig god samtale i går. Jeg har samlet vores tanker om det nye projekt, så vi kan finde den rigtige retning sammen.\n\nLad os mødes på torsdag og se på de første skitser.\n\nBedste hilsner\nSofie\n\n<img src=x onerror="window.injected=true">',replyTo:[],messageId:'<test@example.test>',references:[],attachments:[{index:0,filename:'Projektbeskrivelse.pdf',contentType:'application/pdf',size:42800}]};
        if(action==='action'||action==='saveAttachment')return {ok:true};
        if(action==='drafts')return structuredClone(drafts);
        if(action==='saveDraft'){if(window.__draftDelay)await new Promise(resolve=>setTimeout(resolve,window.__draftDelay));const draft={...payload,id:payload.id || 'fixture-draft'};drafts=drafts.filter(d=>d.id!==draft.id).concat(draft);return structuredClone(draft);}
        if(action==='deleteDraft'){drafts=drafts.filter(d=>d.id!==payload.id);return {ok:true};}
        if(action==='send')return {ok:true,accepted:[payload.to],rejected:[],warning:''};
        if(action==='configure'){identity.account={...payload,imap:{...payload.imap,password:undefined},smtp:{...payload.smtp,password:undefined}};return structuredClone(identity);}
        throw new Error('Unexpected mock action '+action);
      }};
    });
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
    console.log(JSON.stringify({ok:true,checks:'safe reader, downloads, reply-all, persistent drafts, double-submit prevention, Bcc/attachment send, search, star, OAuth unavailable, responsive overflow, isolated rich HTML/CID/styles, external images blocked until consent, no bridge access',screenshots:output}));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
