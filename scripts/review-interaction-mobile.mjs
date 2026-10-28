// Read-only interaction audit of the local public preview. Every POST/external request is blocked.
// OUT=/private/tmp/veyro-interaction-audit node scripts/review-interaction-mobile.mjs
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.BASE ?? 'http://localhost:52194').replace(/\/$/, '');
const out = process.env.OUT ?? '/private/tmp/veyro-interaction-audit';
const variants = [
  { width: 390, height: 844, full: true },
  { width: 768, height: 1024, full: true },
  { width: 320, height: 568, full: false },
  { width: 844, height: 390, full: false },
].filter(v => !process.env.WIDTHS || process.env.WIDTHS.split(',').includes(String(v.width)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const reports = [];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function hit(locator, scroll = true) {
  if (scroll) await locator.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  return locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    const name = node => node ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${node.className && typeof node.className === 'string' ? '.' + node.className.trim().replace(/\s+/g, '.') : ''}` : null;
    const points = [];
    for (const [fx,fy] of [[.5,.5],[.25,.5],[.75,.5],[.5,.25],[.5,.75],[.2,.2],[.8,.2],[.2,.8],[.8,.8]]) {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      if (x < 1 || y < 1 || x >= innerWidth - 1 || y >= innerHeight - 1) continue;
      const top = document.elementFromPoint(x, y);
      points.push({ x, y, top: name(top), text: top?.textContent.trim().slice(0, 80), matches: top === el || el.contains(top) });
    }
    const style = getComputedStyle(el);
    return {
      rect: { x:r.x,y:r.y,width:r.width,height:r.height },
      target:name(el), text:el.textContent.trim().slice(0,80), pointerEvents:style.pointerEvents,
      visible:style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0,
      point:points.find(p=>p.matches) || null, samples:points,
    };
  });
}

async function contrast(locator) {
  return locator.evaluate(el => {
    const rgba = s => { const n=s.match(/[\d.]+/g)?.map(Number)||[0,0,0,0];return[n[0],n[1],n[2],n[3]??1];};
    const over=(a,b)=>{const alpha=a[3]+b[3]*(1-a[3]);return alpha?[0,1,2].map(i=>(a[i]*a[3]+b[i]*b[3]*(1-a[3]))/alpha).concat(alpha):[0,0,0,0];};
    const chain=[];for(let p=el;p;p=p.parentElement)chain.unshift(p);
    const bg=chain.reduce((b,p)=>over(rgba(getComputedStyle(p).backgroundColor),b),[255,255,255,1]);
    const s=getComputedStyle(el),fg=over(rgba(s.color),bg);
    const L=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
    const a=L(fg),b=L(bg);
    return{ text:el.textContent.trim().slice(0,100),color:s.color,background:bg,ratio:Number(((Math.max(a,b)+.05)/(Math.min(a,b)+.05)).toFixed(2)),fontSize:s.fontSize };
  });
}

try {
 for (const viewport of variants) {
  const record={...viewport,checks:[],issues:[],blockedPosts:0,blockedExternal:[],pageErrors:[]};
  const prefix=`mobile-${viewport.width}x${viewport.height}`;
  const context=await browser.newContext({viewport:{width:viewport.width,height:viewport.height},hasTouch:true,isMobile:true,reducedMotion:'no-preference'});
  await context.route('**/*',route=>{
    const request=route.request(),u=new URL(request.url());
    if(request.method()==='POST'){record.blockedPosts++;return route.abort();}
    if(u.origin!==BASE && !['data:','blob:'].includes(u.protocol)){record.blockedExternal.push(u.origin);return route.abort();}
    return route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>record.pageErrors.push(e.message));
  const issue=async(name,detail)=>{record.issues.push({name,...detail});await page.screenshot({path:path.join(out,`${prefix}-${record.issues.length}-issue.png`)}).catch(()=>{});};
  const check=async(name,fn)=>{try{const detail=await fn();record.checks.push({name,status:'passed',detail});}catch(error){await issue(name,{error:error.message});record.checks.push({name,status:'failed'});}};
  const tap=async(selector,{root=page,scroll=true}={})=>{
    const locator=typeof selector==='string'?root.locator(selector).first():selector;
    const state=await hit(locator,scroll);
    if(!state.point){await issue('Occluded or unreachable touch target',{selector:typeof selector==='string'?selector:state.target,hit:state});throw new Error(`No visible hit point for ${state.target}`);}
    await page.touchscreen.tap(state.point.x,state.point.y);return state;
  };
  const home=async()=>{await page.goto(BASE,{waitUntil:'networkidle'});await wait(1800);};
  try {
   await home();
   await page.screenshot({path:path.join(out,`${prefix}-initial.png`)});
   await check('Initial viewport layout',async()=>{
     const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,header:document.querySelector('[data-header]').getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight}}));
     assert.equal(metrics.overflow,false,'Page overflows horizontally');return metrics;
   });
   await check('Fresh cookie banner plus navigation overlay',async()=>{
     const cookieVisible=await page.locator('[data-cookie]').isVisible();
     await tap('[data-nav-toggle]',{scroll:false});await wait(700);
     assert.equal(await page.locator('[data-nav-toggle]').getAttribute('aria-expanded'),'true');
     const targets=[];
     for(const locator of await page.locator('#MobileNav a').all()) if(await locator.isVisible()) targets.push(await hit(locator,false));
     const blocked=targets.filter(t=>t.samples.length>0&&!t.point);
     await page.screenshot({path:path.join(out,`${prefix}-menu-with-cookie.png`)});
     if(blocked.length)await issue('Cookie or overlay obscures menu links',{cookieVisible,targets:blocked});
     const cookieInert=await page.locator('[data-cookie]').evaluate(el=>el.inert);
     await page.keyboard.press('Escape');await wait(150);
     assert.equal(await page.locator('#MobileNav').isVisible(),false);
     return{cookieVisible,cookieInert,menuTargets:targets};
   });
   await check('Cookie text readability and preference controls',async()=>{
     const cookie=page.locator('[data-cookie]');
     if(!(await cookie.isVisible()))return{skipped:'Banner already dismissed'};
     const title=await contrast(cookie.locator('.cookie__title'));
     if(title.ratio<4.5)await issue('Cookie heading has insufficient contrast',{selector:'.cookie__title',contrast:title});
     await tap('[data-cookie-action="customize"]');await wait(150);
     assert.equal(await page.locator('[data-cookie-prefs]').isVisible(),true);
     const preferences=[];
     for(const strong of await page.locator('[data-cookie-prefs] strong').all()) {
       const item=await contrast(strong);preferences.push(item);
       if(item.ratio<4.5)await issue('Cookie preference text has insufficient contrast',{selector:'[data-cookie-prefs] strong',contrast:item});
     }
     const marketing=page.locator('[data-consent="marketing"]');
     await tap(marketing.locator('xpath=ancestor::label[1]'));
     assert.equal(await marketing.isChecked(),true,'Marketing switch can be tapped');
     await tap(marketing.locator('xpath=ancestor::label[1]'));
     assert.equal(await marketing.isChecked(),false);
     await tap('[data-cookie-action="save"]');await wait(150);
     assert.equal(await cookie.isVisible(),false,'Preferences can be saved/dismissed');
     return{title,preferences};
   });
   await check('Hero text and primary contact CTA',async()=>{
     const h1=await hit(page.locator('.home-hero h1'),false);
     assert.ok(h1.point,'Hero heading is covered by a decorative layer');
     await tap('.studio-action .btn--primary');await page.waitForURL('**/pages/kontakt?**');
     const service=await page.locator('select[name="contact[Ydelse]"]').inputValue();
     assert.equal(service,'Aftal en demo');await home();return{h1,service};
   });
   await check('Menu keyboard focus, short-screen scrolling and CTA',async()=>{
     await tap('[data-nav-toggle]',{scroll:false});await wait(700);
     assert.equal(await page.locator('#MobileNav').isVisible(),true);
     const initialFocus=await page.evaluate(()=>document.activeElement.closest('#MobileNav')?.id||null);
     assert.equal(initialFocus,'MobileNav');
     for(let i=0;i<18;i++)await page.keyboard.press('Tab');
     assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[data-header]')),true,'Tab escapes header trap');
     const cta=await tap('#MobileNav .btn--block');
     await page.waitForURL('**/pages/kontakt?**');
     assert.equal(await page.locator('#MobileNav').isVisible(),false,'Menu state closes before navigation');
     await home();return{initialFocus,cta};
   });
   if(viewport.full){
    await check('Hero secondary and service links',async()=>{
      const results=[];
      for(const selector of ['.studio-action .btn--secondary','.studio-specialties a:nth-child(1)','.studio-specialties a:nth-child(2)','.studio-specialties a:nth-child(3)']){
        const locator=page.locator(selector);const href=await locator.getAttribute('href');await tap(locator);await page.waitForURL(BASE+href);results.push({selector,href});await home();
      }return results;
    });
    await check('3D gallery controls and all demo links',async()=>{
      const gallery=page.locator('[data-project-gallery]');await gallery.locator('[data-gallery-stage]').scrollIntoViewIfNeeded();await wait(400);
      const pause=gallery.locator('[data-gallery-pause]');
      if(await pause.isVisible()&&await pause.getAttribute('aria-pressed')!=='true')await tap(pause);
      const angles=[];
      for(const button of ['[data-gallery-next]','[data-gallery-prev]'])if(await gallery.locator(button).isVisible()){const before=await gallery.getAttribute('data-rotation');await tap(gallery.locator(button));await wait(60);const after=await gallery.getAttribute('data-rotation');assert.notEqual(after,before,'Gallery control does not rotate the scene');angles.push({button,before,after});}
      await page.screenshot({path:path.join(out,`${prefix}-gallery.png`)});
      const links=[];
      for(let i=0;i<3;i++){
        const g=page.locator('[data-project-gallery]');await g.locator('[data-gallery-stage]').scrollIntoViewIfNeeded();await wait(250);const p=g.locator('[data-gallery-pause]');if(await p.isVisible()&&await p.getAttribute('aria-pressed')!=='true')await tap(p);
        const plane=g.locator('.project-gallery__plane').nth(i);await plane.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await wait(100);const href=await plane.getAttribute('href');const state=await tap(plane,{scroll:false});await page.waitForURL(BASE+href,{timeout:5000});links.push({href,hit:state});await home();
      }return{angles,links};
    });
    await check('Plan switches, keyboard selection and summary CTA',async()=>{
      const picker=page.locator('[data-plan-picker]').first();const cards=picker.locator('[data-plan-card]');const choices=[];
      for(let i=0;i<3;i++){const card=cards.nth(i);await tap(card.locator('[data-plan-label]'));await wait(80);const title=await card.getAttribute('data-plan-title');assert.equal((await picker.locator('[data-summary-title]').innerText()).trim(),title);choices.push(title);}
      await cards.first().locator('[data-plan-radio]').focus();await page.keyboard.press('ArrowDown');assert.equal((await picker.locator('[data-summary-title]').innerText()).trim(),'Booking');
      await tap(picker.locator('[data-summary-link]'));await page.waitForURL('**/pages/kontakt?**');assert.equal(await page.locator('select[name="contact[Ydelse]"]').inputValue(),'Pakke: Booking');await home();return{choices};
    });
    await check('FAQ summaries open and close with touch',async()=>{
      const items=page.locator('.faq__item');const questions=[];
      for(let i=0;i<await items.count();i++){const item=items.nth(i);const summary=item.locator('summary');questions.push((await summary.innerText()).trim());await tap(summary);await wait(300);assert.equal(await item.evaluate(el=>el.open),true);const answer=await hit(item.locator('.faq__answer'));assert.ok(answer.point,'Expanded FAQ answer is covered');await tap(summary);await wait(300);assert.equal(await item.evaluate(el=>el.open),false);}return questions;
    });
    await check('Contact controls and validation links',async()=>{
      await page.goto(BASE+'/pages/kontakt?ydelse=pakke-booking#formular',{waitUntil:'networkidle'});await wait(500);
      const select=page.locator('select[name="contact[Ydelse]"]');await tap(select);await select.selectOption({label:'Pakke: Webshop'});assert.equal(await select.inputValue(),'Pakke: Webshop');
      const form=page.locator('form').filter({has:page.locator('select[name="contact[Ydelse]"]')}).first();
      await tap(form.locator('button[type="submit"]'));await wait(300);const summary=page.locator('[data-error-summary]').first();assert.equal(await summary.isVisible(),true);await tap(summary.locator('a').first());assert.equal(await page.evaluate(()=>document.activeElement.tagName),'INPUT','Error summary link focuses required input');
      const inputs=[];for(const input of await form.locator('input:not([type="hidden"]):not([tabindex="-1"]),textarea,select').all())if(await input.isVisible())inputs.push(await hit(input));
      const blocked=inputs.filter(t=>!t.point);assert.deepEqual(blocked,[],'A contact form control is occluded');
      const consent=form.locator('input[type="checkbox"]').first();await tap(consent);assert.equal(await consent.isChecked(),true);await tap(consent);assert.equal(await consent.isChecked(),false);
      await page.screenshot({path:path.join(out,`${prefix}-contact-validation.png`)});await home();return inputs;
    });
    await check('Cookie settings can reopen from footer',async()=>{
      await tap('[data-cookie-open]');assert.equal(await page.locator('[data-cookie-prefs]').isVisible(),true);await tap('[data-cookie-action="reject"]');assert.equal(await page.locator('[data-cookie]').isVisible(),false);return{reopened:true};
    });
   }
   const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,h1:document.querySelectorAll('main h1').length}));
   if(metrics.overflow)await issue('Horizontal overflow after interactions',{metrics});
   if(record.pageErrors.length)await issue('JavaScript runtime errors',{errors:record.pageErrors});
   if(record.blockedPosts)await issue('A POST was attempted during read-only validation',{count:record.blockedPosts});
  }catch(error){await issue('Audit setup or navigation failed',{error:error.stack||String(error)});}
  finally{await context.close();reports.push(record);writeFileSync(path.join(out,'mobile-review.json'),JSON.stringify(reports,null,2));console.log(`${prefix}: ${record.checks.filter(c=>c.status==='passed').length}/${record.checks.length} checks, ${record.issues.length} findings`);}
 }
}finally{await browser.close();}
if(reports.some(r=>r.issues.length))process.exitCode=1;
