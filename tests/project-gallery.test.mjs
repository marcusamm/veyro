import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../site/theme/assets/project-gallery.js', import.meta.url), 'utf8');
const properties = ['--x', '--y', '--z', '--rotate-y', '--plane-opacity', '--plane-shade'];
const dataName = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
    this.dataset = {}; this.attributes = new Map(); this.listeners = new Map(); this.inert = false;
    this.text = ''; this.classes = new Set(); this.focusVisible = false;
    const values = new Map();
    this.style = { visibility: '', pointerEvents: '', setProperty: (key, value) => values.set(key, String(value)), getPropertyValue: key => values.get(key) || '', removeProperty: key => values.delete(key) };
    this.classList = { contains: name => this.classes.has(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name), toggle: (name, force) => { const add = force ?? !this.classes.has(name); this.classes[add ? 'add' : 'delete'](name); return add; } };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set href(value) { this.setAttribute('href', value); }
  get href() { return this.getAttribute('href'); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.getAttribute('src'); }
  set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
  get tabIndex() { return this.attributes.has('tabindex') ? Number(this.attributes.get('tabindex')) : this.tagName === 'A' ? 0 : -1; }
  setAttribute(name, value) { if (name.startsWith('data-')) this.dataset[dataName(name)] = String(value); else this.attributes.set(name, String(value)); }
  getAttribute(name) { return name.startsWith('data-') ? this.dataset[dataName(name)] ?? null : this.attributes.get(name) ?? null; }
  removeAttribute(name) { if (name.startsWith('data-')) delete this.dataset[dataName(name)]; else this.attributes.delete(name); }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  matches(selector) {
    if (selector === ':focus-visible') return this.focusVisible;
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (/^\[data-[\w-]+\]$/.test(selector)) return this.getAttribute(selector.slice(1, -1)) !== null;
    return this.tagName.toLowerCase() === selector;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const direct = selector.split(' > ');
    const matches = node => direct.length === 2 ? node.matches(direct[1]) && node.parentElement?.matches(direct[0]) : node.matches(selector);
    const found = [];
    const walk = parent => parent.children.forEach(child => { if (matches(child)) found.push(child); walk(child); });
    walk(this); return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, callback, options) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push({ callback, options }); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.callback !== callback)); }
  emit(type, values = {}) {
    const event = { type, target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    for (const { callback } of [...(this.listeners.get(type) || [])]) callback(event);
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((count, entries) => count + entries.length, 0); }
}

const demo = index => ({ title: `Project ${index + 1}`, category: `Category ${index + 1}`, description: `Description ${index + 1}`, accent: '#52726b', previewImage: `/demo/_previews/project-${index + 1}.jpg`, url: `/demo/project-${index + 1}/` });
function card(data) {
  const plane = new Element('a'); plane.className = 'project-gallery__plane'; plane.href = data.url;
  for (const key of ['title', 'category', 'description', 'accent']) plane.dataset[`demo${key[0].toUpperCase()}${key.slice(1)}`] = data[key];
  const figure = new Element('figure'), img = new Element('img'), caption = new Element('figcaption'), title = new Element('span');
  img.src = data.previewImage; img.alt = data.title; title.textContent = data.title;
  caption.append(title); figure.append(img, caption); plane.append(figure); return plane;
}

