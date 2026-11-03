import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../site/theme/assets/not-found.js', import.meta.url), 'utf8');

function events() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options = {}) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ callback, once: options.once });
    },
    emit(type, values = {}) {
      const event = { type, target: this, currentTarget: this, detail: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
      for (const entry of [...(listeners.get(type) ?? [])]) {
        entry.callback(event);
        if (entry.once) listeners.set(type, listeners.get(type).filter(item => item !== entry));
      }
      return event;
    },
  };
}

function classes(initial = []) {
  const set = new Set(initial);
  return { add: value => set.add(value), remove: value => set.delete(value), contains: value => set.has(value) };
}

// Exercise the shipped renderer's lifecycle and native-control boundaries. Pixel
// quality, real canvas projection and pointer hit areas are verified in the browser.
async function fixture({ reduced = false, paused = false, motion = true, context = 'ok', loading = false, mobile = false, noSection = false, fonts = 'ready', sampling = 'ok' } = {}) {
  let now = 100;
  let nextFrame = 0;
  const pending = new Map();
  const observers = { mutation: [], intersection: [], resize: [] };
  const metrics = { draws: 0, fills: 0, finite: true, fail: false, fontLoads: [], sampledText: [], samples: 0 };
  const sectionRect = { left: 0, top: 88, width: mobile ? 390 : 1440, height: mobile ? 760 : 900 };
  const stageRect = { left: 0, top: 88, width: sectionRect.width, height: mobile ? 280 : 420 };
  const ctx = {
    setTransform() {},
    clearRect() { metrics.draws++; if (metrics.fail) throw new Error('Renderer unavailable'); },
    beginPath() {}, closePath() {}, stroke() {},
    arc(...points) { metrics.finite &&= points.every(Number.isFinite); },
    moveTo(...points) { metrics.finite &&= points.every(Number.isFinite); },
    lineTo(...points) { metrics.finite &&= points.every(Number.isFinite); },
    bezierCurveTo(...points) { metrics.finite &&= points.every(Number.isFinite); },
    fill() { metrics.fills++; },
    fillRect() {},
    createRadialGradient() { return { addColorStop() {} }; },
    createLinearGradient() { return { addColorStop() {} }; },
  };
  // A small deterministic glyph mask stands in for font rasterization. Real
  // Manrope metrics, shape and point density are checked in browser screenshots.
  const ink = {
    fillText(text) { metrics.sampledText.push(text); },
    getImageData(x, y, width, height) {
      if (sampling === 'read-throws') throw new Error('Font sampling unavailable');
      const data = new Uint8ClampedArray(width * height * 4);
      if (sampling !== 'empty') {
        for (let gy = 90; gy <= 330; gy += 10) {
          for (let gx = 180; gx <= 820; gx += 10) {
            const digit = Math.floor((gx - 180) / 240), local = (gx - 180) % 240;
            if (local > 160) continue;
            const dy = (gy - 210) / 120, dx = (local - 80) / 80;
            const zero = digit === 1 && Math.abs(dx * dx + dy * dy - 1) < .25;
            const four = digit !== 1 && (local >= 110 && local <= 130 || gy >= 240 && gy <= 260 || Math.abs(local - (330 - gy) * .5) < 12);
            if (zero || four) { data[(gy * width + gx) * 4 + 3] = 255; metrics.samples++; }
          }
        }
      }
      return { data };
    },
  };
  const stencil = { getContext() {
    if (sampling === 'context-throws') throw new Error('Stencil context unavailable');
    return sampling === 'context-null' ? null : ink;
  } };
  let resolveFont, rejectFont;
  const fontPromise = new Promise((resolve, reject) => { resolveFont = resolve; rejectFont = reject; });
  if (fonts === 'ready') resolveFont([]);
  const flushFonts = async () => { await Promise.resolve(); await Promise.resolve(); };
  const stage = Object.assign(events(), { getBoundingClientRect: () => stageRect, closest: () => null });
  const button = Object.assign(events(), { hidden: false, disabled: false, closest: selector => selector === 'button' ? button : null });
  const canvas = {
    hidden: false,
    getContext() {
      if (context === 'throws') throw new Error('Canvas context denied');
      return context === 'null' ? null : ctx;
    },
  };
  const section = {
    dataset: {}, classList: classes(), getBoundingClientRect: () => sectionRect,
    querySelector(selector) {
      return { '[data-not-found-canvas]': canvas, '[data-not-found-stage]': stage, '[data-not-found-burst]': button }[selector] ?? null;
    },
  };
  const body = { classList: classes([...(motion ? ['has-motion'] : []), ...(paused ? ['effects-paused'] : [])]) };
  const document = Object.assign(events(), {
    hidden: false, readyState: loading ? 'loading' : 'complete', body,
    querySelector: selector => selector === '[data-not-found-scene]' && !noSection ? section : null,
    createElement: tag => { if (tag !== 'canvas') throw new Error(`Unexpected element: ${tag}`); return stencil; },
    ...(fonts === 'absent' ? {} : { fonts: { load(font, text) { metrics.fontLoads.push({ font, text }); return fontPromise; } } }),
  });
  const media = Object.assign(events(), { matches: reduced });
  const window = events();
  const requestAnimationFrame = callback => { const id = ++nextFrame; pending.set(id, callback); return id; };
  const cancelAnimationFrame = id => pending.delete(id);
  const Observer = kind => class {
    constructor(callback) { this.callback = callback; this.targets = []; observers[kind].push(this); }
    observe(target) { this.targets.push(target); }
  };
  const IntersectionObserver = Observer('intersection');
  const ResizeObserver = Observer('resize');
  Object.assign(window, { IntersectionObserver, ResizeObserver });
  const sandbox = {
    document, window, performance: { now: () => now }, devicePixelRatio: 3,
    matchMedia: () => media,
    requestAnimationFrame, cancelAnimationFrame,
    MutationObserver: Observer('mutation'), IntersectionObserver, ResizeObserver,
  };
  vm.runInNewContext(source, sandbox);
  await flushFonts();
  return {
    section, stage, button, canvas, body, document, window, media, metrics, observers, flushFonts,
    async resolveFonts() { resolveFont([]); await flushFonts(); },
    async rejectFonts() { rejectFont(new Error('Font unavailable')); await flushFonts(); },
    get frames() { return pending.size; },
    get state() { return section.dataset.sceneState; },
    get ready() { return section.classList.contains('is-scene-ready'); },
    advance(ms) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 1000 / 60);
        const callbacks = [...pending.values()]; pending.clear();
        callbacks.forEach(callback => callback(now));
      }
    },
    pause(value) {
      body.classList[value ? 'add' : 'remove']('effects-paused');
      observers.mutation.forEach(observer => observer.callback([]));
    },
    reduce(value) { media.matches = value; media.emit('change'); },
    visibility(hidden) { document.hidden = hidden; document.emit('visibilitychange'); },
    intersect(value) { observers.intersection.forEach(observer => observer.callback([{ isIntersecting: value }])); },
  };
}

