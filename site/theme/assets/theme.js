/*
 * Veyro – tema-JavaScript
 * Ingen afhængigheder. Alt er progressiv forbedring: siden virker uden JS.
 * Moduler: header, reveal, tabs, filter, formularer, cookies, varianter.
 */
(() => {
  'use strict';

  const strings = (() => {
    try {
      return JSON.parse(document.getElementById('ThemeStrings')?.textContent || '{}');
    } catch (e) {
      return {};
    }
  })();
  const fmt = (tpl = '', vars = {}) => tpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : ''));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /* ---------- Header og mobilmenu ---------- */
  function initHeader() {
    const header = document.querySelector('[data-header]');
    if (!header) return;

    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = header.querySelector('[data-nav-toggle]');
    const panel = header.querySelector('[data-mobile-nav]');
    if (!toggle || !panel) return;
    const label = toggle.querySelector('[data-nav-toggle-label]');

    const setOpen = (open, returnFocus = true) => {
      toggle.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
      document.documentElement.classList.toggle('nav-open', open);
      if (label) label.textContent = open ? strings.closeMenu : strings.openMenu;
      if (open) {
        panel.querySelector('a')?.focus();
      } else if (returnFocus) {
        toggle.focus();
      }
    };

    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) setOpen(false);
    });
    panel.addEventListener('click', (e) => {
      if (e.target.closest('a')) setOpen(false, false);
    });
    window.matchMedia('(min-width: 990px)').addEventListener('change', (e) => {
      if (e.matches && !panel.hidden) setOpen(false, false);
    });
  }

  /* ---------- Diskrete scroll-animationer ---------- */
  let revealObserver;
  function initReveal(root = document) {
    const enabled = document.body.classList.contains('has-motion') && !reducedMotion.matches && 'IntersectionObserver' in window;
    const items = root.querySelectorAll('[data-reveal]:not(.is-visible)');
    if (!enabled) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    document.documentElement.classList.add('reveal-ready');
    revealObserver =
      revealObserver ||
      new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              revealObserver.unobserve(entry.target);
            }
          });
        },
        { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
      );
    items.forEach((el) => revealObserver.observe(el));
  }

  /* ---------- Faneblade (ARIA tabs) ---------- */
  function initTabs(root = document) {
    root.querySelectorAll('[data-tabs]').forEach((wrap) => {
      if (wrap.dataset.tabsReady) return;
      wrap.dataset.tabsReady = 'true';
      const tabs = Array.from(wrap.querySelectorAll('[role="tab"]'));
      if (!tabs.length) return;
      wrap.classList.add('tabs-ready');

      const select = (tab, focus = false) => {
        tabs.forEach((t) => {
          const selected = t === tab;
          t.setAttribute('aria-selected', String(selected));
          t.tabIndex = selected ? 0 : -1;
          const panel = document.getElementById(t.getAttribute('aria-controls'));
          if (panel) panel.hidden = !selected;
        });
        if (focus) tab.focus();
      };

      select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0]);

      tabs.forEach((tab, i) => {
        tab.addEventListener('click', () => select(tab));
        tab.addEventListener('keydown', (e) => {
          const vertical = tab.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
          const next = vertical ? 'ArrowDown' : 'ArrowRight';
          const prev = vertical ? 'ArrowUp' : 'ArrowLeft';
          let target;
          if (e.key === next || (!vertical && e.key === 'ArrowDown') || (vertical && e.key === 'ArrowRight')) target = tabs[(i + 1) % tabs.length];
          if (e.key === prev || (!vertical && e.key === 'ArrowUp') || (vertical && e.key === 'ArrowLeft')) target = tabs[(i - 1 + tabs.length) % tabs.length];
          if (e.key === 'Home') target = tabs[0];
          if (e.key === 'End') target = tabs[tabs.length - 1];
          if (target) {
            e.preventDefault();
            select(target, true);
          }
        });
      });

      // Vertikal tabliste på store skærme
      const list = wrap.querySelector('[role="tablist"]');
      if (list && wrap.closest('.problems')) {
        const mq = window.matchMedia('(min-width: 990px)');
        const setOrientation = () => list.setAttribute('aria-orientation', mq.matches ? 'vertical' : 'horizontal');
        setOrientation();
        mq.addEventListener('change', setOrientation);
      }
    });
  }

  /* ---------- Filter (optimeringsområder) ---------- */
  function initFilters(root = document) {
    root.querySelectorAll('[data-filter]').forEach((group) => {
      if (group.dataset.filterReady) return;
      group.dataset.filterReady = 'true';
      const list = document.getElementById(group.dataset.filter);
      if (!list) return;
      const status = group.parentElement.querySelector('[data-filter-status]');
      const buttons = group.querySelectorAll('[data-filter-value]');
      group.hidden = false;

      buttons.forEach((btn) =>
        btn.addEventListener('click', () => {
          const value = btn.dataset.filterValue;
          buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
          let shown = 0;
          list.querySelectorAll('[data-scope]').forEach((item) => {
            const match = value === 'all' || item.dataset.scope.split(' ').includes(value);
            item.hidden = !match;
            if (match) shown += 1;
          });
          if (status) status.textContent = `${shown} / ${list.children.length}`;
        })
      );
    });
  }

  /* ---------- Formularvalidering (dansk) ---------- */
  // „Custom Shopify-løsning“ -> „custom-shopify-loesning“ (bruges til ?ydelse=)
  const slugify = (s) =>
    s
      .toLowerCase()
      .replace(/æ/g, 'ae')
      .replace(/ø/g, 'oe')
      .replace(/å/g, 'aa')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const URL_RE = /^(https?:\/\/)?([a-z0-9æøå-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

  function fieldLabel(el) {
    return el.dataset.label || el.closest('[data-label]')?.dataset.label || el.name;
  }

  function validateField(el) {
    const value = (el.value || '').trim();
    const label = fieldLabel(el);
    if (el.type === 'checkbox') return el.required && !el.checked ? strings.consentMissing : '';
    if (el.required && !value) return el.tagName === 'SELECT' ? fmt(strings.selectMissing, { field: label }) : fmt(strings.valueMissing, { field: label });
    if (!value) return '';
    if (el.type === 'email' && !EMAIL_RE.test(value)) return strings.typeEmail;
    if (el.dataset.type === 'url' && !URL_RE.test(value)) return strings.typeUrl;
    if (el.minLength > 0 && value.length < el.minLength) return fmt(strings.tooShort, { field: label, min: el.minLength });
    if (el.maxLength > 0 && value.length > el.maxLength) return fmt(strings.tooLong, { field: label, max: el.maxLength });
    return '';
  }

  function showError(target, errorEl, message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
    target.toggleAttribute('aria-invalid', !!message);
    if (message) target.setAttribute('aria-invalid', 'true');
    target.closest('.field')?.classList.toggle('has-error', !!message);
  }

  function errorElFor(el) {
    const id = (el.getAttribute('aria-describedby') || '').split(' ').find((x) => x.endsWith('-error'));
    return id ? document.getElementById(id) : null;
  }

  function initForms(root = document) {
    root.querySelectorAll('form.js-validate').forEach((form) => {
      if (form.dataset.validateReady) return;
      form.dataset.validateReady = 'true';
      const summary = form.querySelector('[data-error-summary]');
      const fields = () => Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="radio"]), select, textarea'));
      const groups = () => Array.from(form.querySelectorAll('[data-required-group]'));

      const checkGroup = (group) => {
        const checked = group.querySelector('input:checked');
        const msg = checked ? '' : fmt(strings.valueMissing, { field: group.dataset.label });
        showError(group, errorElFor(group), msg);
        return msg;
      };

      form.addEventListener('submit', (e) => {
        const errors = [];
        fields().forEach((el) => {
          const msg = validateField(el);
          showError(el, errorElFor(el), msg);
          if (msg) errors.push({ el, msg });
        });
        groups().forEach((g) => {
          const msg = checkGroup(g);
          if (msg) errors.push({ el: g.querySelector('input'), msg });
        });

        if (errors.length) {
          e.preventDefault();
          if (summary) {
            summary.innerHTML = '';
            const h = document.createElement('p');
            h.className = 'form__error-title';
            h.textContent = strings.errorSummary || strings.errorHeading;
            const ul = document.createElement('ul');
            errors.forEach(({ el, msg }) => {
              const li = document.createElement('li');
              const a = document.createElement('a');
              a.href = `#${el.id || ''}`;
              a.textContent = msg;
              a.addEventListener('click', (ev) => {
                ev.preventDefault();
                el.focus();
              });
              li.appendChild(a);
              ul.appendChild(li);
            });
            summary.append(h, ul);
            summary.hidden = false;
            summary.focus();
          } else {
            errors[0].el.focus();
          }
          return;
        }

        if (summary) summary.hidden = true;
        // Normalisér webshop-URL'er uden protokol, så linket virker i e-mailen
        form.querySelectorAll('[data-type="url"]').forEach((el) => {
          const v = el.value.trim();
          if (v && !/^https?:\/\//i.test(v)) el.value = `https://${v}`;
        });
        const btn = form.querySelector('[data-submit]');
        if (btn) {
          btn.disabled = true;
          btn.setAttribute('aria-busy', 'true');
          const span = btn.querySelector('span');
          if (span) span.textContent = strings.sending;
        }
      });

      // Ryd fejl, når feltet rettes
      form.addEventListener('input', (e) => {
        const el = e.target;
        if (el.type === 'radio') {
          const g = el.closest('[data-required-group]');
          if (g) checkGroup(g);
          return;
        }
        if (el.getAttribute('aria-invalid') === 'true') showError(el, errorElFor(el), validateField(el));
      });
      form.addEventListener(
        'blur',
        (e) => {
          const el = e.target;
          if (!el.matches || !el.matches('input, select, textarea') || el.type === 'radio') return;
          if (el.value && el.value.trim()) showError(el, errorElFor(el), validateField(el));
        },
        true
      );
    });

    // Forvælg ydelse fra URL (?ydelse=handle)
    const params = new URLSearchParams(window.location.search);
    root.querySelectorAll('select[data-preselect]').forEach((select) => {
      const key = params.get(select.dataset.preselect);
      if (!key) return;
      const opt = Array.from(select.options).find((o) => o.value && (o.dataset.key === key || slugify(o.value) === key));
      if (opt) select.value = opt.value;
    });

    // Flyt fokus til succes-/fejlbesked efter afsendelse
    const status = root.querySelector('[data-form-success], [data-form-error]');
    if (status) {
      status.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      status.focus({ preventScroll: true });
    }
  }

  /* ---------- Cookiesamtykke (gemmes i browseren) ---------- */
  function initCookies() {
    const banner = document.querySelector('[data-cookie]');
    if (!banner) return;
    const prefs = banner.querySelector('[data-cookie-prefs]');
    const btn = (a) => banner.querySelector(`[data-cookie-action="${a}"]`);
    const status = banner.querySelector('[data-cookie-status]');
    const STORE_KEY = 'theme-cookie-consent';
    const MAX_AGE = 1000 * 60 * 60 * 24 * 365;
    const stored = () => {
      try {
        const d = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
        return d && d.consent && Date.now() - d.t < MAX_AGE ? d.consent : null;
      } catch (e) {
        return null;
      }
    };

    const open = (customize = false) => {
      banner.hidden = false;
      document.documentElement.classList.add('cookie-open');
      if (customize) showPrefs(true);
    };
    const close = () => {
      banner.hidden = true;
      document.documentElement.classList.remove('cookie-open');
    };
    const showPrefs = (show) => {
      prefs.hidden = !show;
      btn('save').hidden = !show;
      btn('customize').hidden = show;
      btn('customize').setAttribute('aria-expanded', String(show));
      if (show) {
        const c = stored() || {};
        prefs.querySelectorAll('[data-consent]').forEach((input) => {
          input.checked = !!c[input.dataset.consent];
        });
      }
      if (show) prefs.querySelector('[data-consent]')?.focus();
    };

    const save = (choice) => {
      const consent = {
        analytics: !!choice.analytics,
        marketing: !!choice.marketing,
        preferences: !!choice.preferences,
        sale_of_data: !!choice.marketing,
      };
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, t: Date.now(), consent }));
      } catch (e) {}
      const done = () => {
        if (status) status.textContent = strings.cookiesSaved || '';
        close();
        document.dispatchEvent(new CustomEvent('theme:consent', { detail: consent }));
      };
      done();
    };

    btn('accept').addEventListener('click', () => save({ analytics: true, marketing: true, preferences: true }));
    btn('reject').addEventListener('click', () => save({}));
    btn('customize').addEventListener('click', () => showPrefs(true));
    btn('save').addEventListener('click', () => {
      const choice = {};
      prefs.querySelectorAll('[data-consent]').forEach((i) => (choice[i.dataset.consent] = i.checked));
      save(choice);
    });
    document.querySelectorAll('[data-cookie-open]').forEach((el) => el.addEventListener('click', () => open(true)));

    // Valget gemmes kun i browseren (localStorage). Banneret vises, indtil der er truffet et valg.
    if (!stored()) open();
  }

  /* ---------- Produktvarianter (pakker) ---------- */
  function initVariants() {
    document.querySelectorAll('[data-variant-select]').forEach((select) => {
      const price = select.closest('.product__info')?.querySelector('.product__price-current');
      select.addEventListener('change', () => {
        const opt = select.selectedOptions[0];
        if (price && opt?.dataset.price) price.textContent = opt.dataset.price;
        const url = new URL(window.location.href);
        url.searchParams.set('variant', select.value);
        window.history.replaceState({}, '', url);
      });
    });
  }

  /* ---------- Init ---------- */
  function initSection(root) {
    initReveal(root);
    initTabs(root);
    initFilters(root);
    initForms(root);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initHeader();
    initSection(document);
    initCookies();
    initVariants();
  });
})();
