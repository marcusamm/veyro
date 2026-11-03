/* A shared atmosphere and small, scroll-linked text movements. No scroll ownership. */
(() => {
  'use strict';
  const boot = () => {
    const body = document.body;
    if (!body.classList.contains('template-index')) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    // Only noninteractive copy moves. Sticky ancestors, links, forms and the
    // price chooser stay in their native layout with stable pointer hitboxes.
    const selector = [
      '.studio-introduction > div:nth-child(2)',
      '.project-gallery__intro', '.studio-capabilities__head', '.capability__copy',
      '.booking-flow__copy > h2', '.booking-flow__copy > .rte', '.packages__head',
      '.steps__title', '.steps__text', '.coming__head > h2', '.coming__head > .rte',
      '.faq__intro > .head', '.contact__aside > .head', '.footer-invitation > p',
    ].join(',');
    const items = [...document.querySelectorAll(selector)]
      .filter(element => !element.querySelector('a, button, input, select, textarea, summary, [tabindex]'))
      .map(element => ({ element, top: 0, shift: 0 }));
    let frame = 0, needsMeasure = true, pageActive = true;
    let viewport = innerHeight, scrollRange = 1;
    const enabled = () => body.classList.contains('has-motion') && !body.classList.contains('effects-paused') && !reduce.matches;
    items.forEach(({ element }) => element.classList.add('home-flow-item'));

    function measure() {
      viewport = Math.max(1, innerHeight);
      scrollRange = Math.max(1, document.documentElement.scrollHeight - viewport);
      items.forEach(item => {
        const rect = item.element.getBoundingClientRect();
        // CSS may already have removed the displacement after a preference change.
        const applied = getComputedStyle(item.element).translate;
        const translation = applied && applied !== 'none' ? parseFloat(applied.split(' ')[1]) || 0 : 0;
        item.top = rect.top + scrollY - translation;
      });
      needsMeasure = false;
    }
    function render() {
      frame = 0;
      if (!pageActive || document.hidden) return;
      if (needsMeasure) measure();
      const moving = enabled(), y = scrollY;
      const progress = clamp(y / scrollRange, 0, 1);
      body.style.setProperty('--home-light-y', `${moving ? ((.5 - progress) * 140).toFixed(2) : 0}px`);
      body.style.setProperty('--home-light-x', `${moving ? ((progress - .5) * 56).toFixed(2) : 0}px`);
      items.forEach(item => {
        const shift = moving ? clamp((item.top - y - viewport * .46) / viewport * 32, -16, 28) : 0;
        if (shift === item.shift) return;
        item.shift = shift;
        item.element.style.setProperty('--home-flow-y', `${shift.toFixed(2)}px`);
      });
    }
    function schedule(measureAgain = false) {
      needsMeasure ||= measureAgain;
      if (!frame && pageActive && !document.hidden) frame = requestAnimationFrame(render);
    }
    function cancel() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    addEventListener('scroll', () => schedule(), { passive: true });
    addEventListener('resize', () => schedule(true), { passive: true });
    addEventListener('load', () => schedule(true), { once: true });
    addEventListener('pagehide', () => { pageActive = false; cancel(); });
    addEventListener('pageshow', () => { pageActive = true; schedule(true); });
    document.addEventListener('visibilitychange', () => document.hidden ? cancel() : schedule(true));
    reduce.addEventListener('change', () => schedule(true));
    new MutationObserver(() => schedule(true)).observe(body, { attributes: true, attributeFilter: ['class'] });
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(() => schedule(true));
      const main = document.querySelector('main'), footer = document.querySelector('.site-footer');
      if (main) observer.observe(main);
      if (footer) observer.observe(footer);
    }
    document.fonts?.ready.then(() => schedule(true)).catch(() => {});
    render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
