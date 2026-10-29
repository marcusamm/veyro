// Real Canvas2D renderer regression tests. No local server or external requests.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

const motion = readFileSync(fileURLToPath(new URL('../site/theme/assets/motion.js', import.meta.url)), 'utf8').replace(/<\/script/gi, '<\\/script');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{margin:0;background:#222;color:#eee;font:16px sans-serif}main{min-height:4000px}.studio-stage{position:relative;height:950px;overflow:clip}.studio-art{position:absolute;width:800px;height:650px;left:0;top:0;pointer-events:none}.studio-particles{width:100%;height:100%;pointer-events:none}.studio-message{position:absolute;right:20px;top:60px;width:260px}.studio-action{position:absolute;right:20px;top:430px;width:260px}.studio-stage a,.studio-stage button,.studio-stage summary{display:block;padding:10px}.studio-stage input{width:180px}.motion-reveal{opacity:1}@media(max-width:500px){.studio-art{width:360px;height:470px}.studio-message{top:500px;width:320px}.studio-message h1{font-size:22px}.studio-action{top:700px;width:320px}}
</style></head><body class="has-motion"><header><button data-motion-toggle><span data-motion-icon>Ⅱ</span></button></header><main>
<section class="studio-stage"><div class="studio-art"><canvas data-particle-scene class="studio-particles" aria-hidden="true"></canvas></div><div class="studio-message"><h1>Din forretning. Dit eget udtryk.</h1><a id="cta" href="#destination">Aftal en demo</a><button id="ordinary">Ordinary action</button><details id="package"><summary>Hvad er med i pakkerne?</summary><p>Includes hosting.</p></details><label for="name">Name</label><input id="name"><select aria-label="Service"><option>Hjemmeside</option></select></div><div class="studio-action"><a href="#destination">Se vores eksempler</a></div></section><div id="destination">Destination</div>
</main><script>${motion}</script></body></html>`;

let browser;
const sessions = [];
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterEach(async () => {
  for (const { context, errors, requests } of sessions.splice(0)) {
    await context.close();
    expect(errors, 'No uncaught renderer errors').toEqual([]);
    expect(requests, 'The isolated fixture needs no network access').toEqual([]);
  }
});
afterAll(async () => { await browser?.close(); });

async function mount({ mobile = false, reduced = false, lowPower = false } = {}) {
  const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1100, height: 1000 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const errors = [], requests = [];
  sessions.push({ context, errors, requests });
  await context.addInitScript(({ lowPower }) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => lowPower ? 2 : 8 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => lowPower ? 2 : 8 });
    const qa = window.sceneQA = { draws: 0, dots: [], geometry: [], activations: [] };
    // Delegate to native arrays and Canvas2D. Capture the actual generated source
    // points and drawn arcs, rather than reimplementing the projection in a test.
    const push = Array.prototype.push, sets = new WeakMap();
    Array.prototype.push = function (...values) {
      for (const p of values) {
        if (!p || typeof p !== 'object' || !['x','y','z','nx','ny','nz','u','angle'].every(k => typeof p[k] === 'number')) continue;
        let captured = sets.get(this);
        if (!captured) { captured = []; sets.set(this, captured); push.call(qa.geometry, captured); }
        push.call(captured, { x:p.x, y:p.y, z:p.z, nx:p.nx, ny:p.ny, nz:p.nz, u:p.u, angle:p.angle });
      }
      return push.apply(this, values);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect, arc = CanvasRenderingContext2D.prototype.arc;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.matches('[data-particle-scene]')) { qa.draws++; qa.dots = []; }
      return clear.apply(this, args);
    };
    CanvasRenderingContext2D.prototype.arc = function (x, y, radius, ...args) {
      if (this.canvas.matches('[data-particle-scene]')) push.call(qa.dots, [x, y, radius]);
      return arc.call(this, x, y, radius, ...args);
    };
    document.addEventListener('click', e => { const c=e.target.closest('a,button,summary,input,select,label'); if(c)qa.activations.push(c.id || c.tagName); });
  }, { lowPower });
  await context.route('**/*', route => {
    if (route.request().url() === 'https://particle-scene.test/' && route.request().method() === 'GET') return route.fulfill({ contentType: 'text/html', body: fixture });
    requests.push(`${route.request().method()} ${route.request().url()}`); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  // Native Canvas and layout remain real; only animation time is deterministic.
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
  await page.goto('https://particle-scene.test/');
  await expect.poll(() => page.evaluate(() => window.sceneQA.draws)).toBeGreaterThan(0);
  return page;
}
async function advance(page, ms) { await page.clock.runFor(ms); }
async function frame(page) {
  return page.evaluate(() => {
    const c=document.querySelector('[data-particle-scene]'),qa=window.sceneQA;
    const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let hash=2166136261,alpha=0;for(let i=0;i<pixels.length;i++){hash=Math.imul(hash^pixels[i],16777619);if(i%4===3)alpha+=pixels[i];}
    const xs=qa.dots.map(d=>d[0]),ys=qa.dots.map(d=>d[1]);
    return { draws:qa.draws, count:qa.dots.length, pixels:hash>>>0, alpha, bounds:[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)], formation:c.dataset.formation, paused:c.dataset.paused, canvas:[c.width,c.height], countCanvases:document.querySelectorAll('[data-particle-scene]').length };
  });
}
async function settle(page) { await advance(page, 2200); expect((await frame(page)).formation).toBe('formed'); }
async function pointer(page, x, y, type='mouse') { await page.locator('.studio-stage').dispatchEvent('pointermove', { clientX:x, clientY:y, pointerType:type }); }
async function scroll(page, y) {
  await page.evaluate(y => scrollTo(0,y), y);
  // IntersectionObserver uses the real browser compositor; let it deliver before
  // advancing the paused animation clock.
  await new Promise(resolve => setTimeout(resolve, 70));
  await advance(page, 80);
}
// Math trig may differ in the final bit across Node/Chromium V8 versions.
const hash = value => createHash('sha256').update(JSON.stringify(value.map(p=>Object.fromEntries(Object.entries(p).map(([k,v])=>[k,Number(v.toFixed(12))]))))).digest('hex');
const delta = (a,b) => Math.max(...a.bounds.map((n,i)=>Math.abs(n-b.bounds[i])));

describe('Existing hero particle V through the real browser renderer', () => {
  it('keeps every original base coordinate and surface normal on desktop and mobile', async () => {
    // Recorded before the polish, excluding unused morph-orbit coordinates.
    for (const [mobile,count,expected] of [[false,3672,'b38a9d9e815d5ba1d1b95a4ed6a2cd0b3030b869588711806fc6ce0feb5e09d6'],[true,1710,'0f5646121d0c7b03e948e6a0740116e8006318c432b1cbb763b0044db3738071']]) {
      const page=await mount({mobile});
      const points=await page.evaluate(()=>window.sceneQA.geometry.at(-1));
      expect(points).toHaveLength(count);expect(hash(points)).toBe(expected);
      await settle(page);const rendered=await frame(page);
      expect(rendered.count).toBe(count);expect(rendered.alpha).toBeGreaterThan(1000);expect(rendered.countCanvases).toBe(1);
      if(mobile)expect(rendered.canvas).toEqual([540,705]);
    }
  });

  it('assembles over 1.5–2 seconds once, retaining the rendered V after scroll and resize', async () => {
    const page=await mount();const initial=await frame(page);
    expect(initial.formation).toBe('assembling');
    await advance(page,1500);const assembling=await frame(page);expect(assembling.formation).toBe('assembling');
    await advance(page,480);const formed=await frame(page);expect(formed.formation).toBe('formed');
    expect(formed.count).toBe(3672);expect(formed.pixels).not.toBe(initial.pixels);
    await scroll(page,350);const rotated=await frame(page);expect(rotated.formation).toBe('formed');expect(rotated.count).toBe(3672);
    expect(rotated.bounds[1]-rotated.bounds[0]).toBeGreaterThan(formed.bounds[1]*.55);
    await scroll(page,0);await page.setViewportSize({width:1120,height:1000});await advance(page,200);
    expect((await frame(page)).formation).toBe('formed');
    expect(await page.locator('.studio-stage h1').getAttribute('aria-label')).toBe('Din forretning. Dit eget udtryk.');
  });

  it('stops real Canvas draws offscreen, while hidden, and through the effects control', async () => {
    const page=await mount();await settle(page);
    await scroll(page,1600);await expect.poll(async()=>(await frame(page)).paused).toBe('true');
    const off=await frame(page);await advance(page,1200);expect((await frame(page)).draws).toBe(off.draws);
    await scroll(page,0);await advance(page,250);expect((await frame(page)).draws).toBeGreaterThan(off.draws);
    // Exercise the actual visibility event branch without pretending headless
    // Chromium changes document.hidden when a second tab is opened.
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
    const hidden=await frame(page);await advance(page,900);expect((await frame(page)).draws).toBe(hidden.draws);
    await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});await advance(page,250);
    expect((await frame(page)).draws).toBeGreaterThan(hidden.draws);
    await page.locator('[data-motion-toggle]').dispatchEvent('click');const paused=await frame(page);await advance(page,900);
    expect((await frame(page)).draws).toBe(paused.draws);expect((await frame(page)).pixels).toBe(paused.pixels);
    await page.locator('[data-motion-toggle]').dispatchEvent('click');await advance(page,250);
    expect((await frame(page)).draws).toBeGreaterThan(paused.draws);expect((await frame(page)).formation).toBe('formed');
  });

  it('shows stable native pixels with reduced motion, including pointer and scroll input', async () => {
    const page=await mount({reduced:true});const still=await frame(page);
    expect(still.formation).toBe('formed');expect(still.alpha).toBeGreaterThan(1000);
    await pointer(page,340,280);await advance(page,2500);await scroll(page,320);
    const later=await frame(page);expect(later.pixels).toBe(still.pixels);expect(later.draws).toBe(still.draws);
    await page.emulateMedia({reducedMotion:'no-preference'});await new Promise(resolve=>setTimeout(resolve,80));await advance(page,900);
    expect((await frame(page)).formation).toBe('formed');expect((await frame(page)).draws).toBeGreaterThan(later.draws);
    await page.emulateMedia({reducedMotion:'reduce'});await new Promise(resolve=>setTimeout(resolve,80));await advance(page,80);const reducedAgain=await frame(page);await advance(page,900);
    expect((await frame(page)).pixels).toBe(reducedAgain.pixels);expect((await frame(page)).draws).toBe(reducedAgain.draws);
  });

  it('responds to desktop pointer and scroll input and returns to the same idle pose', async () => {
    const active=await mount(),control=await mount();await settle(active);await settle(control);
    await pointer(active,260,230);await advance(active,600);await advance(control,600);
    const touched=await frame(active),idle=await frame(control);expect(touched.pixels).not.toBe(idle.pixels);expect(delta(touched,idle)).toBeGreaterThan(.2);
    await active.locator('.studio-stage').dispatchEvent('pointerleave');await advance(active,2100);await advance(control,2100);
    expect(delta(await frame(active),await frame(control))).toBeLessThan(.1);
    await scroll(active,320);await advance(active,500);await advance(control,580);
    expect(delta(await frame(active),await frame(control))).toBeGreaterThan(1);
    await scroll(active,0);await advance(active,300);await advance(control,380);
    expect(delta(await frame(active),await frame(control))).toBeLessThan(.2);
  });

  it('limits a temporary ripple to empty hero clicks and never applies it to controls', async () => {
    const active=await mount(),control=await mount();await settle(active);await settle(control);
    // Prevent fixture anchor navigation after the hero listener has run, so an
    // accidental ripple is still observable rather than hidden by navigation.
    await active.evaluate(()=>document.addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();}));
    const click={clientX:260,clientY:230};
    for(const selector of ['#cta','#ordinary','#package > summary','label[for="name"]','#name','select']){
      await active.locator(selector).dispatchEvent('click',click);
      await advance(active,240);await advance(control,240);
      expect((await frame(active)).pixels,`${selector} must not start a ripple`).toBe((await frame(control)).pixels);
    }
    await active.locator('.studio-stage').dispatchEvent('click',click);
    await advance(active,240);await advance(control,240);
    expect((await frame(active)).pixels,'Empty hero click produces real native pixel changes').not.toBe((await frame(control)).pixels);
    await advance(active,1400);await advance(control,1400);
    expect((await frame(active)).pixels,'The ripple settles into the same idle V').toBe((await frame(control)).pixels);
  });

  it('leaves real links, native disclosure, and form controls operable on touch', async () => {
    const page=await mount({mobile:true});await settle(page);
    await page.locator('#package > summary').tap();expect(await page.locator('#package').evaluate(e=>e.open)).toBe(true);
    await page.locator('#package > summary').tap();expect(await page.locator('#package').evaluate(e=>e.open)).toBe(false);
    await page.locator('#name').fill('Veyro');expect(await page.locator('#name').inputValue()).toBe('Veyro');
    await page.locator('#ordinary').tap();expect(await page.evaluate(()=>window.sceneQA.activations)).toContain('ordinary');
    await page.locator('#cta').tap();expect(new URL(page.url()).hash).toBe('#destination');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0);
    const before=await frame(page);await pointer(page,120,200,'touch');await advance(page,500);
    expect((await frame(page)).count).toBe(before.count);
  });
});
