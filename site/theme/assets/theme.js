/*
 * Veyro – tema-JavaScript
 * Ingen afhængigheder. Alt er progressiv forbedring: siden virker uden JS.
 * Moduler: header, reveal, proces, pakkerammer, systemdemo, FAQ, tabs, filter, formularer, cookies, varianter.
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

    // „Scrollet“-tilstand uden scroll-lytter: en usynlig markør 8 px nede på siden
    // (ingen tvungen layoutberegning ved start og intet arbejde pr. scroll-hændelse)
    if ('IntersectionObserver' in window) {
      const marker = document.createElement('div');
      marker.setAttribute('aria-hidden', 'true');
      marker.style.cssText = 'position:absolute;top:8px;left:0;width:1px;height:1px;pointer-events:none;';
      document.body.prepend(marker);
      new IntersectionObserver(([e]) => header.classList.toggle('is-scrolled', !e.isIntersecting)).observe(marker);
    }

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

  const motionAllowed = () => document.body.classList.contains('has-motion') && !reducedMotion.matches;

  /* ---------- „Sådan arbejder vi“: orange streg over hvert trin, én gang ----------
   * Trin, der bliver synlige samtidig (fire på række på desktop), aktiveres i rækkefølge;
   * på mobil aktiveres hvert trin, når det kommer ind i skærmbilledet. */
  function initProcess(root = document) {
    const steps = Array.from(root.querySelectorAll('[data-process-step]:not(.is-active)'));
    if (!steps.length) return;
    if (!motionAllowed() || !('IntersectionObserver' in window)) {
      steps.forEach((el) => el.classList.add('is-active'));
      return;
    }
    const STAGGER = 250;
    const observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target)
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .forEach((el, i) => {
            el.style.setProperty('--step-delay', `${i * STAGGER}ms`);
            el.classList.add('is-active');
            observer.unobserve(el);
          });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.35 }
    );
    steps.forEach((el) => {
      el.classList.add('is-pending');
      observer.observe(el);
    });
  }

  /* ---------- Pakkekort: rammen tegnes rundt om kortet, én gang ----------
   * Rammen er en SVG-kant, der som udgangspunkt er fuldt optrukket (uden JS eller ved reduceret
   * bevægelse). Her skjules den kun, indtil kortet kommer ind i billedet, og tegnes så rundt. Kort,
   * der bliver synlige samtidig, får en lille forskydning; på mobil aktiveres hvert kort for sig. */
  function initFrames(root = document) {
    const cards = Array.from(root.querySelectorAll('[data-frame]:not(.frame-pending):not(.frame-done)'));
    if (!cards.length || !motionAllowed() || !('IntersectionObserver' in window)) return;
    const STAGGER = 110;
    const measure = (card) => {
      const rect = card.querySelector('rect');
      if (!rect || typeof rect.getTotalLength !== 'function') return false;
      card.style.setProperty('--frame-len', Math.ceil(rect.getTotalLength()) + 1);
      return true;
    };
    const finish = (card) => {
      card.classList.remove('frame-pending', 'frame-drawing');
      card.classList.add('frame-done');
    };
    const observer = new IntersectionObserver(
      (entries) => {
        entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target)
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
          .forEach((card, i) => {
            observer.unobserve(card);
            card.style.setProperty('--frame-delay', `${i * STAGGER}ms`);
            card.classList.add('frame-drawing');
            const rect = card.querySelector('rect');
            rect.addEventListener('transitionend', () => finish(card), { once: true });
            // Sikkerhedsnet, hvis transitionend aldrig kommer (fx skjult fane)
            setTimeout(() => finish(card), 1400 + i * STAGGER);
          });
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.6 }
    );
    cards.forEach((card) => {
      if (!measure(card)) return;
      card.classList.add('frame-pending');
      observer.observe(card);
    });
    // Ændres bredden, før rammen er tegnet, måles omkredsen igen
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => cards.forEach((c) => c.classList.contains('frame-pending') && !c.classList.contains('frame-drawing') && measure(c)), 150);
    }, { passive: true });
  }

  /* ---------- Systemdemo: „Prøv et eksempel“ ----------
   * Ændrer kun tallene på siden (fysisk og disponibel; reserveret er uændret). Intet gemmes eller sendes. */
  function initDemo(root = document) {
    root.querySelectorAll('[data-demo-try]').forEach((bar) => {
      if (bar.dataset.demoReady) return;
      const figure = bar.closest('.demo__figure');
      const row = figure?.querySelector('[data-demo-row]');
      const physicalEl = row?.querySelector('[data-demo-physical]');
      const reservedEl = row?.querySelector('[data-demo-reserved]');
      const availableEl = row?.querySelector('[data-demo-available]');
      const btn = bar.querySelector('[data-demo-play]');
      const status = bar.querySelector('[data-demo-status]');
      const log = figure?.querySelector('[data-demo-log]');
      if (!physicalEl || !reservedEl || !availableEl || !btn || !status) return;
      bar.dataset.demoReady = 'true';

      const qty = parseInt(bar.dataset.qty, 10) || 3;
      const start = { physical: parseInt(physicalEl.textContent, 10), reserved: parseInt(reservedEl.textContent, 10) };
      const playLabel = btn.textContent.trim();
      const resetLabel = btn.dataset.labelReset || playLabel;
      let played = false;
      let timers = [];
      const numbers = [physicalEl, reservedEl, availableEl];
      // Afbrydes en overgang (hurtige klik), sættes tallene straks til deres sidste værdi
      const clearTimers = () => {
        timers.forEach(clearTimeout);
        timers = [];
        numbers.forEach((el) => {
          if (el.dataset.target) el.textContent = el.dataset.target;
          el.classList.remove('is-changing');
        });
      };
      const later = (fn, ms) => (motionAllowed() ? timers.push(setTimeout(fn, ms)) : fn());

      // Kort overgang: tallet toner ud, skiftes og toner ind (ingen rullende tal)
      const setNumber = (el, value) => {
        el.dataset.target = value;
        if (el.textContent === String(value)) return;
        if (!motionAllowed()) {
          el.textContent = value;
          return;
        }
        el.classList.add('is-changing');
        timers.push(
          setTimeout(() => {
            el.textContent = el.dataset.target;
            el.classList.remove('is-changing');
          }, 160)
        );
      };
      const render = (physical) => {
        setNumber(physicalEl, physical);
        setNumber(reservedEl, start.reserved);
        setNumber(availableEl, physical - start.reserved);
      };

      let logItem;
      const showLog = (show) => {
        if (!log) return;
        if (show && !logItem) {
          logItem = document.createElement('li');
          logItem.className = 'demo__log-new';
          const a = document.createElement('span');
          a.textContent = 'Forbrug registreret på job';
          const b = document.createElement('em');
          b.textContent = `Arbejdshandsker −${qty}`;
          logItem.append(a, b);
          log.prepend(logItem);
          if (log.lastElementChild !== logItem) log.lastElementChild.hidden = true;
        } else if (!show && logItem) {
          logItem.remove();
          logItem = null;
          Array.from(log.children).forEach((li) => (li.hidden = false));
        }
      };

      // Kører en overgang, når demoen forlader skærmen eller fanen skjules, springes den til slutningen
      const settle = () => {
        if (!timers.length) return;
        clearTimers();
        if (played) {
          render(start.physical - qty);
          showLog(true);
          status.textContent = `${qty} par registreret på jobbet. Lager opdateret.`;
          status.classList.add('is-shown');
        }
        row.classList.remove('is-highlight');
      };
      document.addEventListener('visibilitychange', () => document.hidden && settle());
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(([e]) => !e.isIntersecting && settle()).observe(figure);
      }

      btn.addEventListener('click', () => {
        clearTimers();
        row.classList.remove('is-highlight');
        status.classList.remove('is-shown');
        if (!played) {
          played = true;
          btn.textContent = resetLabel;
          row.classList.add('is-highlight');
          later(() => render(start.physical - qty), 280);
          later(() => {
            showLog(true);
            status.textContent = `${qty} par registreret på jobbet. Lager opdateret.`;
            status.classList.add('is-shown');
          }, 520);
          later(() => row.classList.remove('is-highlight'), 1600);
        } else {
          played = false;
          btn.textContent = playLabel;
          render(start.physical);
          showLog(false);
          status.textContent = 'Eksemplet er nulstillet.';
          status.classList.add('is-shown');
        }
      });

      bar.hidden = false;
    });
  }

  /* ---------- FAQ: svar åbner og lukker blødt ----------
   * <details> virker uden JS; her animeres kun højden. Åben/lukket status følger altid elementet. */
  function initFaq(root = document) {
    root.querySelectorAll('details.faq__item').forEach((item) => {
      if (item.dataset.faqReady) return;
      const summary = item.querySelector('summary');
      const answer = item.querySelector('.faq__answer');
      if (!summary || !answer || typeof answer.animate !== 'function') return;
      item.dataset.faqReady = 'true';
      let anim = null;

      const run = (opening) => {
        const style = getComputedStyle(answer);
        const full = { height: `${answer.scrollHeight}px`, paddingBottom: style.paddingBottom, opacity: 1 };
        const from = anim ? { height: style.height, paddingBottom: style.paddingBottom, opacity: style.opacity } : opening ? { height: '0px', paddingBottom: '0px', opacity: 0 } : full;
        const to = opening ? full : { height: '0px', paddingBottom: '0px', opacity: 0 };
        if (anim) anim.cancel();
        answer.style.overflow = 'hidden';
        anim = answer.animate([from, to], { duration: 200, easing: 'cubic-bezier(.2, .7, .2, 1)' });
        anim.onfinish = () => {
          anim = null;
          answer.style.overflow = '';
          if (!opening) item.open = false;
          item.classList.remove('is-closing');
        };
      };

      summary.addEventListener('click', (e) => {
        if (!motionAllowed()) return;
        e.preventDefault();
        if (item.open && !item.classList.contains('is-closing')) {
          item.classList.add('is-closing');
          run(false);
        } else {
          item.classList.remove('is-closing');
          item.open = true;
          run(true);
        }
      });
    });
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
    initProcess(root);
    initFrames(root);
    initDemo(root);
    initFaq(root);
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
