/* Small, optional UI sounds. User activation stays in charge of navigation and forms. */
(() => {
  'use strict';
  const strings = (() => { try { return JSON.parse(document.getElementById('ThemeStrings')?.textContent || '{}'); } catch (_) { return {}; } })();
  const boot = () => {
    const button = document.querySelector('[data-sound-toggle]');
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!button || !Audio) return;
    const preference = 'veyro-sound-enabled';
    let enabled = false, context, output, buffers, waking;
    let epoch = 0;
    const voices = new Set();
    const snapshots = new WeakMap();
    const inputClicks = new WeakSet();
    try { enabled = sessionStorage.getItem(preference) === 'true'; } catch (_) { /* Optional preference. */ }

    const sync = () => {
      button.hidden = false;
      button.setAttribute('aria-pressed', String(enabled));
      const label = enabled ? strings.soundOff : strings.soundOn;
      button.setAttribute('aria-label', label);
      button.title = label;
    };
    const remember = () => {
      try { sessionStorage.setItem(preference, String(enabled)); } catch (_) { /* Sound also works without storage. */ }
    };
    const silence = () => {
      epoch++;
      for (const source of voices) {
        try { source.stop(); } catch (_) { /* It may already have ended. */ }
        source.disconnect();
      }
      voices.clear();
    };

    // Damped, filtered transients instead of a sliding sine-wave beep. Opening
    // has two light ascending taps; closing has a shorter, lower descending pair.
    const makeBuffer = (kind) => {
      const rate = context.sampleRate;
      const duration = { click: .045, open: .12, close: .10 }[kind];
      const buffer = context.createBuffer(1, Math.ceil(rate * duration), rate);
      const data = buffer.getChannelData(0);
      const hits = kind === 'open' ? [[0, 760, .8], [.038, 1120, .6]]
        : kind === 'close' ? [[0, 790, .65], [.028, 470, .85]] : [[0, 680, 1]];
      let seed = 14927, low = 0;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        low += .28 * (((seed / 4294967296) * 2 - 1) - low);
        const t = i / rate;
        let sample = 0;
        for (const [offset, frequency, level] of hits) {
          const age = t - offset;
          if (age < 0) continue;
          const attack = Math.min(1, age / .0007);
          const body = Math.sin(2 * Math.PI * frequency * age) * Math.exp(-age / .0065);
          const detail = Math.sin(2 * Math.PI * frequency * 2.7 * age) * Math.exp(-age / .0025);
          sample += level * attack * (.095 * body + .022 * detail + .11 * low * Math.exp(-age / .003));
        }
        data[i] = sample;
      }
      return buffer;
    };
    const unavailable = () => { enabled = false; silence(); remember(); sync(); };
    const wake = () => {
      if (!enabled) return;
      try {
        if (!context || context.state === 'closed') {
          context = new Audio({ latencyHint: 'interactive' });
          output = context.createGain();
          output.gain.value = .65;
          output.connect(context.destination);
          buffers = { click: makeBuffer('click'), open: makeBuffer('open'), close: makeBuffer('close') };
        }
        if (context.state !== 'running' && !waking) {
          const attempt = epoch;
          waking = context.resume().catch(() => { if (attempt === epoch && enabled) unavailable(); }).finally(() => { waking = null; });
        }
        return waking;
      } catch (_) { unavailable(); }
    };
    const play = (kind) => {
      if (!enabled || document.hidden) return;
      const attempt = epoch;
      const ready = wake();
      const start = () => {
        if (!enabled || attempt !== epoch || document.hidden || context?.state !== 'running') return;
        try {
          const source = context.createBufferSource();
          source.buffer = buffers[kind];
          source.connect(output);
          voices.add(source);
          source.onended = () => { voices.delete(source); source.disconnect(); };
          source.start();
        } catch (_) { /* Audio failure must never interrupt an interaction. */ }
      };
      if (context?.state === 'running') start();
      else ready?.then(start);
    };

    button.addEventListener('click', () => {
      enabled = !enabled;
      silence();
      remember(); sync();
      if (enabled) play('click');
    });

    const selector = 'a[href],button,summary,input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],[role="button"],[role="tab"]';
    const available = el => el && !el.matches(':disabled,[aria-disabled="true"]') && !el.closest('[hidden],[inert]') && el.getClientRects().length > 0;
    const expanded = details => details.open && !details.classList.contains('is-closing');
    const menuOpen = () => document.querySelector('[data-nav-toggle]')?.getAttribute('aria-expanded') === 'true';
    const cookieOpen = () => { const banner = document.querySelector('[data-cookie]'); return !!banner && !banner.hidden; };

    // Capture before handlers disable submit buttons, hide a cookie banner or
    // focus a menu link. Actual activation is handled in bubble, so cancelled
    // gallery drags never make a sound. Enter/Space already produce native clicks.
    document.addEventListener('click', event => {
      const control = event.target.closest?.(selector);
      if (!available(control) || control.closest('[data-sound-toggle]')) return;
      const details = control.matches('summary') ? control.parentElement : null;
      snapshots.set(event, {
        control, details: details?.matches('details') ? details : null,
        open: details?.matches('details') ? expanded(details) : null,
        aria: control.getAttribute('aria-expanded'), menu: menuOpen(), cookie: cookieOpen(),
      });
    }, true);
    document.addEventListener('click', event => {
      const before = snapshots.get(event);
      if (!before || !enabled) return;
      const { control, details } = before;
      // Resume inside the gesture, including when a native details toggle has
      // to be read in the next task (its default action runs after bubbling).
      wake();
      if (details) {
        const resolve = () => {
          const after = expanded(details);
          play(after !== before.open ? (after ? 'open' : 'close') : 'click');
        };
        if (expanded(details) !== before.open) resolve();
        else setTimeout(resolve, 0);
        return;
      }
      const aria = control.getAttribute('aria-expanded');
      if (aria !== before.aria && (aria === 'true' || aria === 'false')) { play(aria === 'true' ? 'open' : 'close'); return; }
      if (before.menu && !menuOpen() && control.closest('[data-mobile-nav]')) { play('close'); return; }
      const cookie = cookieOpen();
      if (cookie !== before.cookie) { play(cookie ? 'open' : 'close'); return; }
      if (control.matches('input[type="checkbox"],input[type="radio"]')) {
        inputClicks.add(control);
        setTimeout(() => inputClicks.delete(control), 0);
      }
      play('click');
    });
    document.addEventListener('change', event => {
      const control = event.target;
      if (!control.matches?.('select,input[type="checkbox"],input[type="radio"]') || !available(control)) return;
      if (inputClicks.has(control)) { inputClicks.delete(control); return; }
      play('click');
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menuOpen()) play('close');
    }, true);
    sync();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
