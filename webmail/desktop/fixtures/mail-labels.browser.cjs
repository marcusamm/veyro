'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const {chromium}=require('../../../node_modules/playwright');
const {sidebarViews}=require('../provider-views.cjs');

async function run(){
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1330,height:900}});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const root=path.resolve(__dirname,'..');
    const files=new Map([['/','mail-client.html'],['/mail-client.js','mail-client.js'],['/mail-client.css','mail-client.css'],['/manrope.woff2','assets/manrope.woff2']]);
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),file=files.get(url.pathname);
      return url.host==='mail.test'&&file?route.fulfill({path:path.join(root,file)}):route.abort();
    });
    const folders=['Inbox','All','Sent','Drafts','Trash','Junk'].map(role=>({
      path:role==='Inbox'?'INBOX':'[Gmail]/'+role,name:role,specialUse:'\\'+role,total:10,unseen:2
    }));
    const views=sidebarViews(folders,{gmail:true});
    await page.addInitScript(({folders,views})=>{
      const generic=location.search==='?generic';
      let labels=['Privat','Kunder'];
      const mail={uid:17,subject:'Kvittering fra test',text:'Mange tak!',size:40,from:[],to:[],seen:true,labels:[],important:false,flagged:false,uidValidity:'12'};
      window.calls=[];
      window.veyroMail={invoke:async(action,data={})=>{
        window.calls.push({action,data});
        if(action==='bootstrap')return {configured:true,account:{email:'person@example.test'}};
        if(action==='sidebar' && generic)return {gmail:false,views:[views[0]],folders:[folders[0]]};
        if(action==='sidebar')return {gmail:true,views,folders:[...folders,...labels.map(name=>({path:name,name,label:true}))]};
        if(action==='drafts')return [];
        if(action==='messages'){
          const selectedLabel=labels.includes(data.folder);
          const matchesLabel=!selectedLabel || mail.labels.includes(data.folder);
          const matchesFilter=data.filter!=='important' || mail.important;
          const messages=matchesLabel && matchesFilter && (!data.keywordLabel || mail.labels.includes(data.keywordLabel))?[{...mail,labels:[...mail.labels]}]:[];
          return {messages,keywordLabels:generic,availableLabels:generic?[...new Set(['Betaling',...mail.labels])]:[],uidValidity:'12',pageToken:'page',total:messages.length,hasNext:false};
        }
        if(action==='message')return {...mail,labels:[...mail.labels]};
        if(action==='messageLabel'){
          if(data.uid!==17 || data.uidValidity!=='12' || !folders.some(f=>f.path===data.folder) && !labels.includes(data.folder))throw Error('Forkert mail');
          mail.labels=mail.labels.filter(l=>!data.remove.includes(l)).concat(data.add);
        }
        if(action==='manageLabel'){
          if(data.operation==='create')labels.push(data.name);
          else if(data.operation==='rename'){
            labels=labels.map(l=>l===data.name?data.newName:l);
            mail.labels=mail.labels.map(l=>l===data.name?data.newName:l);
          }else if(data.operation==='delete'){
            labels=labels.filter(l=>l!==data.name);
            mail.labels=mail.labels.filter(l=>l!==data.name);
          }
        }
        if(action==='action')mail.important=data.action==='important';
        return {ok:true};
      }};
    },{folders,views});
    await page.goto('http://mail.test/');
    await page.locator('#messages button').first().waitFor();
    assert.equal(await page.locator('[data-nav^="view:"]').count(),16);
    await page.locator('#folder-disclosure').click();
    assert.equal(await page.locator('[data-nav="view:subscriptions"]').isVisible(),false);
    await page.locator('#folder-disclosure').click();
    await page.locator('[data-nav="view:subscriptions"]').click();
    assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.action==='openProviderView').at(-1).data.webView),'subscriptions');
    await page.locator('[data-nav="view:purchases"]').click();
    await page.waitForFunction(()=>window.calls.some(c=>c.action==='messages' && c.data.filter==='purchases' && c.data.folder==='[Gmail]/All'));
    await page.locator('#messages button').first().click();
    await page.locator('#edit-labels').click();
    const picker=page.locator('#labels-dialog');
    await picker.getByRole('checkbox',{name:'Privat'}).check();
    await picker.getByRole('checkbox',{name:'Kunder'}).check();
    await page.locator('#apply-labels').click();
    await page.waitForFunction(()=>document.querySelectorAll('#message-labels .label-chip').length===2);
    const delta=await page.evaluate(()=>window.calls.find(c=>c.action==='messageLabel').data);
    assert.deepEqual(delta,{folder:'[Gmail]/All',uid:17,uidValidity:'12',add:['Privat','Kunder'],remove:[]});
    assert.deepEqual(await page.locator('.row-labels .label-chip').allTextContents(),['Privat','Kunder']);
    await page.locator('#toggle-important').click();
    await page.locator('[data-nav="view:important"]').click();
    await page.locator('#messages button').first().click();
    await page.locator('#toggle-important').click();
    await page.waitForFunction(()=>!document.querySelector('#messages').childElementCount && document.querySelector('#message').hidden);
    await page.locator('#new-label').click();
    await page.locator('#label-name').fill('År & <salg>');
    await page.locator('#submit-label-name').click();
    await picker.getByRole('button',{name:'Omdøb År & <salg>'}).click();
    await page.locator('#label-name').fill('Køb 2026');
    await page.locator('#submit-label-name').click();
    await picker.getByRole('button',{name:'Slet Køb 2026'}).click();
    await page.locator('#cancel-delete-label').click();
    assert.equal(await picker.getByRole('button',{name:'Omdøb Køb 2026'}).count(),1);
    await picker.getByRole('button',{name:'Slet Køb 2026'}).click();
    await page.locator('#confirm-delete-label').click();
    await page.waitForFunction(()=>!document.querySelector('[data-nav="folder:Køb 2026"]'));
    await page.locator('#close-labels').click();
    await page.locator('[data-nav="folder:Privat"]').click();
    await page.locator('#messages button').first().click();
    await page.locator('#edit-labels').click();
    await picker.getByRole('checkbox',{name:'Privat'}).uncheck();
    await page.locator('#apply-labels').click();
    await page.waitForFunction(()=>!document.querySelector('#messages').childElementCount && document.querySelector('#message').hidden);
    await page.locator('[data-nav="view:inbox"]').click();
    await page.locator('#messages button').first().click();
    await page.locator('#message-labels .label-chip').waitFor();
    assert.deepEqual(await page.locator('#message-labels .label-chip').allTextContents(),['Kunder']);
    await page.goto('http://mail.test/?generic');
    await page.locator('#messages button').first().click();
    await page.locator('#edit-labels').click();
    await picker.getByRole('checkbox',{name:'Betaling'}).check();
    await page.locator('#add-label').click();
    await page.locator('#label-name').fill('Klip & klistre');
    await page.locator('#submit-label-name').click();
    await page.locator('#apply-labels').click();
    await page.waitForFunction(()=>document.querySelectorAll('#message-labels .label-chip').length===2);
    await page.locator('#keyword-select').selectOption('Klip & klistre');
    await page.waitForFunction(()=>window.calls.some(c=>c.action==='messages' && c.data.keywordLabel==='Klip & klistre' && c.data.folder==='INBOX'));
    await page.locator('#messages button').first().click();
    await page.locator('#edit-labels').click();
    await picker.getByRole('checkbox',{name:'Klip & klistre'}).uncheck();
    await page.locator('#apply-labels').click();
    await page.waitForFunction(()=>!document.querySelector('#messages').childElementCount);
    await page.locator('#keyword-select').selectOption('');
    await page.locator('#messages button').first().waitFor();
    assert.equal(await page.locator('#manage-labels').isVisible(),false);
    assert.equal(await page.evaluate(()=>window.calls.some(c=>c.action==='manageLabel')),false);
    assert.deepEqual(errors,[]);
    console.log('Verified 16 Gmail views, correct physical mailbox for filtered reads, scoped provider handoff, important toggling, multiple labels, rename, delete confirmation, removing a label while reading its mailbox, and generic writable IMAP per-folder keyword creation, assignment and filtering.');
  }finally{await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
