/* Native-scroll helix. Every preview remains a real link; there is no autoplay or scroll interception. */
(() => {
  'use strict';
  const instances = new WeakMap();
  const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
  const planeProperties = ['--x', '--y', '--z', '--rotate-y', '--plane-opacity', '--plane-shade'];
  const rootProperties = ['--gallery-steps', '--gallery-scroll-height', '--gallery-card-width', '--gallery-radius', '--gallery-progress', '--gallery-accent', '--gallery-depth-step', '--gallery-depth-y', '--gallery-light-y', '--gallery-pin-y'];
  const safeURL = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = new URL(value, document.baseURI || window.location.href);
      return ['http:', 'https:'].includes(parsed.protocol) ? value : null;
    } catch (_) { return null; }
  };

  class VeyroHelixShowcase {
    constructor(root, demos) {
      if (!root?.querySelector) throw new TypeError('VeyroHelixShowcase requires a gallery element.');
      if (instances.has(root)) {
        const instance = instances.get(root);
        if (Array.isArray(demos)) instance.setDemos(demos);
        return instance;
      }
      this.root = root;
      this.track = root.querySelector('[data-gallery-track]') || root;
      this.pin = root.querySelector('[data-gallery-pin]');
      this.stage = root.querySelector('[data-gallery-stage]');
      if (!this.pin || !this.stage) return;
      this.title = root.querySelector('[data-gallery-title]');
      this.category = root.querySelector('[data-gallery-category]');
      this.description = root.querySelector('[data-gallery-description]');
      this.count = root.querySelector('[data-gallery-count]');
      this.open = root.querySelector('[data-gallery-open]');
      this.depth = root.querySelector('[data-gallery-depth]');
      this.depthMarks = []; this.pinHeight = 0; this.depthStep = 0;
      this.reduce = matchMedia('(prefers-reduced-motion: reduce)');
      this.frame = 0; this.dirty = true; this.needsMeasure = true; this.destroyed = false;
      this.pageActive = true; this.inView = false; this.enhanced = false;
      this.focusIndex = null; this.focusPosition = null; this.position = 0; this.focusElement = null; this.activeIndex = -1;
      this.step = 1; this.range = 1; this.top = 0; this.stickyTop = 0;
      this.radius = 0; this.pitch = 0; this.planes = []; this.demos = [];
      this.cleanups = [];
      this.originalRootProperties = rootProperties.map(property => [property, root.style.getPropertyValue(property)]);
      this.stickySupported = !window.CSS?.supports || CSS.supports('position', 'sticky');
      this.depthSupported = !window.CSS?.supports || CSS.supports('transform-style', 'preserve-3d');
      instances.set(root, this);
      if (Array.isArray(demos)) this.replaceCards(demos);
      this.readCards();
      const listen = (target, type, callback, options) => {
        target.addEventListener(type, callback, options);
        this.cleanups.push(() => target.removeEventListener(type, callback, options));
      };
      listen(window, 'scroll', () => {
        if (!this.intersectionObserver) {
          const bounds = this.track.getBoundingClientRect();
          this.inView = bounds.bottom > 0 && bounds.top < window.innerHeight;
        }
        this.invalidate();
      }, { passive: true });
      listen(window, 'resize', () => this.invalidate(true), { passive: true });
      listen(window, 'load', () => this.invalidate(true));
      listen(document, 'visibilitychange', () => {
        if (document.hidden) this.cancel();
        else this.invalidate(true);
      });
      listen(window, 'pagehide', () => { this.pageActive = false; this.cancel(); });
      listen(window, 'pageshow', () => { this.pageActive = true; this.invalidate(true); });
      listen(this.reduce, 'change', () => this.invalidate());
      listen(root, 'focusin', event => this.onFocus(event));
      listen(root, 'focusout', event => {
        if (this.focusElement?.contains(event.relatedTarget)) return;
        this.focusIndex = null; this.focusPosition = null; this.focusElement = null;
        this.invalidate();
      });
      this.mutationObserver = new MutationObserver(() => this.invalidate());
      this.mutationObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      if ('ResizeObserver' in window) {
        this.resizeObserver = new ResizeObserver(() => this.invalidate(true));
        this.resizeObserver.observe(this.pin); this.resizeObserver.observe(this.stage);
      }
      if ('IntersectionObserver' in window) {
        this.intersectionObserver = new IntersectionObserver(entries => {
          this.inView = entries[0].isIntersecting;
          if (this.inView) this.invalidate(true);
          else this.cancel();
        });
        this.intersectionObserver.observe(this.track);
      }
      if (document.fonts?.ready) document.fonts.ready.then(() => this.invalidate(true)).catch(() => {});
      this.measure();
      this.onFocus({ target: document.activeElement });
      this.cancel(); this.render();
    }

    replaceCards(demos) {
      this.stage.querySelectorAll('.project-gallery__plane').forEach(plane => plane.remove());
      const container = this.stage.querySelector('[data-gallery-world]') || this.stage;
      demos.forEach(demo => {
        const url = safeURL(demo?.url), image = safeURL(demo?.previewImage);
        if (!url || !image || typeof demo?.title !== 'string') return;
        const plane = document.createElement('a');
        plane.className = 'project-gallery__plane'; plane.href = url;
        for (const key of ['title', 'category', 'description', 'accent']) plane.dataset[`demo${key[0].toUpperCase()}${key.slice(1)}`] = String(demo[key] || '');
        const figure = document.createElement('figure'); figure.className = 'project-gallery__surface';
        const frame = document.createElement('div'); frame.className = 'project-gallery__image';
        const img = document.createElement('img'); img.src = image; img.alt = demo.title;
        img.width = 1600; img.height = 1000; img.loading = 'lazy'; img.decoding = 'async';
        frame.append(img);
        const caption = document.createElement('figcaption');
        for (const key of ['title', 'category', 'description']) {
          const span = document.createElement(key === 'description' ? 'p' : 'span'); span.textContent = String(demo[key] || '');
          span.dataset[`demo${key[0].toUpperCase()}${key.slice(1)}Text`] = '';
          caption.append(span);
        }
        figure.append(frame, caption); plane.append(figure); container.append(plane);
      });
    }

    readCards() {
      this.planes = [...this.stage.querySelectorAll('.project-gallery__plane')];
      this.demos = this.planes.map(plane => ({
        title: plane.dataset.demoTitle || plane.querySelector('figcaption > span')?.textContent.trim() || plane.querySelector('img')?.alt || 'Demo',
        category: plane.dataset.demoCategory || '', description: plane.dataset.demoDescription || '',
        accent: plane.dataset.demoAccent || '#ff763f', previewImage: plane.querySelector('img')?.getAttribute('src') || '',
        url: safeURL(plane.getAttribute('href')) || '/',
      }));
      this.originalPlanes = this.planes.map(plane => ({
        tabindex: plane.getAttribute('tabindex'), ariaHidden: plane.getAttribute('aria-hidden'), active: plane.getAttribute('data-gallery-active'), inert: plane.inert,
        visibility: plane.style.visibility, pointerEvents: plane.style.pointerEvents,
        properties: planeProperties.map(property => [property, plane.style.getPropertyValue(property)]),
      }));
      this.root.style.setProperty('--gallery-steps', String(Math.max(1, this.planes.length)));
      // Decorative depth markers follow the same validated collection as the
      // previews. They contain only numbers and never become interactive.
      this.depthMarks.forEach(mark => mark.remove());
      this.depthMarks = [];
      if (this.depth) this.demos.forEach((_, index) => {
        const mark = document.createElement('span');
        mark.className = 'project-gallery__depth-mark';
        mark.textContent = String(index + 1).padStart(2, '0');
        mark.style.setProperty('--depth-index', String(index));
        this.depth.append(mark); this.depthMarks.push(mark);
      });
      this.activeIndex = -1; this.focusIndex = null; this.focusPosition = null; this.focusElement = null;
    }

    setDemos(demos) {
      if (this.destroyed || !Array.isArray(demos)) return;
      // Do not remove a control that currently owns keyboard focus.
      if (this.stage.contains(document.activeElement) || this.open?.contains(document.activeElement)) return;
      this.replaceCards(demos); this.readCards(); this.measure(); this.render();
    }

    mode() {
      return this.depthSupported && document.body.classList.contains('has-motion') && !document.body.classList.contains('effects-paused') && !this.reduce.matches ? '3d' : 'reduced';
    }

    measure() {
      if (this.destroyed) return;
      this.needsMeasure = false;
      const viewport = window.innerHeight || document.documentElement.clientHeight;
      const cssTop = parseFloat(getComputedStyle(this.pin).top);
      const header = document.querySelector('.site-header')?.getBoundingClientRect().height || 0;
      this.stickyTop = Number.isFinite(cssTop) ? Math.max(0, cssTop) : header;
      // On short landscape screens the normal document grid is more usable than
      // a sticky panel taller than the viewport. Native links stay available.
      let canEnhance = this.stickySupported && this.planes.length > 0 && viewport - this.stickyTop >= 460;
      this.root.classList.toggle('is-helix-ready', canEnhance);
      if (canEnhance) {
        const actualTop = parseFloat(getComputedStyle(this.pin).top);
        if (Number.isFinite(actualTop)) this.stickyTop = Math.max(0, actualTop);
        canEnhance = this.pin.getBoundingClientRect().height <= viewport - this.stickyTop + 1;
        this.root.classList.toggle('is-helix-ready', canEnhance);
      }
      this.enhanced = canEnhance;
      if (!canEnhance) {
        this.root.style.removeProperty('--gallery-scroll-height');
        this.root.style.setProperty('--gallery-depth-y', '0px');
        this.root.style.setProperty('--gallery-light-y', '0px');
        this.root.style.setProperty('--gallery-pin-y', '0px');
        this.restorePlanes();
        const rect = this.track.getBoundingClientRect();
        this.inView = rect.bottom > 0 && rect.top < viewport;
        return;
      }
      const pin = this.pin.getBoundingClientRect(), stage = this.stage.getBoundingClientRect();
      this.step = Math.max(320, viewport - this.stickyTop);
      const height = pin.height + Math.max(1, this.planes.length - 1) * this.step;
      this.root.style.setProperty('--gallery-scroll-height', `${Math.ceil(height)}px`);
      const mobile = stage.width < 650;
      const cardWidth = Math.max(1, Math.min(stage.width * (mobile ? .96 : .78), stage.height * 1.6 * .92, 1080));
      this.pinHeight = pin.height; this.depthStep = pin.height * .78;
      this.root.style.setProperty('--gallery-depth-step', `${this.depthStep.toFixed(2)}px`);
      this.radius = stage.width * .35; this.pitch = stage.height * .56;
      this.root.style.setProperty('--gallery-card-width', `${cardWidth.toFixed(2)}px`);
      this.root.style.setProperty('--gallery-radius', `${this.radius.toFixed(2)}px`);
      const track = this.track.getBoundingClientRect();
      this.top = track.top + window.scrollY;
      this.range = Math.max(1, track.height - pin.height);
      this.inView = track.bottom > 0 && track.top < viewport;
    }

    onFocus(event) {
      if (!event.target || this.destroyed) return;
      const plane = event.target.closest?.('.project-gallery__plane');
      const index = this.planes.indexOf(plane);
      if (index >= 0) { this.focusIndex = index; this.focusElement = plane; }
      else if (this.open?.contains(event.target)) { this.focusIndex = Math.max(0, this.activeIndex); this.focusElement = this.open; }
      else { this.focusIndex = null; this.focusPosition = null; this.focusElement = null; }
      if (this.focusIndex !== null) {
        // Center keyboard focus for readability. A pointer must keep the exact
        // position it pressed, otherwise a mobile preview can jump before release.
        this.focusPosition = this.focusElement.matches?.(':focus-visible') ? this.focusIndex : this.position;
      }
      this.invalidate();
    }

    invalidate(measure = false) {
      if (this.destroyed) return;
      this.dirty = true; this.needsMeasure ||= measure;
      if (measure && !this.intersectionObserver) {
        const bounds = this.track.getBoundingClientRect();
        this.inView = bounds.bottom > 0 && bounds.top < window.innerHeight;
      }
      if (!this.pageActive || document.hidden || !this.inView) return;
      if (!this.frame) this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        if (this.destroyed || !this.pageActive || document.hidden || !this.inView) return;
        if (this.needsMeasure) this.measure();
        this.render();
      });
    }

    render() {
      if (this.destroyed || !this.enhanced || !this.planes.length || document.hidden || !this.pageActive) return;
      this.dirty = false;
      // One layout read per dirty scroll frame also accounts for content above
      // the gallery changing height after a font or an image finishes loading.
      this.top = this.track.getBoundingClientRect().top + window.scrollY;
      const rawProgress = (window.scrollY - this.top + this.stickyTop) / this.range;
      const progress = clamp(rawProgress), mode = this.mode();
      const last = Math.max(0, this.planes.length - 1);
      const continuous = last && mode === '3d' && document.body.classList.contains('template-index');
      // On the homepage the screw path carries through the sticky boundaries.
      // The first/last preview continues approaching/leaving while the document
      // scrolls, rather than freezing as the neighboring content arrives.
      const travel = continuous
        ? clamp(rawProgress * last, -.78, last + .78)
        : progress * last;
      // Ease the *geometry* of sticky entry/release, not the scroll input. Native
      // sticky changes velocity instantly at each edge; this short quadratic
      // bridge gives the scene a continuous velocity as the document takes over.
      const bridge = Math.min(160, this.pinHeight * .22);
      const edge = distance => Math.abs(distance) < bridge
        ? Math.pow(bridge - Math.abs(distance), 2) / (4 * bridge) : 0;
      const pinY = continuous ? edge(rawProgress * this.range) - edge((rawProgress - 1) * this.range) : 0;
      this.root.style.setProperty('--gallery-pin-y', `${pinY.toFixed(3)}px`);
      // Direct travel: every scroll delta moves the previews, including
      // through the face-on position. There are no hold windows or snapping.
      let position = travel;
      if (this.focusIndex !== null) position = this.focusPosition ?? this.focusIndex;
      this.position = position;
      const active = clamp(Math.round(position), 0, last);
      this.root.dataset.galleryMode = mode;
      this.root.dataset.galleryProgress = progress.toFixed(4);
      this.root.style.setProperty('--gallery-progress', progress.toFixed(4));
      // Background layers share native progress at their own depth speeds.
      // Keyboard focus protects the current link without freezing the environment.
      const depthY = mode === '3d' ? this.pinHeight * .08 - travel * this.depthStep : 0;
      const lightY = mode === '3d' ? (.5 - (last ? travel / last : progress)) * this.pinHeight * .35 : 0;
      this.root.style.setProperty('--gallery-depth-y', `${depthY.toFixed(2)}px`);
      this.root.style.setProperty('--gallery-light-y', `${lightY.toFixed(2)}px`);
      this.root.dataset.activeDemo = String(active);
      this.root.dataset.galleryFocusLocked = String(this.focusIndex !== null);
      this.planes.forEach((plane, index) => {
        const offset = index - position, angle = offset * 96, radians = angle * Math.PI / 180;
        const opacity = clamp(1 - Math.abs(offset) / .78);
        const interactive = index === active;
        plane.style.setProperty('--x', `${mode === '3d' ? Math.sin(radians) * this.radius : 0}px`);
        plane.style.setProperty('--y', `${mode === '3d' ? -offset * this.pitch : 0}px`);
        plane.style.setProperty('--z', `${mode === '3d' ? (Math.cos(radians) - 1) * this.radius : 0}px`);
        plane.style.setProperty('--rotate-y', `${mode === '3d' ? angle : 0}deg`);
        plane.style.setProperty('--plane-opacity', opacity.toFixed(4));
        plane.style.setProperty('--plane-shade', (mode === '3d' ? .76 + .24 * Math.max(0, Math.cos(radians)) : 1).toFixed(4));
        plane.style.visibility = opacity > .001 ? 'visible' : 'hidden';
        plane.style.pointerEvents = interactive ? 'auto' : 'none';
        plane.dataset.galleryActive = String(interactive);
        plane.tabIndex = interactive ? 0 : -1;
        plane.inert = !interactive;
        plane.setAttribute('aria-hidden', String(!interactive));
      });
      if (active !== this.activeIndex) {
        this.activeIndex = active;
        const demo = this.demos[active];
        if (this.title) this.title.textContent = demo.title;
        if (this.category) this.category.textContent = demo.category;
        if (this.description) this.description.textContent = demo.description;
        if (this.count) this.count.textContent = `${String(active + 1).padStart(2, '0')} / ${String(this.planes.length).padStart(2, '0')}`;
        if (this.open) this.open.setAttribute('href', demo.url);
        const accent = window.CSS?.supports && CSS.supports('color', demo.accent) ? demo.accent : '#ff763f';
        this.root.style.setProperty('--gallery-accent', accent);
      }
    }

    cancel() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = 0; this.dirty = true;
    }

    restorePlanes() {
      this.planes.forEach((plane, index) => {
        const original = this.originalPlanes[index];
        for (const [name, value] of [['tabindex', original.tabindex], ['aria-hidden', original.ariaHidden], ['data-gallery-active', original.active]]) {
          if (value === null) plane.removeAttribute(name); else plane.setAttribute(name, value);
        }
        plane.inert = original.inert;
        plane.style.visibility = original.visibility; plane.style.pointerEvents = original.pointerEvents;
        original.properties.forEach(([property, value]) => {
          if (value) plane.style.setProperty(property, value); else plane.style.removeProperty(property);
        });
      });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.cancel();
      this.cleanups.forEach(cleanup => cleanup());
      this.mutationObserver?.disconnect(); this.resizeObserver?.disconnect(); this.intersectionObserver?.disconnect();
      this.restorePlanes(); this.root.classList.remove('is-helix-ready');
      this.depthMarks.forEach(mark => mark.remove()); this.depthMarks = [];
      this.originalRootProperties.forEach(([property, value]) => {
        if (value) this.root.style.setProperty(property, value); else this.root.style.removeProperty(property);
      });
      for (const name of ['galleryMode', 'galleryProgress', 'activeDemo', 'galleryFocusLocked']) delete this.root.dataset[name];
      instances.delete(this.root);
    }
  }

  window.VeyroHelixShowcase = VeyroHelixShowcase;
  const init = () => document.querySelectorAll('[data-project-gallery]').forEach(root => new VeyroHelixShowcase(root));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