function expectStopped(state) {
  expect(state.frames).toBe(0);
  const draws = state.metrics.draws;
  state.advance(1000);
  expect(state.metrics.draws).toBe(draws);
}

describe('Decorative 404 scene lifecycle', () => {
  it.each([false, true])('draws finite sampled typography with capped resolution (mobile=%s)', async mobile => {
    const state = await fixture({ mobile });
    expect(state.ready).toBe(true);
    expect(state.canvas.hidden).toBe(false);
    expect(state.metrics.fills).toBeGreaterThan(100);
    expect(state.metrics.sampledText).toEqual(['404']);
    expect(state.metrics.fontLoads).toEqual([{ font: '400 360px "Manrope"', text: '404' }]);
    expect(state.metrics.finite).toBe(true);
    expect(state.canvas.width).toBe(mobile ? 585 : 2880);
    state.advance(80);
    expect(state.state).toBe('idle');
    expect(state.frames).toBe(1);
    expect(state.metrics.draws).toBeGreaterThan(1);
  });

  it.each([{ reduced: true }, { paused: true }, { motion: false }])('provides a stable still scene when motion is unavailable: %j', async options => {
    const state = await fixture(options);
    expect(state.ready).toBe(true);
    expect(state.state).toBe('paused');
    expect(state.button.disabled).toBe(true);
    state.button.emit('click');
    state.stage.emit('pointerdown', { button: 0, clientX: 120, clientY: 200 });
    expectStopped(state);
  });

  it('stops on pause, ignores input while paused, and resumes only one animation loop', async () => {
    const state = await fixture();
    state.advance(150);
    state.pause(true);
    expect(state.state).toBe('paused');
    expect(state.button.disabled).toBe(true);
    state.button.emit('click');
    expectStopped(state);
    state.pause(false);
    state.pause(false);
    expect(state.frames).toBe(1);
    state.advance(100);
    expect(state.state).toBe('idle');
    expect(state.button.disabled).toBe(false);
  });

  it('responds immediately to reduced-motion changes without losing its static visual', async () => {
    const state = await fixture();
    state.button.emit('click'); state.advance(350);
    state.reduce(true);
    expect(state.state).toBe('paused');
    expect(state.ready).toBe(true);
    expectStopped(state);
    state.reduce(false);
    state.advance(100);
    expect(state.state).toBe('idle');
    expect(state.frames).toBe(1);
  });

  it('suspends while hidden or offscreen, then resumes without duplicate loops', async () => {
    const state = await fixture();
    state.advance(100);
    state.visibility(true);
    expectStopped(state);
    state.visibility(false);
    state.intersect(false);
    expectStopped(state);
    state.intersect(true);
    state.intersect(true);
    expect(state.frames).toBe(1);
    state.advance(100);
    expect(state.state).toBe('idle');
  });

  it('cancels animation on pagehide and resumes once after BFCache pageshow', async () => {
    const state = await fixture();
    state.advance(100);
    state.window.emit('pagehide');
    expectStopped(state);
    state.window.emit('pageshow', { persisted: true });
    state.window.emit('pageshow', { persisted: true });
    expect(state.frames).toBe(1);
    state.advance(100);
    expect(state.state).toBe('idle');
  });

  it('allows keyboard activation to scatter and automatically reassemble', async () => {
    const state = await fixture();
    const event = state.button.emit('click', { detail: 0 });
    expect(event.defaultPrevented).toBe(false);
    state.advance(600);
    expect(state.state).toBe('scattered');
    state.advance(600);
    expect(state.state).toBe('returning');
    state.advance(1700);
    expect(state.state).toBe('idle');
  });

  it('distinguishes a long hold from a second click on release', async () => {
    const state = await fixture();
    state.button.emit('pointerdown', { button: 0 });
    state.advance(1600);
    expect(state.state).toBe('scattered');
    state.window.emit('pointerup');
    state.button.emit('click', { detail: 1 });
    state.advance(100);
    expect(state.state).toBe('returning');
    state.advance(1600);
    expect(state.state).toBe('idle');
  });

  it.each(['pointerup', 'pointercancel', 'blur'])('reassembles after a stage hold ends through %s', async type => {
    const state = await fixture();
    state.stage.emit('pointerdown', { button: 0, clientX: 400, clientY: 200 });
    state.advance(1600);
    expect(state.state).toBe('scattered');
    state.window.emit(type);
    state.advance(1800);
    expect(state.state).toBe('idle');
  });

  it('does not turn recovery-control or non-primary pointer input into a scene hold', async () => {
    const state = await fixture();
    const link = { closest: selector => selector.includes('a,') ? link : null };
    const otherButton = { closest: selector => selector === 'button' ? otherButton : null };
    for (const target of [link, otherButton]) {
      const event = state.stage.emit('pointerdown', { target, button: 0, clientX: 200, clientY: 180 });
      expect(event.defaultPrevented).toBe(false);
      state.advance(1000);
      expect(state.state).toBe('idle');
    }
    state.stage.emit('pointerdown', { button: 2, clientX: 200, clientY: 180 });
    state.advance(1000);
    expect(state.state).toBe('idle');
  });

  it.each(['null', 'throws'])('keeps the HTML fallback when canvas context creation %s', async context => {
    const state = await fixture({ context });
    expect(state.ready).toBe(false);
    expect(state.metrics.draws).toBe(0);
    expectStopped(state);
  });

  it('restores the fallback and removes animation affordances after renderer failure', async () => {
    const state = await fixture();
    expect(state.ready).toBe(true);
    state.metrics.fail = true;
    state.advance(80);
    expect(state.ready).toBe(false);
    expect(state.canvas.hidden).toBe(true);
    expect(state.button.hidden).toBe(true);
    expectStopped(state);
    state.window.emit('pageshow', { persisted: true });
    state.pause(true); state.pause(false);
    expectStopped(state);
  });

  it('initializes only after DOMContentLoaded when loaded in the document head', async () => {
    const state = await fixture({ loading: true });
    expect(state.ready).toBe(false);
    expect(state.frames).toBe(0);
    state.document.readyState = 'complete';
    state.document.emit('DOMContentLoaded');
    await state.flushFonts();
    expect(state.ready).toBe(true);
    const draws = state.metrics.draws;
    state.document.emit('DOMContentLoaded');
    expect(state.metrics.draws).toBe(draws);
    expect(state.frames).toBe(1);
  });

  it('keeps the readable fallback until the actual font is available', async () => {
    const state = await fixture({ fonts: 'pending' });
    expect(state.ready).toBe(false);
    expect(state.metrics.sampledText).toEqual([]);
    expectStopped(state);
    await state.resolveFonts();
    expect(state.ready).toBe(true);
    expect(state.metrics.sampledText).toEqual(['404']);
    expect(state.frames).toBe(1);
  });

  it('leaves the fallback intact when font loading is rejected', async () => {
    const state = await fixture({ fonts: 'pending' });
    await state.rejectFonts();
    expect(state.ready).toBe(false);
    expect(state.metrics.sampledText).toEqual([]);
    expectStopped(state);
    state.pause(true); state.pause(false);
    state.window.emit('pageshow', { persisted: true });
    expectStopped(state);
  });

  it('does not draw or restart offpage when the font arrives after pagehide', async () => {
    const state = await fixture({ fonts: 'pending' });
    state.window.emit('pagehide');
    await state.resolveFonts();
    expect(state.ready).toBe(false);
    expect(state.metrics.draws).toBe(0);
    expectStopped(state);
    state.window.emit('pageshow', { persisted: true });
    state.window.emit('pageshow', { persisted: true });
    expect(state.frames).toBe(1);
    state.advance(100);
    expect(state.ready).toBe(true);
    expect(state.state).toBe('idle');
  });

  it('waits for visibility if the font finishes in a hidden document', async () => {
    const state = await fixture({ fonts: 'pending' });
    state.visibility(true);
    await state.resolveFonts();
    expect(state.metrics.draws).toBe(0);
    expectStopped(state);
    state.visibility(false);
    state.advance(100);
    expect(state.ready).toBe(true);
    expect(state.frames).toBe(1);
  });

  it.each(['pause', 'reduce'])('honours a %s preference changed while the font was pending', async preference => {
    const state = await fixture({ fonts: 'pending' });
    state[preference](true);
    await state.resolveFonts();
    expect(state.ready).toBe(true);
    expect(state.state).toBe('paused');
    expect(state.button.disabled).toBe(true);
    expectStopped(state);
    state[preference](false);
    state.advance(100);
    expect(state.state).toBe('idle');
    expect(state.frames).toBe(1);
  });

  it.each(['context-null', 'context-throws', 'read-throws', 'empty'])('keeps the HTML fallback when font sampling fails: %s', async sampling => {
    const state = await fixture({ sampling });
    expect(state.ready).toBe(false);
    expect(state.metrics.draws).toBe(0);
    expectStopped(state);
    state.pause(true); state.pause(false);
    state.window.emit('resize');
    expectStopped(state);
  });

  it('can render a static scene when the Font Loading API is unavailable', async () => {
    const state = await fixture({ fonts: 'absent', reduced: true });
    expect(state.ready).toBe(true);
    expect(state.metrics.sampledText).toEqual(['404']);
    expect(state.metrics.fontLoads).toEqual([]);
    expect(state.state).toBe('paused');
    expectStopped(state);
  });

  it('does nothing on pages without the 404 scene', async () => {
    const state = await fixture({ noSection: true });
    expect(state.metrics.draws).toBe(0);
    expect(state.frames).toBe(0);
    expect(state.observers.mutation).toHaveLength(0);
  });
});
