import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../site/theme/assets/home-flow.js', import.meta.url), 'utf8');

function fixture({ homepage = true, reduced = false, mobile = false } = {}) {
  const listeners = new Map(), frames = new Map(), observers = [];
  let frameId = 0;
  let styleWrites = 0, layoutReads = 0;
  const style = () => {
    const values = new Map();
    return { setProperty: (key, value) => { styleWrites++; values.set(key, value); }, getPropertyValue: key => values.get(key) || '' };
  };
  const body = { classes: new Set(['has-motion', ...(homepage ? ['template-index'] : [])]), style: style() };
  body.prepend = element => { body.atmosphere = element; };
  body.classList = { contains: name => body.classes.has(name) };
  const media = { matches: reduced, addEventListener: (_, fn) => { media.changed = fn; } };
  const compact = { matches: mobile, addEventListener: (_, fn) => { compact.changed = fn; } };
  const active = () => !media.matches && !compact.matches && !body.classes.has('effects-paused');
  const item = (top, interactive = false) => ({
    top, classes: new Set(), style: style(),
    classList: { add(name) { this.host.classes.add(name); } },
    querySelector: () => interactive ? {} : null,
    getBoundingClientRect() { layoutReads++; return { top: this.top - context.scrollY + (active() ? parseFloat(this.style.getPropertyValue('--home-flow-y')) || 0 : 0), height: 80 }; },
  });
  const heading = item(650), linkGroup = item(700, true);
  heading.classList.host = heading; linkGroup.classList.host = linkGroup;
  const document = {
    body, hidden: false, readyState: 'complete', documentElement: { scrollHeight: 7000 },
    createElement: () => ({ style: style(), setAttribute() {} }),
    querySelectorAll: () => [heading, linkGroup], querySelector: () => ({}),
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const context = {
    document, innerHeight: 900, scrollY: 0, matchMedia: query => query.includes('coarse') ? compact : media,
    getComputedStyle: el => ({ translate: active() ? `0px ${el.style.getPropertyValue('--home-flow-y') || '0px'}` : 'none' }),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, fn, options) => { listeners.set(name, fn); if (name === 'scroll') context.scrollOptions = options; },
    MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    ResizeObserver: class { observe() {} },
  };
  context.window = context;
  vm.runInNewContext(source, context);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  const scroll = y => { context.scrollY = y; listeners.get('scroll')?.(); flush(); };
  return { context, document, body, heading, linkGroup, media, compact, listeners, frames, observers, flush, scroll,
    work: () => ({ styleWrites, layoutReads }),
    shift: () => parseFloat(heading.style.getPropertyValue('--home-flow-y')) || 0 };
}

describe('homepage continuous flow', () => {
  it('tracks native scrolling directly, reverses exactly and does no idle work', () => {
    const f = fixture();
    const initial = f.shift();
    f.scroll(200); const after = f.shift();
    f.scroll(400); expect(f.shift()).toBeLessThan(after);
    f.scroll(200); expect(f.shift()).toBe(after);
    f.scroll(0); expect(f.shift()).toBe(initial);
    expect(f.context.scrollOptions.passive).toBe(true);
    expect(f.frames.size).toBe(0);
    expect(f.linkGroup.classes.has('home-flow-item')).toBe(false);
  });

  it('keeps measurement stable after resize, pause and resuming motion', () => {
    const f = fixture(); f.scroll(200); const original = f.shift();
    f.listeners.get('resize')(); f.flush(); expect(f.shift()).toBe(original);
    f.body.classes.add('effects-paused'); f.observers[0](); f.flush();
    expect(f.shift()).toBe(0);
    expect(f.body.atmosphere.style.transform).toBe('none');
    f.body.classes.delete('effects-paused'); f.observers[0](); f.flush();
    expect(f.shift()).toBe(original);
    f.media.matches = true; f.media.changed(); f.flush();
    expect(f.shift()).toBe(0);
    f.media.matches = false; f.media.changed(); f.flush();
    expect(f.shift()).toBe(original);
  });

  it('coalesces scrolls, cancels hidden-page work and restores on back navigation', () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) f.listeners.get('scroll')();
    expect(f.frames.size).toBe(1);
    f.listeners.get('pagehide')(); expect(f.frames.size).toBe(0);
    f.scroll(300); expect(f.frames.size).toBe(0);
    f.listeners.get('pageshow')(); f.flush();
    expect(f.shift()).toBeLessThan(0);
    f.document.hidden = true; f.listeners.get('visibilitychange')();
    f.listeners.get('scroll')(); expect(f.frames.size).toBe(0);
  });

  it('leaves reduced-motion content static and does not initialize on other pages', () => {
    const reduced = fixture({ reduced: true }); reduced.scroll(400);
    expect(reduced.shift()).toBe(0);
    const page = fixture({ homepage: false });
    expect(page.listeners.size).toBe(0);
    expect(page.heading.classes.size).toBe(0);
  });

  it('does no scroll rendering or layout work on phones, including toolbar height changes', () => {
    const f = fixture({ mobile: true });
    const before = f.work();
    for (let y = 0; y < 3000; y += 25) {
      f.context.scrollY = y;
      f.listeners.get('scroll')();
      expect(f.frames.size).toBe(0);
    }
    f.context.innerHeight += 100;
    f.listeners.get('resize')(); f.flush();
    expect(f.work()).toEqual(before);
    expect(f.shift()).toBe(0);
    expect(f.body.style.getPropertyValue('--home-light-y')).toBe('');
  });

  it('isolates desktop atmosphere styles and restores motion after leaving touch mode', () => {
    const f = fixture(); f.scroll(250);
    const shift = f.shift(), transform = f.body.atmosphere.style.transform;
    expect(transform).toContain('translate3d(');
    expect(f.body.style.getPropertyValue('--home-light-y')).toBe('');
    expect(f.body.style.getPropertyValue('--home-light-x')).toBe('');
    f.compact.matches = true; f.compact.changed(); f.flush();
    expect(f.shift()).toBe(0);
    expect(f.body.atmosphere.style.transform).toBe('none');
    f.compact.matches = false; f.compact.changed(); f.flush();
    expect(f.shift()).toBe(shift);
    expect(f.body.atmosphere.style.transform).toBe(transform);
  });
});