// The actual shipped class runs against document geometry and native-link state.
// CSS perspective, painting and real keyboard navigation are separately browser-reviewed.
function fixture({ count = 3, demos, reduced = false, paused = false, motion = true, height = 900, width = 1440, pinHeight = 720, sticky = true, depth = true, io = true, absoluteTop = 400, withDepth = true, homepage = false } = {}) {
  const window = new Element(), document = new Element(), root = new Element();
  const body = new Element('body'); if (motion) body.classList.add('has-motion'); if (paused) body.classList.add('effects-paused'); if (homepage) body.classList.add('template-index');
  const make = (tag, key) => { const el = new Element(tag); el.setAttribute(`data-gallery-${key}`, ''); return el; };
  const track = make('div', 'track'), pin = make('div', 'pin'), stage = make('div', 'stage');
  const depthLayer = withDepth ? make('div', 'depth') : null;
  if (depthLayer) { depthLayer.setAttribute('aria-hidden', 'true'); pin.append(depthLayer); }
  const title = make('h3', 'title'), category = make('span', 'category'), description = make('p', 'description'), counter = make('span', 'count'), open = make('a', 'open');
  const initial = Array.from({ length: count }, (_, index) => demo(index));
  stage.append(...initial.map(card)); pin.append(stage, title, category, description, counter, open); track.append(pin); root.append(track); body.append(root);
  root.dataset.projectGallery = ''; root.className = 'project-gallery'; open.href = initial[0]?.url || '/demo/';
  const header = new Element('header'); header.getBoundingClientRect = () => ({ height: 88 });
  Object.assign(window, { innerHeight: height, innerWidth: width, scrollY: 0, location: { href: 'https://veyro.dk/' }, scrollTo() { throw new Error('Native scroll must never be intercepted'); } });
  Object.assign(document, { body, activeElement: body, hidden: false, readyState: 'complete', baseURI: 'https://veyro.dk/', documentElement: { clientHeight: height }, createElement: tag => new Element(tag) });
  document.querySelectorAll = () => [];
  document.querySelector = selector => selector === '.site-header' ? header : null;
  let layoutReads = 0;
  track.getBoundingClientRect = () => { layoutReads++; const h = parseFloat(root.style.getPropertyValue('--gallery-scroll-height')) || pinHeight; const top = absoluteTop - window.scrollY; return { top, bottom: top + h, height: h, width }; };
  pin.getBoundingClientRect = () => ({ top: 88, height: pinHeight, width });
  stage.getBoundingClientRect = () => ({ top: 140, height: 420, width: width - 100 });
  const media = new Element(); media.matches = reduced;
  const pending = new Map(); let next = 0;
  const observers = { mutation: [], resize: [], intersection: [] };
  const Observer = kind => class { constructor(callback) { this.callback = callback; this.targets = []; observers[kind].push(this); } observe(target) { this.targets.push(target); } disconnect() { this.disconnected = true; } };
  const CSS = { supports: (property, value) => property === 'position' ? sticky : property === 'transform-style' ? depth : property === 'color' ? /^#[\da-f]{3,8}$/i.test(value) : true };
  const ResizeObserver = Observer('resize'), IntersectionObserver = Observer('intersection');
  Object.assign(window, { CSS, ResizeObserver }); if (io) window.IntersectionObserver = IntersectionObserver;
  vm.runInNewContext(source, {
    window, document, URL, CSS, matchMedia: () => media,
    getComputedStyle: () => ({ top: '88px' }),
    requestAnimationFrame: callback => { const id = ++next; pending.set(id, callback); return id; },
    cancelAnimationFrame: id => pending.delete(id),
    MutationObserver: Observer('mutation'), ResizeObserver, IntersectionObserver,
  });
  const instance = new window.VeyroHelixShowcase(root, demos);
  const flush = () => { const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(16)); };
  return {
    window, document, root, track, pin, stage, depthLayer, title, category, description, counter, open, media, observers, instance, initial,
    get frames() { return pending.size; },
    get layoutReads() { return layoutReads; },
    get planes() { return stage.querySelectorAll('.project-gallery__plane'); },
    flush,
    progress(value) { window.scrollY = absoluteTop - instance.stickyTop + instance.range * value; window.emit('scroll'); flush(); },
    pause(value) { body.classList[value ? 'add' : 'remove']('effects-paused'); observers.mutation.forEach(observer => observer.callback([])); flush(); },
    reduce(value) { media.matches = value; media.emit('change'); flush(); },
    focus(element, { keyboard = true, flushFrame = true } = {}) {
      document.activeElement.focusVisible = false; document.activeElement = element; element.focusVisible = keyboard;
      root.emit('focusin', { target: element }); if (flushFrame) flush();
    },
    blur() { document.activeElement.focusVisible = false; document.activeElement = body; root.emit('focusout', { relatedTarget: body }); flush(); },
    intersect(value) { observers.intersection.forEach(observer => observer.callback([{ isIntersecting: value }])); flush(); },
  };
}

