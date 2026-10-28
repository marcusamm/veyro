// Public marketing click-target geometry audit. Read-only DOM interaction; all POSTs blocked.
// BASE=http://localhost:52194 OUT=/private/tmp/veyro-click-targets node scripts/review-click-targets.mjs
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const base=process.env.BASE||'http://localhost:52194';
const out=process.env.OUT||'/private/tmp/veyro-click-targets';
mkdirSync(out,{recursive:true});
const content=JSON.parse(readFileSync(path.join(root,'site/content.json'),'utf8'));
const routes=process.env.PATHS?process.env.PATHS.split(','):['/',...content.pages.filter(p=>p.published).map(p=>'/pages/'+p.handle),'/cart'];
const viewports=process.env.VIEWPORTS?process.env.VIEWPORTS.split(',').map(s=>{const [width,height]=s.split('x').map(Number);return{width,height};}):[{width:1280,height:720},{width:1440,height:900},{width:820,height:1180}];
const motion = process.env.MOTION === 'normal' ? 'normal' : 'reduced';
const browser=await chromium.launch();
const results=[],failures=[],infra=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function save(){writeFileSync(path.join(out,'review.json'),JSON.stringify({base,motion,viewports,routes,results,failures,infra},null,2));}

async function auditDom(page){
 return await page.evaluate(async()=>{
  const selector=el=>{
   if(!el)return null;
   if(el.id)return '#'+CSS.escape(el.id);
   const parts=[];let n=el;
   while(n&&n!==document.body&&parts.length<6){
    if(n.id){parts.unshift('#'+CSS.escape(n.id));break;}
    let part=n.tagName.toLowerCase();
    const cls=[...n.classList].filter(c=>!c.startsWith('is-')).slice(0,2);if(cls.length)part+='.'+cls.map(c=>CSS.escape(c)).join('.');
    const siblings=n.parentElement?[...n.parentElement.children].filter(s=>s.tagName===n.tagName):[];
    if(siblings.length>1)part+=`:nth-of-type(${siblings.indexOf(n)+1})`;
    parts.unshift(part);n=n.parentElement;
   }
   return parts.join(' > ');
  };
  const q='a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[tabindex]:not([tabindex="-1"])';
  const seen=new WeakSet();const records=[];let skipped=0;
  const candidates=()=>[...document.querySelectorAll(q)].filter(el=>!el.disabled&&!el.closest('[hidden],[inert],[aria-hidden="true"]'));
  const visible=el=>{
   const css=getComputedStyle(el),r=el.getBoundingClientRect();
   if(css.display==='none'||css.visibility==='hidden'||!r.width||!r.height)return false;
   const closed=el.closest('details:not([open])');
   if(closed&&!closed.querySelector('summary')?.contains(el))return false;
   return true;
  };
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  async function pass(state){
   for(const el of candidates()){
    if(seen.has(el)||!visible(el)){skipped++;continue;}
    seen.add(el);
    const cs=getComputedStyle(el);
    if(el.classList.contains('skip-link')){records.push({state,selector:selector(el),label:el.textContent.trim(),status:'intentional-keyboard-only'});continue;}
    if(cs.pointerEvents==='none'&&el.matches('.doc__toc-box summary')&&el.parentElement.open){records.push({state,selector:selector(el),label:el.textContent.trim(),status:'intentional-open-toc-heading'});continue;}
    let target=el,proxy=false;
    if(el.matches('input[type="radio"],input[type="checkbox"]')&&(cs.opacity==='0'||el.getBoundingClientRect().width<8||cs.clipPath!=='none')){
     const label=el.closest('label')||el.labels?.[0];if(label){target=label;proxy=true;}
    }
    if(Number(cs.opacity)===0&&!proxy){records.push({state,selector:selector(el),label:el.getAttribute('aria-label')||el.textContent.trim(),status:'invisible-control'});continue;}
    target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});await frame();
    const bounds=target.getBoundingClientRect();
    const rects=[...target.getClientRects()].filter(r=>r.width>0&&r.height>0).sort((a,b)=>b.width*b.height-a.width*a.height);
    const points=[];
    rects.slice(0,4).forEach((r,i)=>{
     points.push({type:i?'fragment-centre':'centre',x:r.left+r.width/2,y:r.top+r.height/2});
     if(i===0){const inset=Math.min(7,r.width/5,r.height/5);points.push({type:'top-left',x:r.left+inset,y:r.top+inset},{type:'top-right',x:r.right-inset,y:r.top+inset},{type:'bottom-left',x:r.left+inset,y:r.bottom-inset},{type:'bottom-right',x:r.right-inset,y:r.bottom-inset});}
    });
    const hits=points.map(point=>{
     const inViewport=point.x>=0&&point.x<innerWidth&&point.y>=0&&point.y<innerHeight;
     const hit=inViewport?document.elementFromPoint(point.x,point.y):null;
     const works=!!hit&&(target===hit||target.contains(hit)||el===hit||el.contains(hit));
     return{...point,inViewport,works,hit:selector(hit),hitTag:hit?.tagName,hitClass:hit?.className,blockerType:hit?.closest('.cookie')?'cookie':hit?.closest('[data-mobile-nav]')?'navigation':hit?.closest('.section-header')?'sticky-header':hit?.closest('.project-gallery__plane')?'gallery-plane':null};
    });
    const centres=hits.filter(p=>p.type==='centre'||p.type==='fragment-centre');
    let status=centres.some(p=>p.works)?'passed':hits.some(p=>p.works)?'partial-occlusion':'blocked';
    if((status==='blocked'||status==='partial-occlusion')&&el.closest('.project-gallery__plane')&&hits.some(h=>h.blockerType==='gallery-plane'))status='intentional-gallery-depth';
    if((status==='blocked'||status==='partial-occlusion')&&hits.some(h=>h.blockerType==='cookie'||h.blockerType==='navigation'))status='intentional-overlay-occlusion';
    const label=(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.labels?.[0]?.textContent||el.textContent||el.getAttribute('name')||'').replace(/\s+/g,' ').trim().slice(0,140);
    records.push({state,selector:selector(el),targetSelector:selector(target),tag:el.tagName,label,href:el.getAttribute('href'),proxy,status,pointerEvents:cs.pointerEvents,bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},scrollY,hitPoints:hits});
   }
  }
  await pass('default');
  document.querySelectorAll('details').forEach(el=>{el.open=true;});await frame();
  await pass('expanded-details');
  return{records,skipped,pageHeight:document.documentElement.scrollHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,cssVersions:[...document.querySelectorAll('link[rel="stylesheet"]')].map(el=>el.getAttribute('href'))};
 });
}
try{
 for(const viewport of viewports){
  const ctx=await browser.newContext({viewport,reducedMotion:motion === 'normal' ? 'no-preference' : 'reduce'});
  await ctx.route('**/*',route=>route.request().method()==='POST'?route.abort():route.continue());
  await ctx.addInitScript(()=>localStorage.setItem('theme-cookie-consent',JSON.stringify({v:1,t:Date.now(),consent:{analytics:false,marketing:false}})));
  const page=await ctx.newPage();
  for(const route of routes){
   const errors=[];const onError=e=>errors.push(e.message);page.on('pageerror',onError);
   let report;
   for(let retry=0;retry<2;retry++){
    try{
     const response=await page.goto(base+route,{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);await wait(700);
     report={route,...viewport,motion,httpStatus:response.status(),...await auditDom(page),errors};break;
    }catch(error){
     infra.push({route,...viewport,retry,error:error.message});
     if(retry===1)report={route,...viewport,error:error.stack,errors,records:[]};
    }
   }
   page.off('pageerror',onError);
   const actual=report.records.filter(r=>['blocked','partial-occlusion','invisible-control'].includes(r.status));
   for(const [i,issue]of actual.entries()){
    try{
     if(issue.state==='expanded-details')await page.evaluate(()=>document.querySelectorAll('details').forEach(d=>d.open=true));
     const target=page.locator(issue.targetSelector||issue.selector).first();await target.scrollIntoViewIfNeeded();await wait(120);
     const slug=route==='/'?'home':route.split('/').filter(Boolean).join('-');const filename=`${viewport.width}x${viewport.height}-${slug}-${i+1}.png`;
     await page.screenshot({path:path.join(out,filename)});issue.screenshot=filename;
    }catch(error){issue.captureError=error.message;}
    failures.push({route,...viewport,...issue});
   }
   results.push(report);save();
   console.log(`${viewport.width}x${viewport.height} ${route}: ${report.records.length} targets; ${actual.length} potential failures`);
  }
  await ctx.close();
 }
}finally{save();await browser.close();}
console.log(`Audit complete: ${results.length} page/viewport cases, ${failures.length} potential failures`);
