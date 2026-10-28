/* Original three-dimensional revolving showcase. Native links stay usable. */
(() => {
  'use strict';
  function init() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    document.querySelectorAll('[data-project-gallery]').forEach(gallery => {
      const stage = gallery.querySelector('[data-gallery-stage]');
      const planes = [...stage.querySelectorAll('.project-gallery__plane')];
      const controls = gallery.querySelector('[data-gallery-controls]');
      const pauseButton = gallery.querySelector('[data-gallery-pause]');
      const currentLabel = gallery.querySelector('[data-gallery-current]');
      const names = planes.map(plane => plane.querySelector('figcaption > span')?.textContent.trim() || 'Demo');
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
      const rad = Math.PI / 180;
      let inView = false, orbit = false, localPaused = false, focused = false;
      let frame = 0, last = 0, angle = -25, scrollAngle = 0, scrollTarget = 0, velocity = 0;
      let stageWidth = 0, stageHeight = 0, cardWidth = 0, radius = 0, cardHeight = 0;
      let drag = null, suppressClickUntil = 0;
      const supported = () => document.body.classList.contains('has-motion') && !reduce.matches;
      const running = () => orbit && inView && !document.hidden && !localPaused && !focused && !document.body.classList.contains('effects-paused');
      gallery.dataset.rotation = '0';
      gallery.dataset.galleryOrbitReady = 'false';

      // A small mesh of vertical strips bends each screenshot in actual CSS 3D.
      // It is decorative; the original image and link remain the static fallback.
      const meshes = planes.map(plane => {
        const image = plane.querySelector('.project-gallery__image');
        const original = image.querySelector('img');
        original.draggable = false;
        const mesh = document.createElement('div');
        mesh.className = 'gallery-curve';
        mesh.setAttribute('aria-hidden', 'true');
        image.append(mesh);
        return { mesh, original, slices: [] };
      });
      function curveScreens() {
        const count = stageWidth < 650 ? 10 : 18;
        const halfBend = .23;
        const bendRadius = cardWidth / (2 * Math.sin(halfBend));
        const arcLength = bendRadius * halfBend * 2;
        const segment = arcLength / count;
        const overlap = stageWidth < 650 ? 2.8 : 2.2;
        const sliceWidth = segment + overlap;
        meshes.forEach(({ mesh, original, slices }) => {
          if (slices.length !== count) {
            mesh.textContent = ''; slices.length = 0;
            for (let i = 0; i < count; i++) {
              const slice = document.createElement('span');
              slice.className = 'gallery-curve__slice';
              if (i === 0) slice.classList.add('gallery-curve__slice--first');
              if (i === count - 1) slice.classList.add('gallery-curve__slice--last');
              mesh.append(slice); slices.push(slice);
            }
          }
          const src = original.currentSrc || original.src;
          slices.forEach((slice, i) => {
            const a = ((i + .5) / count - .5) * halfBend * 2;
            const x = bendRadius * Math.sin(a);
            const z = bendRadius * (Math.cos(a) - 1);
            slice.style.width = `${sliceWidth}px`;
            slice.style.left = `calc(50% + ${x - sliceWidth / 2}px)`;
            slice.style.backgroundImage = `url(${JSON.stringify(src)})`;
            slice.style.backgroundSize = `${arcLength}px ${cardHeight}px`;
            slice.style.backgroundPosition = `${-i * segment + overlap / 2}px 0px`;
            slice.style.transform = `translateZ(${z}px) rotateY(${a}rad)`;
          });
          original.loading = 'eager';
        });
      }
      function measure() {
        const bounds = stage.getBoundingClientRect();
        stageWidth = bounds.width; stageHeight = bounds.height;
        const small = stageWidth < 650;
        cardWidth = small ? stageWidth * .72 : Math.min(stageWidth * .355, 540);
        cardHeight = cardWidth / 1.6;
        radius = small ? stageWidth * .4 : Math.min(stageWidth * .285, 430);
        stage.style.setProperty('--orbit-card-width', `${cardWidth}px`);
        stage.style.setProperty('--orbit-perspective', small ? '900px' : '1500px');
        if (orbit) { curveScreens(); readScroll(); render(); }
      }
      function readScroll() {
        if (!orbit) return;
        const bounds = stage.getBoundingClientRect();
        scrollTarget = clamp((innerHeight * .5 - (bounds.top + bounds.height * .5)) / (innerHeight + bounds.height), -.65, .65) * 230;
      }
      function render() {
        if (!orbit || !stageWidth) return;
        const phase = angle + scrollAngle;
        gallery.dataset.rotation = phase.toFixed(3);
        const small = stageWidth < 650;
        let front = 0, bestDepth = -Infinity;
        planes.forEach((plane, i) => {
          const degrees = phase + i * 120;
          const a = degrees * rad;
          const depth = Math.cos(a);
          const x = Math.sin(a) * radius;
          const y = -Math.sin(a) * (small ? 35 : 66);
          const z = depth * radius * .8;
          // Show the printed side from both halves of the orbit, never mirrored text.
          let yaw = ((degrees + 90) % 180 + 180) % 180 - 90;
          const roll = -Math.sin(a) * 3;
          plane.style.transform = `translate(-50%,-50%) translate3d(${x}px,${y}px,${z}px) rotateX(${Math.sin(a) * 2}deg) rotateY(${yaw}deg) rotateZ(${roll}deg)`;
          plane.style.setProperty('--plane-shade', String(.86 + .14 * clamp((depth + 1) / 2, 0, 1)));
          plane.dataset.orbitDepth = depth.toFixed(3);
          if (depth > bestDepth) { bestDepth = depth; front = i; }
        });
        gallery.dataset.frontProject = String(front);
        if (currentLabel && currentLabel.textContent !== names[front]) currentLabel.textContent = names[front];
      }
      function tick(now) {
        frame = 0;
        if (!orbit || !inView || document.hidden || (!running() && !drag)) { gallery.dataset.orbitPaused = 'true'; return; }
        const dt = Math.min((now - (last || now)) / 1000, .05);
        last = now;
        if (!drag) {
          angle += (12 + velocity) * dt;
          velocity *= Math.exp(-dt * 4);
          scrollAngle += (scrollTarget - scrollAngle) * (1 - Math.exp(-dt * 7));
        }
        render();
        frame = requestAnimationFrame(tick);
      }
      function startStop() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0; last = 0;
        const active = orbit && inView && !document.hidden && (running() || !!drag);
        gallery.dataset.orbitPaused = String(!active);
        if (active) frame = requestAnimationFrame(tick);
      }
      function sync() {
        const next = supported();
        if (orbit !== next) {
          orbit = next;
          gallery.classList.toggle('is-orbiting', orbit);
          gallery.dataset.galleryOrbitReady = String(orbit);
          if (controls) controls.hidden = !orbit;
          if (orbit) {
            measure(); scrollAngle = scrollTarget; render();
          } else {
            drag = null;
            planes.forEach(plane => { plane.style.removeProperty('transform'); plane.style.removeProperty('--plane-shade'); });
          }
        }
        gallery.classList.toggle('is-in-view', inView && !document.hidden);
        startStop();
      }
      function step(direction) {
        if (!orbit) return;
        const phase = angle + scrollAngle;
        const nearest = Math.round(phase / 120);
        angle = (nearest + direction) * 120 - scrollAngle;
        velocity = 0; render();
      }
      gallery.querySelector('[data-gallery-prev]')?.addEventListener('click', () => step(-1));
      gallery.querySelector('[data-gallery-next]')?.addEventListener('click', () => step(1));
      pauseButton?.addEventListener('click', () => {
        localPaused = !localPaused;
        pauseButton.setAttribute('aria-pressed', String(localPaused));
        pauseButton.setAttribute('aria-label', localPaused ? 'Start rotationen' : 'Sæt rotationen på pause');
        pauseButton.querySelector('[data-gallery-pause-icon]').textContent = localPaused ? '▷' : 'Ⅱ';
        startStop();
      });
      stage.addEventListener('pointerdown', event => {
        if (!orbit || (event.pointerType === 'mouse' && event.button !== 0) || document.body.classList.contains('effects-paused') || localPaused) return;
        drag = { id: event.pointerId, start: event.clientX, x: event.clientX, time: performance.now(), moved: false };
        velocity = 0; startStop();
      });
      stage.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) return;
        if (!drag.moved && Math.abs(event.clientX - drag.start) > 6) {
          drag.moved = true; stage.setPointerCapture(event.pointerId); gallery.classList.add('is-dragging');
        }
        if (!drag.moved) return;
        const now = performance.now(), delta = event.clientX - drag.x;
        angle += delta * .3;
        velocity = clamp(delta * .3 / Math.max(16, now - drag.time) * 1000, -110, 110);
        drag.x = event.clientX; drag.time = now;
        render();
      }, { passive: true });
      function endDrag(event) {
        if (!drag || drag.id !== event.pointerId) return;
        const moved = drag.moved;
        drag = null; gallery.classList.remove('is-dragging');
        if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
        if (moved) suppressClickUntil = performance.now() + 350;
        else velocity = 0;
        startStop();
      }
      addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
      stage.addEventListener('dragstart', event => { if (orbit) event.preventDefault(); });
      stage.addEventListener('click', event => {
        if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
      }, true);
      stage.addEventListener('focusin', event => {
        focused = event.target.matches(':focus-visible');
        const plane = event.target.closest('.project-gallery__plane');
        if (orbit && plane && plane.matches(':focus-visible')) {
          const i = planes.indexOf(plane), phase = angle + scrollAngle;
          angle = -i * 120 + Math.round((phase + i * 120) / 360) * 360 - scrollAngle;
          render();
        }
        startStop();
      });
      stage.addEventListener('focusout', event => {
        if (!stage.contains(event.relatedTarget)) { focused = false; startStop(); }
      });
      if ('IntersectionObserver' in window) new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; sync(); }).observe(stage);
      else inView = true;
      addEventListener('scroll', () => { if (orbit && inView) readScroll(); }, { passive: true });
      addEventListener('resize', () => { measure(); sync(); }, { passive: true });
      document.addEventListener('visibilitychange', sync);
      reduce.addEventListener('change', sync);
      new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
      meshes.forEach(({ original }) => original.addEventListener('load', () => { if (orbit) curveScreens(); }));
      document.fonts?.ready.then(measure);
      sync(); measure();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
