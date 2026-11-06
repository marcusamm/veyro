/* TikTok Pixel + Events API: explicit marketing consent, public .dk pages only. */
(() => {
  'use strict';
  if (location.hostname !== 'veyro.dk' || !/^\/(?:$|en\/?$|(?:en\/)?(?:pages|products)\/[a-z0-9-]+\/?$)/.test(location.pathname)) return;
  const key = 'theme-cookie-consent', id = 'DBMMVK3C77UDLIGRBECG';
  let loaded = false, sent = false, timer, request;
  function allowed() {
    try {
      const r = JSON.parse(localStorage.getItem(key)), age = Date.now() - r?.t;
      return !window.__veyroConsentStorageFailed && !navigator.globalPrivacyControl && navigator.doNotTrack !== '1' && window.doNotTrack !== '1' && r?.v === 2 && age >= 0 && age < 31536000000 && r.consent?.marketing === true && r.consent?.tiktok === true;
    } catch { return false; }
  }
  function loadPixel() {
    window.TiktokAnalyticsObject = 'ttq';
    const q = window.ttq = window.ttq || [];
    q.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie', 'holdConsent', 'revokeConsent', 'grantConsent'];
    q.setAndDefer = (o, m) => { o[m] = (...a) => o.push([m, ...a]); };
    q.methods.forEach(m => q.setAndDefer(q, m));
    q.instance = p => { const o = q._i[p] || []; q.methods.forEach(m => q.setAndDefer(o, m)); return o; };
    q.load = (pixel, options) => {
      const url = 'https://analytics.tiktok.com/i18n/pixel/events.js';
      q._i = q._i || {}; q._i[pixel] = []; q._i[pixel]._u = url;
      q._t = q._t || {}; q._t[pixel] = Date.now();
      q._o = q._o || {}; q._o[pixel] = options || {};
      const script = document.createElement('script');
      script.async = true; script.src = url + '?sdkid=' + pixel + '&lib=ttq';
      document.head.appendChild(script);
    };
    q.holdConsent();
    q.load(id, { autoConfig: false });
    loaded = true;
  }
  function sync() {
    clearTimeout(timer);
    if (!allowed()) {
      request?.abort();
      if (loaded) { window.ttq.revokeConsent(); window.ttq.disableCookie(); }
      for (const part of document.cookie.split(';')) {
        const name = part.trim().split('=')[0];
        if (name === '_ttp' || name.startsWith('ttcsid')) {
          for (const domain of ['', '; Domain=veyro.dk', '; Domain=.veyro.dk']) document.cookie = name + '=; Max-Age=0; Path=/; Secure' + domain;
        }
      }
      return;
    }
    if (!loaded) loadPixel();
    window.ttq.grantConsent(); window.ttq.enableCookie();
    if (!sent) {
      // TikTok's official GTM template uses track('Pageview', ..., {event_id}).
      // Both transports share this ID so TikTok can deduplicate the same visit.
      const eventId = crypto.randomUUID();
      window.ttq.track('Pageview', {}, { event_id: eventId });
      sent = true;
      const consent = JSON.parse(localStorage.getItem(key));
      const click = new URLSearchParams(location.search).get('ttclid');
      request = new AbortController();
      fetch('/marketing/tiktok/events', {
        method: 'POST', credentials: 'same-origin', signal: request.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId, path: location.pathname, marketing: true, tiktok: true,
          consentVersion: 2, consentAt: consent.t,
          ttclid: click && /^[a-zA-Z0-9_.=-]{1,512}$/.test(click) ? click : undefined }),
      }).catch(() => { /* Optional measurement must not interrupt browsing. No delayed retries after withdrawal. */ });
    }
    timer = setTimeout(sync, Math.min(2147483647, Math.max(1, JSON.parse(localStorage.getItem(key)).t + 31536000000 - Date.now())));
  }
  document.addEventListener('theme:consent', sync);
  window.addEventListener('storage', e => { if (!e.key || e.key === key) sync(); });
  window.addEventListener('pageshow', sync);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
  sync();
})();