const geometry = state => state.planes.map(plane => Object.fromEntries(properties.map(property => [property, plane.style.getPropertyValue(property)])));
const visible = state => state.planes.filter(plane => plane.style.visibility === 'visible');
function expectActive(state, index) {
  expect(state.root.dataset.activeDemo).toBe(String(index));
  state.planes.forEach((plane, other) => {
    expect(plane.tabIndex).toBe(other === index ? 0 : -1);
    expect(plane.inert).toBe(other !== index);
    expect(plane.getAttribute('aria-hidden')).toBe(String(other !== index));
    expect(plane.getAttribute('data-gallery-active')).toBe(String(other === index));
    expect(plane.style.pointerEvents).toBe(other === index ? 'auto' : 'none');
  });
  expect(state.title.textContent).toBe(state.instance.demos[index].title);
  expect(state.category.textContent).toBe(state.instance.demos[index].category);
  expect(state.description.textContent).toBe(state.instance.demos[index].description);
  expect(state.open.getAttribute('href')).toBe(state.instance.demos[index].url);
  expect(state.counter.textContent).toBe(`${String(index + 1).padStart(2, '0')} / ${String(state.planes.length).padStart(2, '0')}`);
}

function expectCentered(state, index) {
  expectActive(state, index);
  expect(visible(state)).toEqual([state.planes[index]]);
  for (const property of ['--x', '--y', '--z', '--rotate-y']) expect(parseFloat(state.planes[index].style.getPropertyValue(property))).toBe(0);
}

