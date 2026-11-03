import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snippet = readFileSync(new URL('../site/theme/snippets/entrance-bootstrap.liquid', import.meta.url), 'utf8');
const source = snippet.match(/<script>([\s\S]*?)<\/script>/)[1];

// Only the inline bootstrap runs here: external motion code, fonts and images
// deliberately never arrive. Native rendering and the hero canvas are checked separately.
function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) {
      for (const callback of [...(listeners.get(event.type) ?? [])]) callback(event);
      return !event.defaultPrevented;
    },
    listenerCount() { return [...listeners.values()].reduce((count, set) => count + set.size, 0); },
  };
}

function fixture({ paused = false, reduced = false, hash = '', navigation = 'navigate', referrer = '', blockedStorage = false, bodyPaused = false, cancelOnStart = false } = {}) {
  const initialTime = Date.now();
  const root = { dataset: {} };
  let savedPause = paused;
  let cachedBodyPaused = bodyPaused;
  let announcements = 0;
  let starts = 0;
  let removals = 0;
  let hiddenFlushes = 0;
  const overlay = { remove() { removals++; }, get offsetWidth() { hiddenFlushes++; return 0; } };
  const document = Object.assign(eventTarget(), {
    documentElement: root, referrer,
    body: { classList: { contains: name => name === 'effects-paused' && cachedBodyPaused } },
    querySelector(selector) {
      expect(selector).toBe('[data-site-entrance]');
      return overlay;
    },
  });
  const window = Object.assign(eventTarget(), {
    scrollY: hash ? 1400 : 0,
    scrollTo() { throw new Error('The entrance must not move the visitor or their hash target'); },
  });
  const media = Object.assign(eventTarget(), { matches: reduced });
  window.addEventListener('veyro:entrance-reveal', () => announcements++);
  window.addEventListener('veyro:entrance-start', () => {
    starts++;
    if (cancelOnStart) window.VeyroEntrance.finish();
  });
  const location = new URL('https://veyro.dk/' + hash);
  vm.runInNewContext(source, {
    window, document, location, URL, Event,
    matchMedia(query) {
      expect(query).toBe('(prefers-reduced-motion: reduce)');
      return media;
    },
    performance: {
      now: () => Date.now() - initialTime + 50,
      getEntriesByType: () => navigation === null ? [] : [{ type: navigation }],
    },
    sessionStorage: {
      getItem(key) {
        expect(key).toBe('veyro-effects-paused');
        if (blockedStorage) throw new Error('Storage unavailable');
        return savedPause ? 'true' : 'false';
      },
    },
    setTimeout, clearTimeout,
  });
  return {
    root, document, window, media, overlay,
    get announcements() { return announcements; },
    get starts() { return starts; },
    get removals() { return removals; },
    get hiddenFlushes() { return hiddenFlushes; },
    get api() { return window.VeyroEntrance; },
    setPause(value) { savedPause = value; },
    setBodyPause(value) { cachedBodyPaused = value; },
    emit(target, type, properties = {}) {
      const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
      target.dispatchEvent(event);
      return event;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function expectIdle(state, announcements = state.announcements) {
  expect(state.root.dataset.entrance).toBeUndefined();
  expect(state.api.revealAt).toBe(0);
  expect(state.removals).toBe(0);
  expect(state.announcements).toBe(announcements);
  expect(vi.getTimerCount()).toBe(0);
  expect(state.document.listenerCount()).toBe(0);
  expect(state.media.listenerCount()).toBe(1);
  // Four lifecycle hooks and the two test observers persist for future visits.
  expect(state.window.listenerCount()).toBe(6);
}

function expectOpening(state, starts = 1) {
  expect(state.root.dataset.entrance).toBe('opening');
  expect(state.starts).toBe(starts);
  expect(state.document.listenerCount()).toBe(5);
  expect(vi.getTimerCount()).toBe(2);
}

describe('Homepage entrance on every document visit', () => {
  it('reveals after 900 ms and cleans itself up after 2050 ms without waiting for assets', () => {
    const state = fixture();
    expectOpening(state);
    expect(state.api.revealAt).toBe(950);
    vi.advanceTimersByTime(899);
    expect(state.root.dataset.entrance).toBe('opening');
    expect(state.announcements).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.root.dataset.entrance).toBe('revealing');
    expect(state.announcements).toBe(1);
    vi.advanceTimersByTime(1149);
    expect(state.root.dataset.entrance).toBe('revealing');
    vi.advanceTimersByTime(1);
    expectIdle(state, 2);
    vi.advanceTimersByTime(10_000);
    state.api.finish();
    expectIdle(state, 2);
  });

  it.each([
    ['ordinary external visit', { referrer: 'https://example.com/' }],
    ['internal logo/home navigation', { referrer: 'https://veyro.dk/pages/priser' }],
    ['internal navigation without a timing entry', { referrer: 'https://veyro.dk/en/', navigation: null }],
    ['reload', { navigation: 'reload', referrer: 'https://veyro.dk/' }],
    ['back/forward without BFCache', { navigation: 'back_forward' }],
    ['fresh document with a section target', { hash: '#priser' }],
    ['malformed referrer', { referrer: 'not a valid URL' }],
    ['blocked session storage', { blockedStorage: true }],
  ])('plays on %s', (_, options) => {
    const state = fixture(options);
    expectOpening(state);
    vi.advanceTimersByTime(2050);
    expectIdle(state, 2);
  });

  it.each([{ paused: true }, { reduced: true }, { blockedStorage: true, bodyPaused: true }])('respects existing accessibility preferences: %j', options => {
    const state = fixture(options);
    expectIdle(state, 0);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectIdle(state, 0);
    expect(state.starts).toBe(0);
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin'])('releases on %s without consuming the input', type => {
    const state = fixture();
    vi.advanceTimersByTime(100);
    const event = state.emit(state.document, type);
    expect(event.defaultPrevented).toBe(false);
    expectIdle(state, 1);
    state.emit(state.document, type);
    state.api.finish();
    vi.advanceTimersByTime(5000);
    expectIdle(state, 1);
  });

  it('keeps fresh hash navigation and automatic scroll restoration intact', () => {
    const state = fixture({ hash: '#priser' });
    state.emit(state.window, 'scroll');
    expectOpening(state);
    expect(state.window.scrollY).toBe(1400);
    vi.advanceTimersByTime(2050);
    expectIdle(state, 2);
    expect(state.window.scrollY).toBe(1400);
  });

  it('does not replay on same-document section navigation', () => {
    const state = fixture();
    vi.advanceTimersByTime(2050);
    state.emit(state.window, 'hashchange');
    state.emit(state.window, 'scroll');
    expectIdle(state, 2);
    expect(state.starts).toBe(1);
  });

  it.each(['hashchange', 'pagehide', 'beforeprint'])('finishes an active visit on %s and resets the future V start time', type => {
    const state = fixture();
    vi.advanceTimersByTime(100);
    state.emit(state.window, type);
    expectIdle(state, 1);
    vi.advanceTimersByTime(5000);
    expectIdle(state, 1);
  });

  it('does not restart for ordinary pageshow, but replays on a restored homepage', () => {
    const state = fixture();
    vi.advanceTimersByTime(300);
    state.emit(state.window, 'pageshow', { persisted: false });
    expect(state.api.revealAt).toBe(950);
    expectOpening(state);
    state.emit(state.window, 'pagehide');
    expectIdle(state, 1);
    vi.advanceTimersByTime(4000);
    state.window.scrollY = 700;
    state.emit(state.window, 'pageshow', { persisted: true });
    expectOpening(state, 2);
    expect(state.api.revealAt).toBe(5250);
    expect(state.window.scrollY).toBe(700);
    state.emit(state.window, 'scroll');
    expectOpening(state, 2);
    vi.advanceTimersByTime(2050);
    expectIdle(state, 3);
  });

  it('reuses one overlay and bounded listeners/timers through repeated BFCache visits', () => {
    const state = fixture();
    vi.advanceTimersByTime(2050);
    const overlay = state.overlay;
    for (let visit = 2; visit <= 8; visit++) {
      state.emit(state.window, 'pagehide');
      state.emit(state.window, 'pageshow', { persisted: true });
      expectOpening(state, visit);
      const revealAt = state.api.revealAt;
      state.emit(state.window, 'pageshow', { persisted: true });
      expect(state.api.revealAt).toBe(revealAt);
      expectOpening(state, visit);
      vi.advanceTimersByTime(2050);
      expectIdle(state, visit * 2);
      expect(state.overlay).toBe(overlay);
    }
    expect(state.hiddenFlushes).toBe(8);
  });

  it('checks a changed saved pause choice on each restored visit', () => {
    const state = fixture();
    state.emit(state.window, 'pagehide');
    state.setPause(true);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectIdle(state, 1);
    state.setPause(false);
    // Cached body state from the old page must not override current accessible storage.
    state.setBodyPause(true);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectOpening(state, 2);
  });

  it('respects a preference change during playback and can play on a later eligible visit', () => {
    const state = fixture();
    vi.advanceTimersByTime(200);
    state.media.matches = true;
    state.emit(state.media, 'change');
    expectIdle(state, 1);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectIdle(state, 1);
    state.media.matches = false;
    state.emit(state.media, 'change');
    expectIdle(state, 1);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectOpening(state, 2);
  });

  it('finishes safely if the motion layer synchronously opts out on entrance start', () => {
    const state = fixture({ cancelOnStart: true });
    expectIdle(state, 1);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectIdle(state, 2);
  });

  it('exposes an idempotent finish hook during either entrance phase', () => {
    const state = fixture();
    vi.advanceTimersByTime(1000);
    expect(state.root.dataset.entrance).toBe('revealing');
    state.api.finish();
    state.api.finish();
    expectIdle(state, 2);
    vi.advanceTimersByTime(5000);
    expectIdle(state, 2);
  });
});
