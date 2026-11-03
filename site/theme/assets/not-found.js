/* Veyro 404. Original projected geometry; no model download, WebGL or dependencies. */
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
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const unit = a => { const length = Math.hypot(...a) || 1; return a.map(n => n / length); };
    const random = n => { const f = Math.sin(n * 127.1 + 311.7) * 43758.5453; return f - Math.floor(f); };
    const rotate = (v, x, y, z = 0) => {
      const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
      const a = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
      const b = [a[0] * cy + a[2] * sy, a[1], -a[0] * sy + a[2] * cy];
      return [b[0] * cz - b[1] * sz, b[0] * sz + b[1] * cz, b[2]];
    };
    let faces = [], width = 1, height = 1, cx = 0, cy = 0, scale = 1;
    let stageRect, sectionRect, frame = 0, previousTime = 0, time = 0;
    let visible = true, holding = false, heldAt = 0, pulseUntil = 0, skipClick = false;
    let scatter = 0, targetScatter = 0, pointerX = 0, pointerY = 0, aimX = 0, aimY = 0, pointerActive = false;
    let lastState = '', failed = false;
    const enabled = () => body.classList.contains('has-motion') && !body.classList.contains('effects-paused') && !reduced.matches;
    const setState = state => { if (state !== lastState) { section.dataset.sceneState = state; lastState = state; } };

    function addFace(vertices, kind = 'front') {
      const center = [0, 0, 0];
      vertices.forEach(p => p.forEach((n, i) => { center[i] += n / vertices.length; }));
      const id = faces.length + 1;
      const direction = unit([center[0] * .45 + (random(id) - .5) * 3, center[1] * .8 + (random(id + 1) - .5) * 3, (random(id + 2) - .45) * 3]);
      faces.push({ vertices, center, kind, direction, distance: 1.9 + random(id + 4) * 3.8, spin: [random(id + 7) * 5 - 2.5, random(id + 8) * 5 - 2.5, random(id + 9) * 4 - 2], seed: random(id + 10) });
    }
    function quad(a, b, c, d, kind) { addFace([a, b, c], kind); addFace([a, c, d], kind); }
    const area2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    function triangulate(polygon) {
      const indices = polygon.map((_, i) => i), triangles = [];
      let guard = 0;
      while (indices.length > 3 && guard++ < polygon.length * polygon.length) {
        let clipped = false;
        for (let i = 0; i < indices.length; i++) {
          const ia = indices[(i + indices.length - 1) % indices.length], ib = indices[i], ic = indices[(i + 1) % indices.length];
          const a = polygon[ia], b = polygon[ib], c = polygon[ic];
          if (area2(a, b, c) <= .000001) continue;
          if (indices.some(index => index !== ia && index !== ib && index !== ic && area2(a, b, polygon[index]) >= 0 && area2(b, c, polygon[index]) >= 0 && area2(c, a, polygon[index]) >= 0)) continue;
          triangles.push([a, b, c]); indices.splice(i, 1); clipped = true; break;
        }
        if (!clipped) break;
      }
      if (indices.length === 3) triangles.push(indices.map(i => polygon[i]));
      return triangles;
    }
    function inset(polygon, amount) {
      return polygon.map((p, i) => {
        const prev = polygon[(i + polygon.length - 1) % polygon.length], next = polygon[(i + 1) % polygon.length];
        const e1 = unit([p[0] - prev[0], p[1] - prev[1], 0]), e2 = unit([next[0] - p[0], next[1] - p[1], 0]);
        const n1 = [-e1[1], e1[0]], n2 = [-e2[1], e2[0]], divisor = Math.max(.15, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
        return [p[0] + amount * (n1[0] + n2[0]) / divisor, p[1] + amount * (n1[1] + n2[1]) / divisor];
      });
    }
    function splitTriangle(triangle, z, kind, reverse = false) {
      const [a, b, c] = triangle, ab = a.map((n, i) => (n + b[i]) / 2), bc = b.map((n, i) => (n + c[i]) / 2), ca = c.map((n, i) => (n + a[i]) / 2);
      for (const part of [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]]) {
        const points = part.map(p => [p[0], p[1], z]);
        addFace(reverse ? points.reverse() : points, kind);
      }
    }
    function four(offset) {
      // An open-top 4 keeps its counter legible even when the object turns.
      const points = [[-.12, -1.5], [-.78, -1.5], [-1.65, .38], [-1.65, .95], [-.25, .95], [-.25, 1.5], [.35, 1.5], [.35, .95], [.8, .95], [.8, .38], [.35, .38], [.35, -.3], [-.25, -.3], [-.25, .38], [-.98, .38]].reverse().map(p => [p[0] + offset + .4, p[1]]);
      const inner = inset(points, .065);
      triangulate(inner).forEach(triangle => { splitTriangle(triangle, .43, 'front'); splitTriangle(triangle, -.43, 'back', true); });
      for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length, a = points[i], b = points[j], ai = inner[i], bi = inner[j];
        quad([a[0], a[1], .35], [b[0], b[1], .35], [bi[0], bi[1], .43], [ai[0], ai[1], .43], 'bevel');
        quad([b[0], b[1], -.35], [a[0], a[1], -.35], [ai[0], ai[1], -.43], [bi[0], bi[1], -.43], 'bevel');
        quad([a[0], a[1], -.35], [b[0], b[1], -.35], [b[0], b[1], .35], [a[0], a[1], .35], 'side');
      }
    }
    function zero() {
      const count = 40;
      const point = (angle, rx, ry, z) => [Math.cos(angle) * rx, Math.sin(angle) * ry, z];
      for (let i = 0; i < count; i++) {
        const a = i / count * Math.PI * 2, b = (i + 1) / count * Math.PI * 2;
        for (const z of [.43, -.43]) {
          const vertices = [point(a, 1.045, 1.455, z), point(b, 1.045, 1.455, z), point(b, .645, 1.035, z), point(a, .645, 1.035, z)];
          if (z < 0) vertices.reverse();
          quad(...vertices, z > 0 ? 'front' : 'back');
        }
        quad(point(a, 1.11, 1.52, .35), point(b, 1.11, 1.52, .35), point(b, 1.045, 1.455, .43), point(a, 1.045, 1.455, .43), 'bevel');
        quad(point(b, .58, .97, .35), point(a, .58, .97, .35), point(a, .645, 1.035, .43), point(b, .645, 1.035, .43), 'bevel');
        quad(point(b, 1.11, 1.52, -.35), point(a, 1.11, 1.52, -.35), point(a, 1.045, 1.455, -.43), point(b, 1.045, 1.455, -.43), 'bevel');
        quad(point(a, .58, .97, -.35), point(b, .58, .97, -.35), point(b, .645, 1.035, -.43), point(a, .645, 1.035, -.43), 'bevel');
        quad(point(a, 1.11, 1.52, -.35), point(b, 1.11, 1.52, -.35), point(b, 1.11, 1.52, .35), point(a, 1.11, 1.52, .35), 'side');
        quad(point(b, .58, .97, -.35), point(a, .58, .97, -.35), point(a, .58, .97, .35), point(b, .58, .97, .35), 'side');
      }
    }
    four(-2.5); zero(); four(2.5);

    function measure() {
      sectionRect = section.getBoundingClientRect(); stageRect = stage.getBoundingClientRect();
      width = Math.max(1, sectionRect.width); height = Math.max(1, sectionRect.height);
      const ratio = Math.min(devicePixelRatio || 1, width < 600 ? 1.5 : 2);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      cx = stageRect.left - sectionRect.left + stageRect.width * .5;
      cy = stageRect.top - sectionRect.top + stageRect.height * .5;
      scale = Math.min(stageRect.width * (width < 600 ? .88 : .75) / 8, stageRect.height * .78 / 3.5, 103);
      if (!frame) safeDraw();
    }
    function project(v) {
      const perspective = 9 / Math.max(4, 9 - v[2]);
      return [cx + v[0] * scale * perspective, cy + v[1] * scale * perspective];
    }
    function lines() {
      const spread = Math.max(height * .8, 500), bend = pointerX * width * .035, rise = pointerY * 20;
      ctx.lineWidth = .65;
      for (let i = -3; i <= 3; i++) {
        if (!i) continue;
        const y1 = cy + i * spread * .34, y2 = cy - i * spread * .34;
        ctx.beginPath(); ctx.moveTo(-30, y1);
        ctx.bezierCurveTo(width * .27 + bend, cy + i * 15 + rise, width * .73 + bend, cy - i * 15 + rise, width + 30, y2);
        ctx.strokeStyle = `rgba(212,193,177,${.075 + scatter * .04})`; ctx.stroke();
      }
      if (pointerActive && enabled()) {
        const x = cx + pointerX * stageRect.width * .5, y = cy + pointerY * stageRect.height * .5;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 70);
        glow.addColorStop(0, 'rgba(255,118,63,.12)'); glow.addColorStop(1, 'rgba(255,118,63,0)');
        ctx.fillStyle = glow; ctx.fillRect(x - 70, y - 70, 140, 140);
      }
    }
    function draw() {
      ctx.clearRect(0, 0, width, height);
      lines();
      const moving = enabled(), tiltX = -.10 + Math.sin(time * .28) * .065 - pointerY * .10;
      const tiltY = -.28 + Math.sin(time * .38) * .20 + pointerX * .22;
      const roll = Math.sin(time * .26) * .025;
      const burst = scatter * scatter * (3 - 2 * scatter);
      const lightX = -1.25 + pointerX * 3.5 + Math.sin(time * .42) * 1.7;
      const light = unit([-.7 + pointerX * .5, -.9 + pointerY * .25, 2.2]);
      const transformed = [];
      for (const face of faces) {
        const travel = burst * face.distance;
        const shift = face.direction.map((n, i) => n * travel + (i === 1 ? Math.sin(time * .9 + face.seed * 12) * .12 * burst : 0));
        const points = face.vertices.map(vertex => {
          const local = sub(vertex, face.center);
          const spun = rotate(local, face.spin[0] * burst, face.spin[1] * burst, face.spin[2] * burst);
          return rotate(spun.map((n, i) => n + face.center[i] + shift[i]), tiltX, tiltY, roll);
        });
        const normal = unit(cross(sub(points[1], points[0]), sub(points[2], points[0])));
        // Keep front faces when intact; fragments have a visible darker reverse surface.
        if (normal[2] <= 0 && burst < .02) continue;
        const center = points[0].map((_, i) => (points[0][i] + points[1][i] + points[2][i]) / 3);
        transformed.push({ face, points, normal, center, depth: center[2] });
      }
      transformed.sort((a, b) => a.depth - b.depth);
      // One continuous reflection across the intact front plane prevents the
      // hidden triangulation from looking like a low-poly, crumpled surface.
      const gradientStart = project(rotate([-4.3, -.9, .43], tiltX, tiltY, roll));
      const gradientEnd = project(rotate([4.3, .9, .43], tiltX, tiltY, roll));
      const reflection = ctx.createLinearGradient(...gradientStart, ...gradientEnd);
      const highlight = clamp((lightX + 4.3) / 8.6, .25, .75);
      for (const [position, color] of [
        [0, '#242729'], [highlight - .24, '#303335'],
        [highlight - .15, '#3a302c'], [highlight - .065, '#b84b24'],
        [highlight - .012, '#ff763f'], [highlight + .023, '#ffd0af'],
        [highlight + .053, '#df642f'], [highlight + .15, '#41332c'],
        [highlight + .24, '#2c3032'], [1, '#222527']
      ]) reflection.addColorStop(position, color);
      const facetBlend = clamp((burst - .025) / .28);
      const haze = ctx.createRadialGradient(cx + lightX * scale * .4, cy + scale * .5, 5, cx, cy, scale * 4.1);
      haze.addColorStop(0, `rgba(255,105,48,${.055 + burst * .035})`); haze.addColorStop(1, 'rgba(255,105,48,0)');
      ctx.fillStyle = haze; ctx.fillRect(cx - scale * 5, cy - scale * 4, scale * 10, scale * 8);
      for (const { face, points, normal, center } of transformed) {
        const facing = normal[2] < 0 ? normal.map(n => -n) : normal;
        const diffuse = Math.max(0, dot(facing, light));
        const band = Math.exp(-Math.pow((center[0] + center[1] * .45 - lightX) / 1.3, 2));
        const bevel = face.kind === 'bevel' ? 1.3 : face.kind === 'side' ? .63 : .92;
        const specular = Math.pow(Math.max(0, facing[2] * .82 - facing[1] * .42 - facing[0] * .18), 14);
        const warmth = (band * .90 + .015) * diffuse * bevel;
        const shade = 22 + diffuse * 25 + (face.kind === 'bevel' ? 10 : 0);
        const brightness = normal[2] < 0 ? .62 : 1;
        const r = Math.min(255, (shade + warmth * 207 + specular * band * 34) * brightness);
        const g = Math.min(255, (shade + warmth * 91 + specular * band * 40) * brightness);
        const b = Math.min(255, (shade + warmth * 43 + specular * band * 40) * brightness);
        const facetColor = `rgb(${r | 0},${g | 0},${b | 0})`;
        const continuous = (face.kind === 'front' || face.kind === 'back') && facetBlend < 1;
        ctx.fillStyle = continuous ? reflection : facetColor;
        ctx.beginPath(); points.forEach((p, i) => { const xy = project(p); if (!i) ctx.moveTo(...xy); else ctx.lineTo(...xy); }); ctx.closePath(); ctx.fill();
        // A matching hairline seals subpixel cracks between the planar triangles.
        ctx.lineWidth = .4; ctx.strokeStyle = ctx.fillStyle; ctx.stroke();
        if (continuous && facetBlend > 0) {
          ctx.globalAlpha = facetBlend; ctx.fillStyle = facetColor; ctx.fill(); ctx.globalAlpha = 1;
        }
      }
      if (burst > .08) {
        ctx.lineWidth = .75;
        for (let i = 0; i < 24; i++) {
          const angle = random(i + 400) * Math.PI * 2, distance = (1.5 + random(i + 500) * 3) * burst;
          const p = project([Math.cos(angle) * distance * 1.7, Math.sin(angle) * distance, random(i + 600) * 2]);
          const length = 2 + burst * random(i + 700) * 8;
          ctx.strokeStyle = `rgba(255,${142 + i % 5 * 12},${78 + i % 6 * 14},${burst * .5})`;
          ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(p[0] + Math.cos(angle) * length, p[1] + Math.sin(angle) * length); ctx.stroke();
        }
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
      if (!enabled() || !visible || document.hidden || failed) return;
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
      const running = enabled() && visible && !document.hidden && !failed;
      if (button) button.disabled = !enabled();
      if (!running) {
        cancelAnimationFrame(frame); frame = 0; previousTime = 0;
        holding = false; pulseUntil = 0; scatter = 0; targetScatter = 0;
        if (!enabled()) { aimX = aimY = pointerX = pointerY = 0; setState('paused'); }
        if (!document.hidden) safeDraw();
      } else if (!frame) { previousTime = 0; frame = requestAnimationFrame(tick); }
    }
    function position(event) {
      if (!enabled()) return;
      const rect = stage.getBoundingClientRect();
      aimX = clamp((event.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
      aimY = clamp((event.clientY - rect.top) / rect.height * 2 - 1, -1, 1); pointerActive = true;
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
    stage.addEventListener('pointerleave', () => { aimX = aimY = 0; pointerActive = false; release(); });
    button?.addEventListener('pointerdown', press, { passive: true });
    button?.addEventListener('click', event => {
      if (!enabled()) return;
      if (event.detail > 0 && skipClick) { skipClick = false; return; }
      holding = false; pulseUntil = performance.now() + 900;
    });
    window.addEventListener('pointerup', release, { passive: true });
    window.addEventListener('pointercancel', release, { passive: true });
    window.addEventListener('blur', () => { release(); aimX = aimY = 0; });
    window.addEventListener('pagehide', () => { cancelAnimationFrame(frame); frame = 0; previousTime = 0; holding = false; });
    window.addEventListener('pageshow', sync);
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
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