describe('Native-scroll helix showcase', () => {
  it.each([2, 3, 5])('passes each of %i projects face-on, with metadata and native current link', count => {
    const state = fixture({ count });
    expect(state.root.classList.contains('is-helix-ready')).toBe(true);
    expect(state.frames).toBe(0);
    for (let index = 0; index < count; index++) {
      state.progress(index / (count - 1));
      expectCentered(state, index);
      expect(state.frames).toBe(0);
    }
  });

  it.each([2, 3, 5])('keeps all %i projects moving through every scroll increment without a center hold', count => {
    const state = fixture({ count });
    const sample = () => state.planes.map(plane => ({
      angle: parseFloat(plane.style.getPropertyValue('--rotate-y')),
      y: parseFloat(plane.style.getPropertyValue('--y')),
    }));
    state.progress(0);
    let previous = sample();
    // Dense samples include the exact centers and both ends of the old holds.
    for (let tick = 1; tick <= 400; tick++) {
      state.progress(tick / 400);
      const current = sample();
      current.forEach((plane, index) => {
        expect(plane.angle).toBeLessThan(previous[index].angle);
        expect(plane.y).toBeGreaterThan(previous[index].y);
      });
      const active = Number(state.root.dataset.activeDemo);
      expectActive(state, active);
      expect(state.planes[active].style.visibility).toBe('visible');
      expect(state.frames).toBe(0);
      previous = current;
    }
    // Traversal uses one viewport step per adjacent pair, with no extra hold step.
    expect(state.instance.range).toBe((count - 1) * (state.window.innerHeight - state.instance.stickyTop));
    const last = geometry(state);
    state.progress(1.1); expect(geometry(state)).toEqual(last);
    state.progress(0); const first = geometry(state);
    state.progress(-.1); expect(geometry(state)).toEqual(first);
  });

  it.each([2, 3, 5])('carries %i homepage projects through both sticky boundaries without freezing', count => {
    const state = fixture({ count, homepage: true });
    const scene = () => ['--gallery-depth-y', '--gallery-light-y'].map(property => parseFloat(state.root.style.getPropertyValue(property)));
    // Sample native scrolling on either side of entry and release, not just
    // inside the pinned interval. No scroll step may repeat its geometry.
    for (const boundary of [0, 1]) {
      const index = boundary === 0 ? 0 : count - 1;
      const samples = [];
      let previous = null;
      for (let step = -10; step <= 10; step++) {
        const progress = boundary + step / 100;
        state.progress(progress);
        expectActive(state, index);
        const current = geometry(state), background = scene();
        expect(state.root.dataset.galleryProgress).toBe(Math.max(0, Math.min(1, progress)).toFixed(4));
        expect(state.planes[index].style.visibility).toBe('visible');
        if (previous) {
          expect(parseFloat(current[index]['--rotate-y'])).toBeLessThan(parseFloat(previous.geometry[index]['--rotate-y']));
          expect(parseFloat(current[index]['--y'])).toBeGreaterThan(parseFloat(previous.geometry[index]['--y']));
          expect(background[0]).toBeLessThan(previous.background[0]);
          expect(background[1]).toBeLessThan(previous.background[1]);
        }
        samples.push({ progress, geometry: current, background });
        previous = samples.at(-1);
        expect(state.frames).toBe(0);
      }
      for (const sample of samples.reverse()) {
        state.progress(sample.progress);
        expect(geometry(state)).toEqual(sample.geometry);
        expect(scene()).toEqual(sample.background);
        expectActive(state, index);
      }
    }
  });

  it.each([0, 1])('joins native sticky motion with continuous velocity at homepage boundary %i', boundary => {
    const state = fixture({ homepage: true });
    const bridge = Math.min(160, state.instance.pinHeight * .22);
    const samples = [];
    const pinPosition = distance => {
      state.progress(boundary + distance / state.instance.range);
      const correction = parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'));
      const native = boundary === 0 ? -Math.min(distance, 0) : -Math.max(distance, 0);
      expect(Math.abs(correction)).toBeLessThanOrEqual(bridge / 4 + .001);
      expect(state.frames).toBe(0);
      return { correction, position: native + correction };
    };
    // One-pixel samples catch a velocity discontinuity at the exact sticky
    // boundary and where the bridge rejoins ordinary document scrolling.
    for (let distance = -Math.ceil(bridge) - 2; distance <= Math.ceil(bridge) + 2; distance++) {
      const current = pinPosition(distance);
      samples.push({ distance, ...current });
    }
    const velocities = samples.slice(1).map((sample, index) => sample.position - samples[index].position);
    velocities.forEach(velocity => {
      expect(velocity).toBeGreaterThanOrEqual(-1.001);
      expect(velocity).toBeLessThanOrEqual(.001);
    });
    velocities.slice(1).forEach((velocity, index) => expect(Math.abs(velocity - velocities[index])).toBeLessThan(.007));
    const minus = pinPosition(-1).position, center = pinPosition(0).position, plus = pinPosition(1).position;
    expect(center - minus).toBeCloseTo(-.5, 2);
    expect(plus - center).toBeCloseTo(-.5, 2);
    expect(Math.abs(pinPosition(0).correction)).toBeCloseTo(bridge / 4, 3);
    for (const endpoint of [-bridge, bridge]) {
      expect(pinPosition(endpoint).correction).toBe(0);
      const before = pinPosition(endpoint - 1).position;
      const middle = pinPosition(endpoint).position;
      const after = pinPosition(endpoint + 1).position;
      expect(Math.abs((after - middle) - (middle - before))).toBeLessThan(.004);
    }
    for (const sample of samples.reverse()) expect(pinPosition(sample.distance)).toEqual({ correction: sample.correction, position: sample.position });
  });

  it('removes the sticky bridge for reduced motion, pause and component teardown', () => {
    const state = fixture({ homepage: true });
    state.progress(1);
    expect(parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'))).toBeLessThan(0);
    state.reduce(true);
    expect(parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'))).toBe(0);
    state.reduce(false);
    expect(parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'))).toBeLessThan(0);
    state.pause(true);
    expect(parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'))).toBe(0);
    state.pause(false);
    state.progress(0);
    expect(parseFloat(state.root.style.getPropertyValue('--gallery-pin-y'))).toBeGreaterThan(0);
    state.instance.destroy();
    expect(state.root.style.getPropertyValue('--gallery-pin-y')).toBe('');
    expect(state.frames).toBe(0);
    const standalone = fixture();
    standalone.progress(0);
    expect(parseFloat(standalone.root.style.getPropertyValue('--gallery-pin-y'))).toBe(0);
  });

  it('bounds homepage travel and keeps valid destinations beyond either end', () => {
    const state = fixture({ homepage: true });
    for (const [progress, index] of [[-5, 0], [5, 2]]) {
      state.progress(progress);
      expectActive(state, index);
      expect(Math.abs(parseFloat(state.planes[index].style.getPropertyValue('--rotate-y')))).toBeCloseTo(.78 * 96);
      expect(visible(state)).toHaveLength(0);
      expect(state.open.emit('click').defaultPrevented).toBe(false);
      expect(state.frames).toBe(0);
    }
    const single = fixture({ homepage: true, count: 1 });
    for (const progress of [-1, 0, 1, 2]) { single.progress(progress); expectCentered(single, 0); }
  });

  it.each(['preview', 'current-link'])('protects a homepage %s pointer press as the sticky scene releases', target => {
    const state = fixture({ homepage: true, width: 390, height: 844, pinHeight: 740 });
    state.progress(1.08);
    const element = target === 'preview' ? state.planes[2] : state.open;
    const before = geometry(state), href = element.href;
    state.window.emit('scroll');
    state.focus(element, { keyboard: false, flushFrame: false });
    state.flush();
    expect(geometry(state)).toEqual(before);
    state.progress(1.14);
    expect(geometry(state)).toEqual(before);
    expectActive(state, 2);
    expect(element.href).toBe(href);
    expect(element.emit('click').defaultPrevented).toBe(false);
    state.blur();
    expect(geometry(state)).not.toEqual(before);
    expect(state.frames).toBe(0);
  });

  it.each([{ reduced: true }, { paused: true }, { motion: false }, { depth: false }])('keeps homepage boundary movement static when effects are disabled: %j', options => {
    const state = fixture({ homepage: true, ...options });
    state.progress(0); const first = geometry(state);
    state.progress(-.1); expect(geometry(state)).toEqual(first); expectActive(state, 0);
    state.progress(1); const last = geometry(state);
    state.progress(1.1); expect(geometry(state)).toEqual(last); expectActive(state, 2);
    expect(state.root.style.getPropertyValue('--gallery-depth-y')).toBe('0.00px');
    expect(state.root.style.getPropertyValue('--gallery-light-y')).toBe('0.00px');
    expect(state.frames).toBe(0);
  });

  it('shows at most two planes throughout transitions and reverses exactly with scroll', () => {
    const state = fixture({ count: 5 });
    const samples = [];
    for (let step = 0; step <= 100; step++) {
      state.progress(step / 100);
      expect(visible(state).length).toBeGreaterThan(0);
      expect(visible(state).length).toBeLessThanOrEqual(2);
      for (const plane of geometry(state)) for (const value of Object.values(plane)) expect(Number.isFinite(parseFloat(value))).toBe(true);
      samples.push({ geometry: geometry(state), index: state.root.dataset.activeDemo, href: state.open.href });
    }
    for (let step = 100; step >= 0; step--) {
      state.progress(step / 100);
      expect({ geometry: geometry(state), index: state.root.dataset.activeDemo, href: state.open.href }).toEqual(samples[step]);
    }
    state.progress(1 / 8);
    expect(visible(state)).toHaveLength(2);
    expectActive(state, 1);
    expect(state.planes[1].emit('click').defaultPrevented).toBe(false);
    expect(state.open.emit('click').defaultPrevented).toBe(false);
    expect(state.planes.filter(plane => !plane.inert)).toEqual([state.planes[1]]);
  });


  it('moves the environment alongside the previews and reverses exactly with native scroll', () => {
    const state = fixture();
    const scene = () => ['--gallery-depth-y', '--gallery-light-y'].map(property => parseFloat(state.root.style.getPropertyValue(property)));
    state.progress(.05); expectActive(state, 0); const start = scene();
    state.progress(.2); expectActive(state, 0); const later = scene();
    expect(later[0]).toBeLessThan(start[0]); expect(later[1]).toBeLessThan(start[1]);
    expect(state.frames).toBe(0);
    state.progress(.8); expectActive(state, 2);
    state.progress(.2); expect(scene()).toEqual(later);
    state.progress(.05); expect(scene()).toEqual(start);
    // Keyboard focus protects the destination without freezing document depth.
    state.focus(state.open); state.progress(.8); expectCentered(state, 0);
    expect(scene()[0]).toBeLessThan(later[0]);
  });

  it('stops both environment layers for reduced motion and paused effects', () => {
    const state = fixture();
    const scene = () => ['--gallery-depth-y', '--gallery-light-y'].map(property => parseFloat(state.root.style.getPropertyValue(property)));
    state.progress(.7); expect(scene()).not.toEqual([0, 0]);
    state.reduce(true); expect(scene()).toEqual([0, 0]);
    state.progress(.2); expect(scene()).toEqual([0, 0]);
    state.reduce(false); expect(scene()).not.toEqual([0, 0]);
    state.pause(true); expect(scene()).toEqual([0, 0]);
    state.progress(.8); expect(scene()).toEqual([0, 0]);
    state.pause(false); expect(scene()).not.toEqual([0, 0]);
  });

  it('keeps decorative depth markers in sync with accepted demos and cleans them on destroy', () => {
    const state = fixture({ count: 5 });
    expect(state.depthLayer.getAttribute('aria-hidden')).toBe('true');
    expect(state.depthLayer.children.map(mark => mark.textContent)).toEqual(['01', '02', '03', '04', '05']);
    expect(state.depthLayer.children.map(mark => mark.style.getPropertyValue('--depth-index'))).toEqual(['0', '1', '2', '3', '4']);
    state.instance.setDemos([demo(0), { ...demo(1), url: 'javascript:bad()' }]);
    expect(state.depthLayer.children.map(mark => mark.textContent)).toEqual(['01']);
    state.instance.setDemos([]); expect(state.depthLayer.children).toHaveLength(0);
    state.instance.setDemos([demo(0), demo(1)]); expect(state.depthLayer.children).toHaveLength(2);
    state.instance.destroy(); expect(state.depthLayer.children).toHaveLength(0);
    for (const property of ['--gallery-depth-step', '--gallery-depth-y', '--gallery-light-y']) expect(state.root.style.getPropertyValue(property)).toBe('');
  });

  it('supports the reusable component without a decorative background container', () => {
    const state = fixture({ withDepth: false });
    state.progress(.5); expectCentered(state, 1);
    expect(state.instance.depthMarks).toEqual([]);
    expect(Number.isFinite(parseFloat(state.root.style.getPropertyValue('--gallery-depth-y')))).toBe(true);
    state.instance.destroy(); expect(state.frames).toBe(0);
  });

  it('coalesces scroll into one dirty frame and never starts an idle animation loop', () => {
    const state = fixture();
    expect(state.frames).toBe(0);
    const reads = state.layoutReads;
    for (let i = 0; i < 50; i++) {
      const event = state.window.emit('scroll');
      expect(event.defaultPrevented).toBe(false);
    }
    expect(state.frames).toBe(1);
    expect(state.layoutReads).toBe(reads);
    state.flush();
    expect(state.layoutReads).toBe(reads + 1);
    expect(state.frames).toBe(0);
    state.flush();
    expect(state.layoutReads).toBe(reads + 1);
    const scroll = state.window.listeners.get('scroll');
    expect(scroll[0].options.passive).toBe(true);
    for (const target of [state.window, state.root, state.stage]) {
      for (const event of ['wheel', 'touchmove', 'pointerdown', 'pointermove', 'keydown', 'click']) expect(target.listeners.get(event) || []).toHaveLength(0);
    }
  });

  it('changes to a simple reduced mode for pause/reduced motion while native scroll still works', () => {
    const state = fixture();
    state.reduce(true);
    state.progress(.5);
    expect(state.root.dataset.galleryMode).toBe('reduced');
    expectCentered(state, 1);
    for (const plane of state.planes) for (const property of ['--x', '--y', '--z', '--rotate-y']) expect(parseFloat(plane.style.getPropertyValue(property))).toBe(0);
    state.reduce(false);
    expect(state.root.dataset.galleryMode).toBe('3d');
    state.pause(true);
    state.progress(5 / 6);
    expect(state.root.dataset.galleryMode).toBe('reduced');
    expectActive(state, 2);
    expect(visible(state)).toHaveLength(2);
    state.pause(false);
    expect(state.root.dataset.galleryMode).toBe('3d');
    expect(state.frames).toBe(0);
  });

  it.each([{ reduced: true }, { paused: true }, { motion: false }, { depth: false }])('supports a static transform mode from first load: %j', options => {
    const state = fixture(options);
    state.progress(.5);
    expect(state.root.dataset.galleryMode).toBe('reduced');
    expectCentered(state, 1);
  });

  it('locks the focused current link until focus leaves so its target never changes under the keyboard', () => {
    const state = fixture();
    state.progress(1 / 6);
    state.focus(state.open);
    const href = state.open.href;
    state.progress(5 / 6);
    expectCentered(state, 0);
    expect(state.open.href).toBe(href);
    expect(state.root.dataset.galleryFocusLocked).toBe('true');
    expect(state.document.activeElement).toBe(state.open);
    expect(state.open.emit('click').defaultPrevented).toBe(false);
    state.blur();
    expectActive(state, 2);
    expect(parseFloat(state.planes[2].style.getPropertyValue('--rotate-y'))).not.toBe(0);
    expect(state.root.dataset.galleryFocusLocked).toBe('false');
  });

  it.each(['preview', 'current-link'])('keeps the moving %s under a pointer press until its native click completes', target => {
    const state = fixture({ width: 390, height: 844, pinHeight: 740 });
    state.progress(.2645);
    expectActive(state, 1);
    const element = target === 'preview' ? state.planes[1] : state.open;
    const before = geometry(state), href = element.href;
    expect(parseFloat(before[1]['--rotate-y'])).not.toBe(0);
    // A scroll paint can already be queued when pointerdown moves native focus.
    state.window.emit('scroll');
    state.focus(element, { keyboard: false, flushFrame: false });
    expect(state.frames).toBe(1);
    expect(geometry(state)).toEqual(before);
    state.flush();
    expect(geometry(state)).toEqual(before);
    expectActive(state, 1);
    // Even a further queued scroll before pointerup must not move the target.
    state.progress(.3);
    expect(geometry(state)).toEqual(before);
    expect(element.href).toBe(href);
    expect(element.emit('click').defaultPrevented).toBe(false);
    expect(state.document.activeElement).toBe(element);
    state.blur();
    expect(geometry(state)).not.toEqual(before);
    expect(state.root.dataset.galleryFocusLocked).toBe('false');
    expect(state.frames).toBe(0);
  });

  it('keeps a focused plane centered, focusable and linked through scroll', () => {
    const state = fixture();
    state.progress(.5);
    state.focus(state.planes[1]);
    state.progress(0);
    expectCentered(state, 1);
    expect(state.document.activeElement).toBe(state.planes[1]);
    expect(state.planes[1].emit('click').defaultPrevented).toBe(false);
    state.blur();
    expectCentered(state, 0);
  });

  it.each([{ demos: [] }, { demos: [demo(0)] }])('handles empty and single-demo arrays without invalid geometry: %j', ({ demos }) => {
    const state = fixture({ demos });
    expect(state.planes).toHaveLength(demos.length);
    expect(state.frames).toBe(0);
    if (!demos.length) expect(state.root.classList.contains('is-helix-ready')).toBe(false);
    else for (const progress of [0, .5, 1]) { state.progress(progress); expectCentered(state, 0); }
  });

  it('creates configurable cards safely and rejects executable URL schemes', () => {
    const unsafeTitle = '<img src=x onerror=alert(1)>';
    const state = fixture({ demos: [
      { ...demo(0), title: unsafeTitle },
      { ...demo(1), url: 'javascript:alert(1)' },
      { ...demo(2), previewImage: 'data:text/html,bad' },
    ] });
    expect(state.planes).toHaveLength(1);
    expect(state.planes[0].querySelector('figcaption > span').textContent).toBe(unsafeTitle);
    expect(state.planes[0].querySelectorAll('img')).toHaveLength(1);
    state.progress(.5);
    expectCentered(state, 0);
  });

  it('does not replace a focused control when the demo collection is updated', () => {
    const state = fixture();
    state.progress(.5);
    state.focus(state.open);
    state.instance.setDemos([demo(7)]);
    expect(state.planes).toHaveLength(3);
    expect(state.open.href).toBe('/demo/project-2/');
    state.blur();
    state.instance.setDemos([demo(7)]);
    expect(state.planes).toHaveLength(1);
    state.progress(.5);
    expectCentered(state, 0);
    expect(state.open.href).toBe('/demo/project-8/');
  });

  it.each([{ height: 500, pinHeight: 400 }, { height: 900, pinHeight: 900 }, { sticky: false }])('restores the ordinary link grid when sticky layout cannot fit: %j', options => {
    const state = fixture(options);
    expect(state.root.classList.contains('is-helix-ready')).toBe(false);
    expect(state.root.style.getPropertyValue('--gallery-scroll-height')).toBe('');
    for (const plane of state.planes) {
      expect(plane.inert).toBe(false);
      expect(plane.tabIndex).toBe(0);
      expect(plane.getAttribute('aria-hidden')).toBeNull();
      expect(plane.getAttribute('data-gallery-active')).toBeNull();
      expect(plane.style.visibility).toBe('');
    }
  });

  it('cancels pending work while hidden/offscreen or in BFCache and resumes with one dirty frame', () => {
    const state = fixture();
    state.window.emit('scroll'); expect(state.frames).toBe(1);
    state.document.hidden = true; state.document.emit('visibilitychange'); expect(state.frames).toBe(0);
    state.window.emit('scroll'); expect(state.frames).toBe(0);
    state.document.hidden = false; state.document.emit('visibilitychange'); state.flush(); expect(state.frames).toBe(0);
    state.intersect(false); state.window.emit('scroll'); expect(state.frames).toBe(0);
    state.intersect(true); expect(state.frames).toBe(0);
    state.window.emit('pagehide'); state.window.emit('scroll'); expect(state.frames).toBe(0);
    state.window.emit('pageshow', { persisted: true }); expect(state.frames).toBe(1); state.flush(); expect(state.frames).toBe(0);
  });

  it('detects entry through native scroll when IntersectionObserver is unavailable', () => {
    const state = fixture({ io: false, absoluteTop: 3000 });
    expect(state.frames).toBe(0);
    state.window.scrollY = 3000;
    state.window.emit('scroll');
    expect(state.frames).toBe(1);
    state.flush();
    expect(state.root.dataset.activeDemo).toBe('0');
    expect(state.frames).toBe(0);
  });

  it('reuses an existing instance and restores links/styles when destroyed', () => {
    const state = fixture();
    const listenerCount = state.window.listenerCount();
    expect(new state.window.VeyroHelixShowcase(state.root)).toBe(state.instance);
    expect(state.window.listenerCount()).toBe(listenerCount);
    state.progress(.5);
    state.window.emit('scroll');
    state.instance.destroy();
    expect(state.frames).toBe(0);
    expect(state.window.listenerCount()).toBe(0);
    expect(state.root.listenerCount()).toBe(0);
    expect(state.root.classList.contains('is-helix-ready')).toBe(false);
    for (const plane of state.planes) { expect(plane.inert).toBe(false); expect(plane.tabIndex).toBe(0); expect(plane.style.getPropertyValue('--x')).toBe(''); }
    expect(state.observers.mutation.every(observer => observer.disconnected)).toBe(true);
    state.window.emit('scroll'); expect(state.frames).toBe(0);
  });
});
