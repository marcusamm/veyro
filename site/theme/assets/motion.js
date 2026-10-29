/* Veyro studio motion. Decorative canvas, native scroll, no dependencies. */
(() => {
  'use strict';
  const boot = () => {
    const body = document.body;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
    const clamp = (n, a = 0, b = 1) => Math.max(a, Math.min(b, n));
    const lerp = (a, b, t) => a + (b - a) * t;
    let paused = false;
    try { paused = sessionStorage.getItem('veyro-effects-paused') === 'true'; } catch (_) { /* Storage is optional. */ }
    const enabled = () => body.classList.contains('has-motion') && !reduce.matches && !paused;
    let layout = [];
    let scrollFrame = 0;
    let preferenceTimer = 0;
    const hero = document.querySelector('.studio-stage');
    const progress = document.querySelector('[data-scroll-progress]');
    const processes = [...document.querySelectorAll('.steps')];
    const pauseButton = document.querySelector('[data-motion-toggle]');
    const revealItems = [];

    // The original text remains the accessible heading; the spans only stage its entrance.
    const headline = hero?.querySelector('h1');
    if (headline) {
      headline.setAttribute('aria-label', headline.innerText.replace(/\s+/g, ' ').trim());
      const walker = document.createTreeWalker(headline, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      let i = 0;
      nodes.forEach(node => {
        const fragment = document.createDocumentFragment();
        (node.textContent.match(/\S+\s*|\s+/g) || []).forEach(word => {
          if (!word.trim()) { fragment.append(document.createTextNode(word)); return; }
          const shell = document.createElement('span');
          shell.className = 'hero-word-shell';
          shell.setAttribute('aria-hidden', 'true');
          const inner = document.createElement('span');
          inner.className = 'hero-word';
          inner.style.setProperty('--word-delay', `${100 + i++ * 35}ms`);
          inner.textContent = word.trim();
          shell.append(inner);
          fragment.append(shell);
          if (/\s$/.test(word)) fragment.append(document.createTextNode(' '));
        });
        node.replaceWith(fragment);
      });
    }
    const wordmark = hero?.querySelector('.studio-wordmark');
    if (wordmark) {
      const text = wordmark.textContent.trim();
      wordmark.textContent = '';
      [...text].forEach((letter, i) => {
        const span = document.createElement('span');
        span.textContent = letter;
        span.style.setProperty('--letter-delay', `${250 + i * 70}ms`);
        wordmark.append(span);
      });
    }

    // Reveal once, close to the viewport. Tab focus always makes content visible immediately.
    if ('IntersectionObserver' in window) {
      const revealObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }), { rootMargin: '0px 0px -30px 0px', threshold: .05 });
      document.querySelectorAll('.studio-introduction, .home-hero__project, .head, .faq__intro, .concepts__item, .booking-flow__copy, .booking-flow__figure, .packages .pc, .coming__head, .contact__aside, .contact__form-wrap, .footer-invitation, .page-hero__title, .page-hero__text').forEach((el, i) => {
        // Keep the FAQ heading and its link together throughout the entrance.
        if (el.matches('.head') && el.closest('.faq__intro')) return;
        el.classList.add('motion-reveal');
        el.style.setProperty('--reveal-delay', `${(i % 2) * 70}ms`);
        if (el.getBoundingClientRect().top < innerHeight - 30) el.classList.add('is-visible');
        else revealObserver.observe(el);
        revealItems.push(el);
      });
      document.addEventListener('focusin', e => e.target.closest?.('.motion-reveal')?.classList.add('is-visible'));
    }

    // Sticky process: all text stays in the document and scroll is never intercepted.
    processes.forEach(section => {
      const head = section.querySelector('.steps__head');
      if (!head) return;
      const graphic = document.createElement('div');
      graphic.className = 'process-orbit';
      graphic.setAttribute('aria-hidden', 'true');
      graphic.innerHTML = '<svg viewBox="0 0 240 240" fill="none"><circle class="process-orbit__track" cx="120" cy="120" r="96"/><circle class="process-orbit__fill" cx="120" cy="120" r="96"/><path d="m81 92 39 63 39-63"/><circle class="process-orbit__dot" cx="120" cy="24" r="5"/></svg><span class="process-orbit__count">01</span>';
      head.append(graphic);
    });
    function measure() {
      const y = scrollY;
      layout = processes.map(section => ({ section, items: [...section.querySelectorAll('.steps__item')].map(el => ({ el, y: el.getBoundingClientRect().top + y, height: el.offsetHeight })) }));
      scene?.resize();
      updateScroll();
    }
    function updateScroll() {
      scrollFrame = 0;
      const y = scrollY;
      const documentProgress = clamp(y / Math.max(1, document.documentElement.scrollHeight - innerHeight));
      if (progress) progress.style.transform = `scaleX(${documentProgress})`;
      const heroProgress = hero ? clamp(y / Math.max(1, hero.offsetHeight)) : 0;
      if (hero && enabled()) {
        hero.style.setProperty('--hero-scroll', String(heroProgress));
        hero.style.setProperty('--wordmark-shift', `${heroProgress * 65}px`);
        scene?.setScroll(heroProgress);
      }
      layout.forEach(({ section, items }) => {
        if (!items.length) return;
        const focal = y + innerHeight * .5;
        let nearest = 0;
        let distance = Infinity;
        items.forEach((item, i) => {
          const d = Math.abs(item.y + Math.min(item.height, innerHeight * .4) / 2 - focal);
          if (d < distance) { distance = d; nearest = i; }
        });
        items.forEach((item, i) => item.el.classList.toggle('is-current', i === nearest));
        const p = (nearest + 1) / items.length;
        section.dataset.processProgress = String(p);
        section.style.setProperty('--process-progress', String(p));
        const count = section.querySelector('.process-orbit__count');
        if (count) count.textContent = String(nearest + 1).padStart(2, '0');
      });
    }
    addEventListener('scroll', () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(updateScroll); }, { passive: true });
    addEventListener('resize', measure, { passive: true });
    document.fonts?.ready.then(measure);
    if ('ResizeObserver' in window) new ResizeObserver(() => { if (!scrollFrame) scrollFrame = requestAnimationFrame(measure); }).observe(document.querySelector('main') || body);

    // One original 3D point sculpture. Visible only in the hero, paused off-screen.
    function createScene(canvas) {
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return null;
      const host = canvas.parentElement;
      let width = 0, height = 0, dpr = 1;
      let visible = true, raf = 0, last = 0, elapsed = 0, totalFrames = 0;
      let scroll = 0, targetX = 0, targetY = 0, pointerX = 0, pointerY = 0;
      let points = [], projected = [];
      canvas.dataset.frames = '0';
      function buildPoints() {
        points = [];
        const rings = width < 500 ? 45 : 68;
        const sides = width < 500 ? 19 : 27;
        const norm = Math.hypot(1.2, 2.15);
        for (const arm of [-1, 1]) {
          for (let ring = 0; ring < rings; ring++) {
            const u = ring / (rings - 1);
            for (let side = 0; side < sides; side++) {
              const angle = side / sides * Math.PI * 2;
              const co = Math.cos(angle), si = Math.sin(angle);
              const nx = 2.15 / norm, ny = -arm * 1.2 / norm;
              const orbit = u * Math.PI * 2 + (arm === 1 ? Math.PI : 0);
              points.push({
                x: arm * 1.2 * u + nx * co * .205,
                y: -1.05 + 2.15 * u + ny * co * .205,
                z: si * .205,
                nx: nx * co, ny: ny * co, nz: si,
                ox: (1.05 + .26 * co) * Math.cos(orbit),
                oy: (1.05 + .26 * co) * Math.sin(orbit), oz: si * .26,
                u, angle,
              });
            }
          }
        }
        projected = points.map(() => ({}));
      }
      function resize() {
        const rect = host.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        width = rect.width; height = rect.height;
        dpr = Math.min(devicePixelRatio || 1, 1.7);
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        buildPoints();
        draw(0);
      }
      function draw(t) {
        ctx.clearRect(0, 0, width, height);
        const morph = clamp((scroll - .12) / .65);
        const m = morph * morph * (3 - 2 * morph);
        const ay = Math.sin(t * .29) * .45 + .18 + pointerX * .35 + m * 1.5;
        const ax = -.1 + Math.sin(t * .23) * .13 - pointerY * .2;
        const az = -.16 + Math.sin(t * .17) * .09 + m * .8;
        const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
        const scale = Math.min(width / 3.6, height / 3.1);
        const shimmer = t * .8;
        points.forEach((p, i) => {
          const wave = Math.sin(p.u * 8 - t * .7) * .012;
          const x = lerp(p.x, p.ox, m), y = lerp(p.y, p.oy, m) + wave, z = lerp(p.z, p.oz, m);
          const rx = x * cy + z * sy, rz = -x * sy + z * cy;
          const ry = y * cx - rz * sx, depth = y * sx + rz * cx;
          const px = rx * cz - ry * sz, py = rx * sz + ry * cz;
          const perspective = 4.6 / (4.6 - depth);
          const normalZ = p.nx * -sy + p.nz * cy;
          const spec = Math.pow(Math.max(0, Math.cos(p.angle + ay + .8)), 7);
          const sweep = Math.pow(Math.max(0, Math.sin(p.u * 4.5 - shimmer)), 12) * .3;
          const brightness = clamp(.2 + normalZ * .3 + spec * .6 + sweep, .1, 1);
          Object.assign(projected[i], { x: width * .49 + px * scale * perspective, y: height * .49 - py * scale * perspective, depth, brightness, size: (width < 500 ? .9 : 1.05) * perspective + spec * .45 });
        });
        projected.sort((a, b) => a.depth - b.depth);
        for (const p of projected) {
          ctx.fillStyle = `rgba(244,244,237,${p.brightness.toFixed(2)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        }
        host.classList.add('has-canvas');
      }
      function tick(now) {
        raf = 0;
        if (!visible || document.hidden || !enabled()) {
          canvas.dataset.paused = 'true';
          // Some browsers update matches before delivering the media-query event.
          if (!enabled() && body.classList.contains('studio-motion-ready')) syncMotion();
          return;
        }
        if (now - last >= 1000 / 30) {
          elapsed += Math.min(now - (last || now), 60) / 1000;
          last = now;
          pointerX = lerp(pointerX, targetX, .065); pointerY = lerp(pointerY, targetY, .065);
          draw(elapsed);
          canvas.dataset.frames = String(++totalFrames);
        }
        raf = requestAnimationFrame(tick);
      }
      function sync() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0; last = 0;
        const running = visible && !document.hidden && enabled();
        canvas.dataset.paused = String(!running);
        if (running) raf = requestAnimationFrame(tick);
        else if (!enabled()) { scroll = 0; pointerX = 0; pointerY = 0; draw(0); }
      }
      const observer = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0 }) : null;
      observer?.observe(hero || host);
      hero?.addEventListener('pointermove', event => {
        if (!finePointer.matches || !enabled()) return;
        const r = hero.getBoundingClientRect();
        targetX = (event.clientX - r.left) / r.width - .5;
        targetY = (event.clientY - r.top) / r.height - .5;
      }, { passive: true });
      hero?.addEventListener('pointerleave', () => { targetX = 0; targetY = 0; });
      document.addEventListener('visibilitychange', sync);
      return { resize, sync, setScroll(p) { scroll = p; } };
    }
    const canvas = document.querySelector('[data-particle-scene]');
    const scene = canvas ? createScene(canvas) : null;

    // Pointer-lit panels and tilt on project pictures; touch keeps the native interaction.
    document.querySelectorAll('.studio-introduction, .home-hero__project, .concepts__item .browser, .booking-preview').forEach(el => {
      el.classList.add('pointer-surface');
      el.addEventListener('pointermove', event => {
        if (!enabled() || !finePointer.matches) return;
        const r = el.getBoundingClientRect();
        const x = clamp((event.clientX - r.left) / r.width), y = clamp((event.clientY - r.top) / r.height);
        el.style.setProperty('--pointer-x', `${x * 100}%`); el.style.setProperty('--pointer-y', `${y * 100}%`);
        el.style.setProperty('--tilt-x', `${(y - .5) * -4}deg`); el.style.setProperty('--tilt-y', `${(x - .5) * 4}deg`);
      }, { passive: true });
      el.addEventListener('pointerleave', () => { el.style.setProperty('--tilt-x', '0deg'); el.style.setProperty('--tilt-y', '0deg'); });
    });

    // Buttons spring gently towards the pointer; the hit area does not move.
    document.querySelectorAll('.studio-action .btn, .site-header__cta').forEach(el => {
      el.classList.add('magnetic-button');
      const label = document.createElement('span');
      label.className = 'magnetic-button__label';
      while (el.firstChild) label.append(el.firstChild);
      el.append(label);
      el.addEventListener('pointermove', event => {
        if (!enabled() || !finePointer.matches) return;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--magnet-x', `${(event.clientX - r.left - r.width / 2) * .12}px`);
        el.style.setProperty('--magnet-y', `${(event.clientY - r.top - r.height / 2) * .2}px`);
      }, { passive: true });
      el.addEventListener('pointerleave', () => { el.style.setProperty('--magnet-x', '0px'); el.style.setProperty('--magnet-y', '0px'); });
    });

    function syncMotion() {
      clearTimeout(preferenceTimer);
      body.classList.toggle('studio-motion-ready', enabled());
      body.classList.toggle('effects-paused', paused);
      if (pauseButton) {
        pauseButton.hidden = !body.classList.contains('has-motion') || reduce.matches;
        pauseButton.setAttribute('aria-pressed', String(paused));
        const label = paused ? 'Start effekter' : 'Sæt effekter på pause';
        pauseButton.setAttribute('aria-label', label); pauseButton.title = label;
        pauseButton.querySelector('[data-motion-icon]').textContent = paused ? '▷' : 'Ⅱ';
      }
      if (!enabled()) revealItems.forEach(el => el.classList.add('is-visible'));
      scene?.sync(); updateScroll();
      // No drawing or animation in this fallback: it only notices a preference
      // being lifted when a browser has suppressed its native change event.
      if (reduce.matches && !document.hidden) {
        const checkPreference = () => {
          if (!reduce.matches) syncMotion();
          else if (!document.hidden) preferenceTimer = setTimeout(checkPreference, 750);
        };
        preferenceTimer = setTimeout(checkPreference, 750);
      }
    }
    pauseButton?.addEventListener('click', () => {
      paused = !paused;
      try { sessionStorage.setItem('veyro-effects-paused', String(paused)); } catch (_) { /* Optional preference. */ }
      syncMotion();
    });
    reduce.addEventListener('change', syncMotion);
    document.addEventListener('visibilitychange', syncMotion);
    addEventListener('focus', syncMotion);

    measure(); syncMotion();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
