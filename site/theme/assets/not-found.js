/* Veyro 404. Manrope typography formed from the same fine points as the homepage V. */
(() => {
  'use strict';
  const boot = () => {
    const section = document.querySelector('[data-not-found-scene]');
    const canvas = section?.querySelector('[data-not-found-canvas]');
    const stage = section?.querySelector('[data-not-found-stage]');
    const button = section?.querySelector('[data-not-found-burst]');
    if (!section || !canvas || !stage) return;
    let ctx;
    try { ctx = canvas.getContext('2d', { alpha: true }); } catch (_) { return; }
    if (!ctx) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const body = document.body;
    const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));
    const mix = (a, b, t) => a + (b - a) * t;
    const random = n => { const f = Math.sin(n * 127.1 + 311.7) * 43758.5453; return f - Math.floor(f); };
    const rotate = (v, x, y, z = 0) => {
      const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
      const a = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
      const b = [a[0] * cy + a[2] * sy, a[1], -a[0] * sy + a[2] * cy];
      return [b[0] * cz - b[1] * sz, b[0] * sz + b[1] * cz, b[2]];
    };
    let points = [], geometryReady = false, pageActive = true, width = 1, height = 1, cx = 0, cy = 0, scale = 1;
    let stageRect, sectionRect, frame = 0, previousTime = 0, time = 0;
    let visible = true, holding = false, heldAt = 0, pulseUntil = 0, skipClick = false;
    let scatter = 0, targetScatter = 0, pointerX = 0, pointerY = 0, aimX = 0, aimY = 0;
    let lastState = '', failed = false;
    const enabled = () => body.classList.contains('has-motion') && !body.classList.contains('effects-paused') && !reduced.matches;
    const setState = state => { if (state !== lastState) { section.dataset.sceneState = state; lastState = state; } };

    function buildTypography() {
      if (failed || geometryReady) return;
      try {
        // Sample the site's own font once. No alternative display font or downloaded model.
        const stencil = document.createElement('canvas');
        stencil.width = 1000; stencil.height = 440;
        const ink = stencil.getContext('2d', { willReadFrequently: true });
        if (!ink) return;
        ink.font = '400 360px "Manrope", sans-serif';
        ink.textAlign = 'center'; ink.textBaseline = 'middle'; ink.fillStyle = '#fff';
        ink.fillText('404', 500, 220);
        const pixels = ink.getImageData(0, 0, 1000, 440).data;
        const samples = [];
        let minX = 1000, maxX = 0, minY = 440, maxY = 0;
        for (let y = 0; y < 440; y += 5) {
          for (let x = 0; x < 1000; x += 5) {
            if (pixels[(y * 1000 + x) * 4 + 3] < 140) continue;
            samples.push([x, y]);
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
          }
        }
        if (samples.length < 30) return;
        const unit = 3 / Math.max(1, maxY - minY), midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
        points = samples.map(([x, y], i) => {
          const seed = random(i + 1), angle = random(i + 23) * Math.PI * 2;
          return {
            x: (x - midX) * unit, y: (y - midY) * unit, z: Math.sin(x * .02) * .025,
            seed, dx: Math.cos(angle) * (1.8 + random(i + 17) * 3.6),
            dy: Math.sin(angle) * (1.8 + random(i + 41) * 2.6), dz: (random(i + 53) - .5) * 5,
          };
        });
        geometryReady = true;
        measure(); sync();
      } catch (_) {
        // Keep the real, readable HTML typography if font sampling is unavailable.
        geometryReady = false;
      }
    }

    function measure() {
      sectionRect = section.getBoundingClientRect(); stageRect = stage.getBoundingClientRect();
      width = Math.max(1, sectionRect.width); height = Math.max(1, sectionRect.height);
      const ratio = Math.min(devicePixelRatio || 1, width < 600 ? 1.5 : 2);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      cx = stageRect.left - sectionRect.left + stageRect.width * .5;
      cy = stageRect.top - sectionRect.top + stageRect.height * .5;
      scale = Math.min(stageRect.width * (width < 600 ? .88 : .75) / 8, stageRect.height * .78 / 3.5, 103);
      if (!frame && pageActive && !document.hidden) safeDraw();
    }
    function project(v) {
      const perspective = 9 / Math.max(4, 9 - v[2]);
      return [cx + v[0] * scale * perspective, cy + v[1] * scale * perspective];
    }
    function draw() {
      if (!geometryReady) return;
      ctx.clearRect(0, 0, width, height);
      const moving = enabled();
      const tiltX = Math.sin(time * .28) * .035 - pointerY * .08;
      const tiltY = -.08 + Math.sin(time * .32) * .09 + pointerX * .18;
      const burst = scatter * scatter * (3 - 2 * scatter);
      const projected = [];
      for (const point of points) {
        const drift = Math.sin(time * .7 + point.seed * 12) * .12 * burst;
        const vertex = rotate([
          point.x + point.dx * burst,
          point.y + point.dy * burst + drift,
          point.z + point.dz * burst,
        ], tiltX, tiltY);
        const perspective = 9 / Math.max(4, 9 - vertex[2]);
        projected.push({ point, vertex, xy: project(vertex), perspective });
      }
      projected.sort((a, b) => a.vertex[2] - b.vertex[2]);
      for (const { point, vertex, xy, perspective } of projected) {
        const radius = clamp(scale * .018 * perspective, .95, 2.3);
        const depth = clamp((vertex[2] + 3) / 6);
        const shimmer = .94 + Math.sin(point.x * .9 + time * .45) * .05;
        // Quiet ivory typography. A few orange points echo the Veyro logo's dot.
        const accent = point.seed > .97 || (burst > .1 && point.seed > .73);
        ctx.fillStyle = accent
          ? `rgba(255,142,91,${.7 + depth * .25})`
          : `rgba(246,245,242,${(.68 + depth * .30) * shimmer})`;
        ctx.beginPath(); ctx.arc(xy[0], xy[1], radius, 0, Math.PI * 2); ctx.fill();
      }
      section.classList.add('is-scene-ready');
      if (!moving) setState('paused');
    }
    function safeDraw() {
      if (failed) return;
      try { draw(); } catch (_) {
        failed = true; cancelAnimationFrame(frame); frame = 0;
        section.classList.remove('is-scene-ready');
        canvas.hidden = true;
        if (button) button.hidden = true;
      }
    }
    function tick(timestamp) {
      frame = 0;
      if (!enabled() || !visible || !pageActive || document.hidden || failed || !geometryReady) return;
      const dt = Math.min((timestamp - (previousTime || timestamp)) / 1000, .035); previousTime = timestamp; time += dt;
      pointerX = mix(pointerX, aimX, 1 - Math.exp(-dt * 6)); pointerY = mix(pointerY, aimY, 1 - Math.exp(-dt * 6));
      const pulsing = timestamp < pulseUntil;
      targetScatter = holding ? clamp((timestamp - heldAt) / 700) : pulsing ? 1 : 0;
      scatter = mix(scatter, targetScatter, 1 - Math.exp(-dt * (holding || pulsing ? 9 : 5)));
      if (scatter < .001 && !holding && !pulsing) scatter = 0;
      setState(holding || pulsing ? scatter > .85 ? 'scattered' : 'charging' : scatter > .01 ? 'returning' : 'idle');
      safeDraw();
      if (!failed) frame = requestAnimationFrame(tick);
    }
    function sync() {
      const running = enabled() && visible && pageActive && !document.hidden && !failed && geometryReady;
      if (button) button.disabled = !enabled();
      if (!running) {
        cancelAnimationFrame(frame); frame = 0; previousTime = 0;
        holding = false; pulseUntil = 0; scatter = 0; targetScatter = 0;
        if (!enabled()) { aimX = aimY = pointerX = pointerY = 0; setState('paused'); }
        if (!document.hidden && pageActive) safeDraw();
      } else if (!frame) { previousTime = 0; frame = requestAnimationFrame(tick); }
    }
    function position(event) {
      if (!enabled()) return;
      const rect = stage.getBoundingClientRect();
      aimX = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      aimY = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1);
    }
    function press(event) {
      if (!enabled() || (event.button !== undefined && event.button !== 0)) return;
      if (event.target.closest('a,input,select,textarea,summary') || (event.target.closest('button') && event.target.closest('button') !== button)) return;
      holding = true; heldAt = performance.now(); pulseUntil = 0; skipClick = false;
      if (event.currentTarget === stage) position(event);
    }
    function release() { if (holding) { skipClick = performance.now() - heldAt > 180; holding = false; } }
    stage.addEventListener('pointermove', position, { passive: true });
    stage.addEventListener('pointerdown', press, { passive: true });
    stage.addEventListener('pointerleave', () => { aimX = aimY = 0; release(); });
    button?.addEventListener('pointerdown', press, { passive: true });
    button?.addEventListener('click', event => {
      if (!enabled()) return;
      if (event.detail > 0 && skipClick) { skipClick = false; return; }
      holding = false; pulseUntil = performance.now() + 900;
    });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('blur', () => { release(); aimX = aimY = 0; });
    window.addEventListener('pagehide', () => { pageActive = false; cancelAnimationFrame(frame); frame = 0; previousTime = 0; holding = false; });
    window.addEventListener('pageshow', () => { pageActive = true; sync(); });
    window.addEventListener('resize', measure, { passive: true });
    reduced.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    new MutationObserver(sync).observe(body, { attributes: true, attributeFilter: ['class'] });
    if ('ResizeObserver' in window) {
      const layoutObserver = new ResizeObserver(measure);
      layoutObserver.observe(stage); layoutObserver.observe(section);
    }
    if ('IntersectionObserver' in window) new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }, { threshold: 0 }).observe(section);
    measure(); sync();
    if (document.fonts?.load) {
      document.fonts.load('400 360px "Manrope"', '404').then(buildTypography).catch(() => {});
    } else buildTypography();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
