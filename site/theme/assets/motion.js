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
      graphic.innerHTML = '<svg viewBox="0 0 240 240" fill="none"><circle class="process-orbit__track" cx="120" cy="120" r="96"/><circle class="process-orbit__fill" cx="120" cy="120" r="96"/><image href="/assets/favicon.svg" x="82" y="76" width="76" height="76"/><circle class="process-orbit__dot" cx="120" cy="24" r="5"/></svg><span class="process-orbit__count">01</span>';
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
      const heroProgress = hero ? clamp(-hero.getBoundingClientRect().top / Math.max(1, hero.offsetHeight)) : 0;
      if (hero && enabled()) {
        hero.style.setProperty('--hero-scroll', String(heroProgress));
        hero.style.setProperty('--wordmark-shift', `${heroProgress * 65}px`);
        scene?.setScroll();
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

    // Original tubular V coordinates; only presentation and temporary offsets change.
    function createScene(canvas) {
      const ctx = canvas.getContext('2d', { alpha: true });
      if (!ctx) return null;
      const host = canvas.parentElement;
      const lowPower = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2;
      let width = 0, height = 0, dpr = 1;
      let visible = true, raf = 0, last = 0, elapsed = 0, totalFrames = 0;
      let scroll = 0, scrollStart = 0, scrollRange = 1, pointerX = 0, pointerY = 0, targetX = 0, targetY = 0;
      let pointerU = .5, pointerV = .5, targetU = .5, targetV = .5, strength = 0, targetStrength = 0;
      let entranceStart = null, formed = false, rippleStart = -10, rippleU = .5, rippleV = .5;
      let points = [], projected = [], readingAreas = [];
      let clientX = null, clientY = null;
      canvas.dataset.frames = '0';
      function buildPoints() {
        points = [];
        const rings = lowPower ? (width < 500 ? 36 : 54) : (width < 500 ? 45 : 68);
        const sides = lowPower ? (width < 500 ? 17 : 23) : (width < 500 ? 19 : 27);
        const norm = Math.hypot(1.2, 2.15);
        for (const arm of [-1, 1]) {
          for (let ring = 0; ring < rings; ring++) {
            const u = ring / (rings - 1);
            for (let side = 0; side < sides; side++) {
              const angle = side / sides * Math.PI * 2;
              const co = Math.cos(angle), si = Math.sin(angle);
              const nx = 2.15 / norm, ny = -arm * 1.2 / norm;
              points.push({
                x: arm * 1.2 * u + nx * co * .205,
                y: -1.05 + 2.15 * u + ny * co * .205,
                z: si * .205,
                nx: nx * co, ny: ny * co, nz: si,
                // Deterministic assembly offsets never mutate the source geometry.
                ex: arm * (.09 + .1 * u) + Math.sin(angle * 3 + u * 17) * .045,
                ey: Math.cos(angle * 2 + u * 13) * .12,
                ez: Math.sin(angle + u * 11) * .15,
                u, angle,
              });
            }
          }
        }
        projected = points.map(() => ({}));
        canvas.dataset.particles = String(points.length);
      }
      function resize() {
        const rect = host.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        // The sculpture leaves before the large wordmark. Complete its turn
        // while it is still visible, starting at the header-aligned hero top.
        const heroTop = (hero || host).getBoundingClientRect().top + scrollY;
        const headerHeight = document.querySelector('[data-header]')?.offsetHeight || 0;
        scrollStart = Math.max(0, heroTop - headerHeight);
        scrollRange = Math.max(1, Math.min(rect.height * .66, innerHeight * .58));
        // Cache text bounds outside the render loop. Silver recedes under copy,
        // especially where the unchanged mobile composition overlaps the sculpture.
        const areas = [...(hero?.querySelectorAll('.studio-message > p, .studio-message h1, .studio-specialties, .studio-action > *') || [])].map(el => {
          const r = el.getBoundingClientRect();
          return { left: r.left - rect.left, right: r.right - rect.left, top: r.top - rect.top, bottom: r.bottom - rect.top };
        });
        const readingChanged = JSON.stringify(areas) !== JSON.stringify(readingAreas);
        readingAreas = areas;
        const resolution = Math.min(devicePixelRatio || 1, lowPower ? 1.2 : rect.width < 500 ? 1.5 : 1.7);
        if (width === rect.width && height === rect.height && dpr === resolution) {
          if (readingChanged && !enabled()) draw(0);
          return;
        }
        width = rect.width; height = rect.height; dpr = resolution;
        canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        buildPoints();
        if (entranceStart === null) entranceStart = performance.now();
        if (!enabled() || (hero && hero.getBoundingClientRect().top < -80)) formed = true;
        draw(elapsed);
      }
      function draw(t) {
        if (!width || !height) return;
        const moving = enabled();
        const entry = formed || !moving ? 1 : clamp((performance.now() - entranceStart) / 1850);
        if (entry === 1) formed = true;
        canvas.dataset.formation = formed ? 'formed' : 'assembling';
        const settle = 1 - Math.pow(1 - entry, 3);
        const s = moving ? scroll : 0;
        const idle = moving ? t : 0;
        const ay = .18 + Math.sin(idle * .22) * .16 + pointerX * .22 + s * .74 + (1 - settle) * .16;
        const ax = -.1 + Math.sin(idle * .18) * .045 - pointerY * .12 - s * .18;
        const az = -.16 + Math.sin(idle * .15) * .025 + s * .14 - (1 - settle) * .07;
        const cy = Math.cos(ay), sy = Math.sin(ay), cx = Math.cos(ax), sx = Math.sin(ax), cz = Math.cos(az), sz = Math.sin(az);
        const scale = Math.min(width / 3.6, height / 3.1) * (1.025 - s * .1);
        const camera = 4.6 - s * .38;
        const localRadius = Math.min(width * .2, 145);
        const pointerScreenX = pointerU * width, pointerScreenY = pointerV * height;
        const rippleAge = moving ? t - rippleStart : 10;
        const rippleRadius = rippleAge * Math.max(width, height) * .75;
        const idleSweep = moving ? (t % 9) / 2.4 - .35 : .6;
        ctx.clearRect(0, 0, width, height);
        points.forEach((p, i) => {
          const assembled = formed ? 1 : clamp((entry - p.u * .11) / .89);
          const offset = Math.pow(1 - assembled, 3);
          const wave = moving ? Math.sin(p.u * 8 - t * .65) * .004 : 0;
          const x = p.x + p.ex * offset + p.nx * wave;
          const y = p.y + p.ey * offset + p.ny * wave;
          const z = p.z + p.ez * offset + p.nz * wave;
          const rx = x * cy + z * sy, rz = -x * sy + z * cy;
          const ry = y * cx - rz * sx, depth = y * sx + rz * cx;
          const px = rx * cz - ry * sz, py = rx * sz + ry * cz;
          const perspective = camera / (camera - depth);
          let screenX = width * .49 + px * scale * perspective - s * width * .025;
          let screenY = height * .49 - py * scale * perspective + s * 24;
          const dx = screenX - pointerScreenX, dy = screenY - pointerScreenY;
          const distance = strength > .001 ? Math.hypot(dx, dy) : localRadius;
          const near = strength > .001 ? Math.pow(clamp(1 - distance / localRadius), 2) * strength : 0;
          // Five CSS pixels at most: the local response cannot break the silhouette.
          screenX += dx / Math.max(distance, 1) * near * 5;
          screenY += dy / Math.max(distance, 1) * near * 5;
          const rippleActive = rippleAge >= 0 && rippleAge < 1.25;
          const rippleDistance = rippleActive ? Math.hypot(screenX - rippleU * width, screenY - rippleV * height) : 0;
          const ripple = rippleActive ? Math.exp(-Math.pow((rippleDistance - rippleRadius) / 40, 2)) * (1 - rippleAge / 1.25) : 0;
          screenX += p.nx * ripple * 2;
          screenY -= p.ny * ripple * 2;
          // Rotate the surface normal with the same camera as the point.
          const nrx = p.nx * cy + p.nz * sy, nrz = -p.nx * sy + p.nz * cy;
          const nry = p.ny * cx - nrz * sx, normalZ = p.ny * sx + nrz * cx;
          const normalX = nrx * cz - nry * sz, normalY = nrx * sz + nry * cz;
          const diffuse = Math.max(0, normalX * -.32 + normalY * .38 + normalZ * .86);
          const spec = Math.pow(Math.max(0, normalX * -.2 + normalY * .2 + normalZ * .96), 9);
          const openingSweep = !formed ? Math.exp(-Math.pow((p.u - (entry * 1.7 - .35)) / .13, 2)) * .42 : 0;
          const sweep = Math.exp(-Math.pow((p.u - idleSweep - s * .35) / .095, 2)) * .2;
          // This band is driven by scroll position, independently of idle time.
          const scrollSweep = s > 0 ? Math.exp(-Math.pow((p.u - (s * 1.5 - .25)) / .13, 2)) * .32 : 0;
          const depthLight = clamp((depth + .7) / 1.4);
          let legibility = 1;
          for (const area of readingAreas) {
            const gapX = Math.max(area.left - screenX, 0, screenX - area.right);
            const gapY = Math.max(area.top - screenY, 0, screenY - area.bottom);
            if (gapX < 26 && gapY < 26) legibility = Math.min(legibility, .34 + .66 * clamp(Math.hypot(gapX, gapY) / 26));
          }
          const brightness = legibility * clamp(.21 + diffuse * .38 + spec * .29 + depthLight * .1 + sweep + scrollSweep + openingSweep + near * .22 + ripple * .15, .17, .96);
          Object.assign(projected[i], { x: screenX, y: screenY, depth, brightness, size: (width < 500 ? .88 : 1.02) * perspective + diffuse * .19 + spec * .25 + near * .14 });
        });
        projected.sort((a, b) => a.depth - b.depth);
        for (const p of projected) {
          ctx.fillStyle = `rgba(229,234,239,${p.brightness.toFixed(2)})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
        }
      }
      function tick(now) {
        raf = 0;
        if (!visible || document.hidden || !enabled()) {
          canvas.dataset.paused = 'true';
          if (!enabled() && body.classList.contains('studio-motion-ready')) syncMotion();
          return;
        }
        if (!last || now - last >= 1000 / 30) {
          const dt = last ? Math.min((now - last) / 1000, .1) : 1 / 30;
          elapsed += dt; last = now;
          const follow = 1 - Math.exp(-dt * 6);
          pointerX = lerp(pointerX, targetX, follow); pointerY = lerp(pointerY, targetY, follow);
          pointerU = lerp(pointerU, targetU, follow); pointerV = lerp(pointerV, targetV, follow);
          strength = lerp(strength, targetStrength, follow);
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
        else {
          // Leaving, pausing or reducing motion completes the entrance permanently.
          formed = true;
          targetX = targetY = pointerX = pointerY = strength = targetStrength = 0;
          rippleStart = -10;
          if (!enabled()) draw(0);
        }
      }
      const observer = 'IntersectionObserver' in window ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); }, { threshold: 0 }) : null;
      observer?.observe(host);
      function locatePointer() {
        if (clientX === null) return;
        const r = host.getBoundingClientRect();
        targetU = (clientX - r.left) / r.width; targetV = (clientY - r.top) / r.height;
        targetStrength = targetU >= 0 && targetU <= 1 && targetV >= 0 && targetV <= 1 ? 1 : 0;
        targetX = clamp(targetU - .5, -.5, .5); targetY = clamp(targetV - .5, -.5, .5);
      }
      hero?.addEventListener('pointermove', event => {
        if (!finePointer.matches || event.pointerType === 'touch' || !enabled()) return;
        clientX = event.clientX; clientY = event.clientY;
        locatePointer();
      }, { passive: true });
      hero?.addEventListener('pointerleave', () => { clientX = clientY = null; targetX = targetY = targetStrength = 0; });
      hero?.addEventListener('click', event => {
        if (!enabled() || event.defaultPrevented || event.target.closest('a,button,summary,input,select,textarea,label,[role="button"],[role="tab"],[contenteditable]')) return;
        const r = host.getBoundingClientRect();
        rippleU = (event.clientX - r.left) / r.width; rippleV = (event.clientY - r.top) / r.height;
        rippleStart = elapsed;
      });
      return { resize, sync, setScroll() { scroll = clamp((scrollY - scrollStart) / scrollRange); locatePointer(); } };
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
