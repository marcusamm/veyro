'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium} = require('../../../node_modules/playwright');

async function run() {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1400,height:1300}});
    const errors = [];
    page.on('pageerror',error=>errors.push(error.message));
    const root = path.resolve(__dirname,'..');
    const files = new Map([['/','mail-client.html'],['/mail-client.js','mail-client.js'],
      ['/mail-client.css','mail-client.css'],['/manrope.woff2','assets/manrope.woff2']]);
    await page.route('**/*',route=>{
      const url = new URL(route.request().url());
      const file = files.get(url.pathname);
      return url.host === 'mail.test' && file ? route.fulfill({path:path.join(root,file)}) : route.abort();
    });
    await page.addInitScript(()=>{
      let pages = 0;
      const mails = Array.from({length:40},(_,i)=>({uid:i+1,subject:'Brev '+(i+1),seen:true,from:[],size:512,attachments:[]}));
      const account = {email:'person@example.test',imap:{host:'in.example.test'},smtp:{host:'out.example.test'}};
      window.reports = [];
      window.veyroMail = {onViewportRequested:measure=>{window.measureViewport=measure;},invoke:async(action,payload)=>{
        switch (action) {
          case 'bootstrap': return {configured:true,id:'test',account,oauth:{}};
          case 'sidebar': return {gmail:false,folders:[{path:'INBOX',name:'INBOX'}],views:[{id:'inbox',name:'Indbakke',folder:'INBOX'}]};
          case 'messages': return {messages:mails,pageToken:'page-'+(++pages),total:40,page:1,hasNext:false,uidValidity:'12'};
          case 'visibleMessages': window.reports.push(payload); return;
          case 'drafts': return [];
          case 'message': return {...mails.find(m=>m.uid===payload.uid),uidValidity:'12',text:'Brevtekst'};
          default: return {};
        }
      }};
    });
    await page.goto('http://mail.test/');
    const reported = ()=>page.evaluate(()=>window.reports.at(-1));
    async function checkViewport() {
      // Hit-test actual pixels, independently of the renderer measurement.
      await page.waitForFunction(()=>{
        const box=document.getElementById('messages').getBoundingClientRect();
        const uids=new Set();
        for(let y=Math.ceil(box.top);y<Math.floor(box.bottom);y++) {
          const row=document.elementFromPoint(box.left+20,y)?.closest('button[data-uid]');
          if(row)uids.add(Number(row.dataset.uid));
        }
        const sent=window.reports.at(-1);
        return uids.size>0 && sent && JSON.stringify(sent.uids)===JSON.stringify([...uids]);
      },{},{timeout:3000});
      return reported();
    }
    const first=await checkViewport();
    assert.ok(first.uids.length>8 && first.uids.length<40);
    assert.equal(first.folder,'INBOX');
    assert.equal(first.uidValidity,'12');
    assert.deepEqual(Object.keys(first).sort(),['folder','pageToken','uidValidity','uids']);

    await page.locator('#messages').evaluate(list=>{
      list.scrollTop=list.children[11].offsetTop-list.children[0].offsetTop+10;
    });
    const afterScroll=await checkViewport();
    assert.equal(afterScroll.uids[0],12,'Slightly clipped first row is still visible.');
    assert.ok(!afterScroll.uids.includes(11));
    await page.setViewportSize({width:1400,height:660});
    const smaller=await checkViewport();
    assert.ok(smaller.uids.length<afterScroll.uids.length);
    assert.equal(smaller.uids[0],12);
    const messagesBefore=await page.evaluate(()=>window.reports.length);
    await page.locator('#messages').evaluate(async list=>{
      for(let i=0;i<5;i++){list.dispatchEvent(new Event('scroll'));await new Promise(requestAnimationFrame);}
    });
    assert.equal(await page.evaluate(()=>window.reports.length),messagesBefore);
    await page.evaluate(()=>window.measureViewport());
    await page.waitForFunction(count=>window.reports.length===count+1,messagesBefore);
    assert.deepEqual(await reported(),smaller);

    await page.locator('#settings').click();
    await page.waitForFunction(()=>!window.reports.at(-1).uids.length);
    await page.locator('#close-settings').click();
    await checkViewport();
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>window.reports.at(-1).pageToken==='page-2');
    await checkViewport();
    await page.setViewportSize({width:760,height:660});
    await checkViewport();
    await page.locator('#messages button').nth(12).click();
    await page.waitForFunction(()=>!window.reports.at(-1).uids.length);
    await page.locator('#back-list').click();
    await checkViewport();
    await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.deepEqual((await reported()).uids,[]);
    await page.evaluate(()=>{delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));});
    await checkViewport();
    await page.locator('#drafts').click();
    await page.waitForFunction(()=>!window.reports.at(-1).uids.length);
    assert.deepEqual(errors,[]);
    console.log('Visible rows, scrolling, resize, deduplication, refresh, hidden list, dialogs, document visibility and drafts verified.');
  } finally {
    await browser.close();
  }
}

run().catch(error=>{console.error(error);process.exitCode=1;});
