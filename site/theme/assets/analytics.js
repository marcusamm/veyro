/* First-party visitor statistics. No identifiers or requests before explicit v2 consent. */
(() => {
  'use strict';
  if (window.__veyroAnalyticsInitialized) return;
  window.__veyroAnalyticsInitialized = true;

  const STORE_KEY = 'theme-cookie-consent';
  const MAX_AGE = 365 * 24 * 60 * 60 * 1000;
  const IDLE_MS = 60 * 1000;
  const INTERVAL_MS = 30 * 1000;
  const SESSION_IDLE_MS = 30 * 60 * 1000;
  const ENDPOINT = '/analytics/events';
  const campaignSources = new Set(['google', 'bing', 'instagram', 'facebook', 'linkedin', 'tiktok', 'newsletter', 'email']);
  const privacySignal = () => navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === '1' || window.doNotTrack === '1';
  const read = (value) => {
    try { return JSON.parse(value === undefined ? localStorage.getItem(STORE_KEY) || 'null' : value); }
    catch { return null; }
  };
  const fresh = (record) => record?.v === 2 && Number.isFinite(record.t) &&
    Date.now() >= record.t && Date.now() - record.t < MAX_AGE;
  const optedIn = (record) => fresh(record) && record.consent?.analytics === true &&
    !privacySignal() && !window.__veyroConsentStorageFailed;

  function init() {
    const path = location.pathname;
    const consentAvailable = !!document.querySelector('[data-cookie]');
    // The server only marks real, published public pages. The path check is an extra guard.
    const publicPage = document.body?.dataset.analyticsPage === 'true' &&
      (/^\/(?:(?:en|sv)\/?)?$/.test(path) || /^\/(?:(?:en|sv)\/)?(?:pages|products)\/[a-z0-9-]+$/.test(path));
    let view = null;
    let queue = Promise.resolve();
    let revokedRecord = null;
    let expiredNotified = false;
    let lastRecord = read();

    const post = async (payload) => {
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST', credentials: 'same-origin', keepalive: true,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (payload.type === 'revoke') return response.ok;
        return response.ok && response.status !== 204 && (await response.json()).accepted === true;
      } catch { return null; }
    };
    // Keep the initial cookie-setting response ahead of engagement and cookie deletion.
    const enqueue = (task) => { queue = queue.then(task).catch(() => {}); };
    const revoke = (record) => {
      const key = JSON.stringify([record?.v, record?.t, record?.consent?.analytics, privacySignal()]);
      if (revokedRecord === key) return;
      revokedRecord = key;
      enqueue(async () => {
        if (!await post({ type: 'revoke', consent: false, consentVersion: 2 })) revokedRecord = null;
      });
    };
    const depth = () => {
      const height = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      return height > 0 ? Math.round(Math.min(100, Math.max(0, window.scrollY / height * 100))) : 100;
    };
    const sample = (current) => {
      const now = performance.now();
      if (current.visible) {
        current.activeMs += Math.max(0, Math.min(now, current.lastActivity + IDLE_MS) - current.lastTick);
        current.scrollDepth = Math.max(current.scrollDepth, depth());
      }
      current.lastTick = now;
    };
    const payload = (current, type) => ({
      type, eventId: current.eventId, path,
      activeSeconds: Math.floor(current.activeMs / 1000), scrollDepth: current.scrollDepth,
      referrer: current.referrer, ...(current.campaignSource ? { campaignSource: current.campaignSource } : {}),
      consent: true, consentVersion: 2,
    });
    const start = () => {
      if (!publicPage || !window.crypto?.randomUUID) return;
      const now = performance.now();
      let referrer = '', campaignSource;
      try { referrer = new URL(document.referrer).hostname; } catch {}
      try {
        const source = new URL(location.href).searchParams.get('utm_source')?.toLowerCase();
        if (campaignSources.has(source)) campaignSource = source;
      } catch {}
      const current = view = {
        eventId: crypto.randomUUID(), accepted: false, activeMs: 0, scrollDepth: 0,
        lastQueuedSeconds: 0, lastQueuedDepth: 0, lastDeliveredSeconds: 0, lastDeliveredDepth: 0,
        lastTick: now, lastActivity: now, visible: document.visibilityState === 'visible',
        referrer, campaignSource,
      };
      revokedRecord = null;
      enqueue(async () => {
        if (view !== current || !optedIn(read())) return;
        current.accepted = await post(payload(current, 'pageview'));
        if (current.accepted === false && view === current) view = null;
      });
    };
    const refresh = (previousRecord = lastRecord, startIfMissing = false) => {
      const record = read();
      lastRecord = record;
      const allowed = consentAvailable && optedIn(record);
      if (!allowed) {
        const wasTracking = view !== null;
        view = null;
        // Legacy v1 acceptance did not cover statistics and never starts tracking.
        if (wasTracking || previousRecord?.v === 2 && previousRecord.consent?.analytics === true ||
            record?.v === 2 && record.consent?.analytics === true) revoke(record);
        if (record?.v === 2 && !fresh(record) && !expiredNotified) {
          expiredNotified = true;
          document.dispatchEvent(new CustomEvent('theme:consent-expired'));
        }
      } else {
        expiredNotified = false;
        if (!view && startIfMissing) start();
      }
      return view;
    };
    const flush = (exiting = false) => {
      const current = refresh();
      if (!current) return;
      sample(current);
      const event = payload(current, 'engagement');
      if (event.activeSeconds <= current.lastQueuedSeconds && event.scrollDepth <= current.lastQueuedDepth) return;
      current.lastQueuedSeconds = event.activeSeconds;
      current.lastQueuedDepth = event.scrollDepth;
      if (exiting) {
        // A view without an acknowledged pageview cannot yet have a server session.
        if (!current.accepted) {
          current.lastQueuedSeconds = current.lastDeliveredSeconds;
          current.lastQueuedDepth = current.lastDeliveredDepth;
          return;
        }
        try {
          if (navigator.sendBeacon?.(ENDPOINT, new Blob([JSON.stringify(event)], { type: 'application/json' }))) return;
        } catch {}
        void post(event);
      } else {
        enqueue(async () => {
          if (view !== current || !current.accepted || !optedIn(read())) return;
          const accepted = await post(event);
          if (accepted) {
            current.lastDeliveredSeconds = event.activeSeconds;
            current.lastDeliveredDepth = event.scrollDepth;
          } else if (accepted === false && view === current) {
            // A server-side session may have expired. Wait for actual activity before restarting.
            view = null;
          } else {
            current.lastQueuedSeconds = current.lastDeliveredSeconds;
            current.lastQueuedDepth = current.lastDeliveredDepth;
          }
        });
      }
    };
    const activity = () => {
      if (document.visibilityState !== 'visible') return;
      if (view && performance.now() - view.lastActivity >= SESSION_IDLE_MS) view = null;
      const current = refresh(undefined, true);
      if (!current) return;
      sample(current);
      current.lastActivity = performance.now();
    };

    document.addEventListener('theme:consent', () => refresh(undefined, true));
    window.addEventListener('storage', (event) => {
      if (event.key === STORE_KEY || event.key === null) refresh(read(event.oldValue), true);
    });
    // Observe activity only; never read keys, text, pointer coordinates or form values.
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'scroll', 'touchstart']) {
      document.addEventListener(event, activity, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible';
      if (visible && view && performance.now() - view.lastActivity >= SESSION_IDLE_MS) view = null;
      const current = refresh(undefined, visible);
      if (!current) return;
      sample(current);
      current.visible = visible;
      if (current.visible) current.lastActivity = performance.now();
      else flush(true);
    });
    window.addEventListener('pagehide', () => {
      flush(true);
      if (view) view.visible = false;
    });
    window.addEventListener('pageshow', (event) => {
      // Restoring a page from the back/forward cache is a new pageview.
      if (event.persisted) { view = null; refresh(undefined, true); }
    });
    setInterval(() => flush(), INTERVAL_MS);
    refresh(undefined, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
