import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const snippet = readFileSync(new URL('../site/theme/snippets/entrance-bootstrap.liquid', import.meta.url), 'utf8');
const source = snippet.match(/<script>([\s\S]*?)<\/script>/)[1];

// Only the inline bootstrap runs here: external motion code, fonts and images
// deliberately never arrive. Native rendering of the overlay is checked in-browser.
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

function fixture({ paused = false, reduced = false, hash = '', navigation = 'navigate', referrer = '', blockedStorage = false } = {}) {
  const initialTime = Date.now();
  const root = { dataset: {} };
  let removals = 0;
  let announcements = 0;
  const document = Object.assign(eventTarget(), {
    documentElement: root,
    referrer,
    querySelector(selector) {
      expect(selector).toBe('[data-site-entrance]');
      return removals ? null : { remove() { removals++; } };
    },
  });
  const window = eventTarget();
  const media = Object.assign(eventTarget(), { matches: reduced });
  window.addEventListener('veyro:entrance-reveal', () => announcements++);
  const location = new URL('https://veyro.dk/' + hash);
  const sandbox = {
    window, document, location, URL, Event,
    matchMedia(query) {
      expect(query).toBe('(prefers-reduced-motion: reduce)');
      return media;
    },
    performance: {
      now: () => Date.now() - initialTime + 50,
      getEntriesByType(type) {
        expect(type).toBe('navigation');
        return navigation === null ? [] : [{ type: navigation }];
      },
    },
    sessionStorage: {
      getItem(key) {
        expect(key).toBe('veyro-effects-paused');
        if (blockedStorage) throw new Error('Storage unavailable');
        return paused ? 'true' : null;
      },
    },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, sandbox);
  return {
    root, document, window, media,
    get removals() { return removals; },
    get announcements() { return announcements; },
    get api() { return window.VeyroEntrance; },
    emit(target, type, properties = {}) {
      const event = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...properties };
      target.dispatchEvent(event);
      return event;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function expectFinished(state, announcements = 1) {
  expect(state.root.dataset.entrance).toBeUndefined();
  expect(state.api.revealAt).toBe(0);
  expect(state.removals).toBe(1);
  expect(state.announcements).toBe(announcements);
  expect(vi.getTimerCount()).toBe(0);
  expect(state.document.listenerCount()).toBe(0);
  expect(state.media.listenerCount()).toBe(0);
  // The test observer is the sole remaining listener on window.
  expect(state.window.listenerCount()).toBe(1);
}

describe('Opening entrance bootstrap without external motion code', () => {
  it('reveals after 900 ms and cleans itself up after 2050 ms without waiting for assets', () => {
    const state = fixture();
    expect(state.root.dataset.entrance).toBe('opening');
    expect(state.api.revealAt).toBe(950);
    expect(state.announcements).toBe(0);
    vi.advanceTimersByTime(899);
    expect(state.root.dataset.entrance).toBe('opening');
    expect(state.removals).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.root.dataset.entrance).toBe('revealing');
    expect(state.announcements).toBe(1);
    expect(state.api.revealAt).toBe(950);
    vi.advanceTimersByTime(1149);
    expect(state.root.dataset.entrance).toBe('revealing');
    vi.advanceTimersByTime(1);
    expectFinished(state, 2);
    vi.advanceTimersByTime(10_000);
    state.api.finish();
    expectFinished(state, 2);
  });

  it.each([
    ['saved pause choice', { paused: true }],
    ['reduced motion', { reduced: true }],
    ['initial hash target', { hash: '#priser' }],
    ['browser back/forward navigation', { navigation: 'back_forward' }],
    ['same-origin document navigation', { referrer: 'https://veyro.dk/pages/priser' }],
    ['same-origin navigation without a timing entry', { referrer: 'https://veyro.dk/en/', navigation: null }],
  ])('does not arm for %s', (_, options) => {
    const state = fixture(options);
    expect(state.root.dataset.entrance).toBeUndefined();
    expect(state.api).toBeUndefined();
    expect(state.document.listenerCount()).toBe(0);
    expect(state.media.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(state.announcements).toBe(0);
  });

  it('allows an intentional reload even with a same-origin referrer', () => {
    const state = fixture({ navigation: 'reload', referrer: 'https://veyro.dk/' });
    expect(state.root.dataset.entrance).toBe('opening');
    vi.advanceTimersByTime(2050);
    expectFinished(state, 2);
  });

  it.each([
    ['external referrer', { referrer: 'https://example.com/' }],
    ['unparseable referrer', { referrer: 'not a valid URL' }],
    ['missing navigation timing', { navigation: null }],
    ['blocked session storage', { blockedStorage: true }],
  ])('finishes safely with %s', (_, options) => {
    const state = fixture(options);
    expect(state.root.dataset.entrance).toBe('opening');
    vi.advanceTimersByTime(2050);
    expectFinished(state, 2);
  });

  it.each(['pointerdown', 'keydown', 'wheel', 'touchstart', 'focusin'])('releases immediately on %s without consuming the input', type => {
    const state = fixture();
    vi.advanceTimersByTime(100);
    const event = state.emit(state.document, type);
    expect(event.defaultPrevented).toBe(false);
    expectFinished(state);
    state.emit(state.document, type);
    state.api.finish();
    vi.advanceTimersByTime(5000);
    expectFinished(state);
  });

  it.each(['scroll', 'hashchange', 'pagehide'])('releases immediately on window %s and resets the future V start time', type => {
    const state = fixture();
    vi.advanceTimersByTime(100);
    state.emit(state.window, type);
    expectFinished(state);
    vi.advanceTimersByTime(5000);
    expectFinished(state);
  });

  it('finishes a partially revealed entrance immediately on user input', () => {
    const state = fixture();
    vi.advanceTimersByTime(1000);
    expect(state.root.dataset.entrance).toBe('revealing');
    state.emit(state.document, 'pointerdown');
    expectFinished(state, 2);
    vi.advanceTimersByTime(5000);
    expectFinished(state, 2);
  });

  it('removes the entrance when the user enables reduced motion midway', () => {
    const state = fixture();
    vi.advanceTimersByTime(200);
    state.emit(state.media, 'change');
    expect(state.root.dataset.entrance).toBe('opening');
    state.media.matches = true;
    state.emit(state.media, 'change');
    expectFinished(state);
    state.media.matches = false;
    state.emit(state.media, 'change');
    vi.advanceTimersByTime(5000);
    expectFinished(state);
  });

  it('does not mistake normal pageshow for BFCache, but clears a restored page', () => {
    const state = fixture();
    state.emit(state.window, 'pageshow', { persisted: false });
    expect(state.root.dataset.entrance).toBe('opening');
    vi.advanceTimersByTime(300);
    state.emit(state.window, 'pageshow', { persisted: true });
    expectFinished(state);
    state.emit(state.window, 'pageshow', { persisted: true });
    vi.advanceTimersByTime(5000);
    expectFinished(state);
  });

  it('exposes an idempotent finish hook for pause controls and later enhancements', () => {
    const state = fixture();
    state.api.finish();
    state.api.finish();
    expectFinished(state);
    vi.advanceTimersByTime(5000);
    expectFinished(state);
  });
});
