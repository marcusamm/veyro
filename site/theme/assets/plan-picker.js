/* Native controls choose an existing demo enquiry and webshop tier. No purchase is made. */
(() => {
  'use strict';
  const strings = (() => { try { return JSON.parse(document.getElementById('ThemeStrings')?.textContent || '{}'); } catch (_) { return {}; } })();
  const init = () => document.querySelectorAll('[data-plan-picker]').forEach(picker => {
    if (picker.classList.contains('is-ready')) return;
    const cards = [...picker.querySelectorAll('[data-plan-card]')];
    const summary = picker.querySelector('[data-plan-summary]');
    if (!summary || !cards.length) return;
    const title = summary.querySelector('[data-summary-title]');
    const price = summary.querySelector('[data-summary-price]');
    const total = summary.querySelector('[data-summary-total]');
    const description = summary.querySelector('[data-summary-description]');
    const capacity = summary.querySelector('[data-summary-capacity]');
    const imports = summary.querySelector('[data-summary-import]');
    const link = summary.querySelector('[data-summary-link]');
    const status = summary.querySelector('[data-summary-status]');
    const tierControls = new Map();
    const applyTier = (card, explicit = false) => {
      const control = tierControls.get(card);
      if (!control) return;
      const option = control.input.selectedOptions[0];
      if (!option) return;
      // The base URL has already been localized by the renderer. Preserve its
      // language, service and anchor while replacing only the selected tier.
      const url = new URL(control.baseLink, window.location.href);
      url.searchParams.set('webshop_niveau', option.value);
      card.dataset.planLink = url.pathname + url.search + url.hash;
      card.dataset.planPrice = option.dataset.price;
      card.dataset.planCapacity = option.dataset.capacity;
      card.dataset.planImport = option.dataset.import;
      card.querySelector('[data-plan-amount]').textContent = option.dataset.price;
      card.querySelectorAll('[data-webshop-capacity], [data-webshop-art-capacity]').forEach(item => { item.textContent = option.dataset.capacity; });
      card.querySelector('[data-webshop-import]').textContent = option.dataset.import;
      card.querySelector('[data-plan-actions] a')?.setAttribute('href', card.dataset.planLink);
      if (explicit) {
        const from = card.querySelector('[data-plan-from]');
        if (from) from.hidden = true;
      }
    };
    const select = (radio, announce = false) => {
      const card = radio.closest('[data-plan-card]');
      if (!card || !cards.includes(card)) return;
      applyTier(card, true);
      cards.forEach(item => item.classList.toggle('is-selected', item === card));
      title.textContent = card.dataset.planTitle;
      price.textContent = card.dataset.planPrice;
      total.textContent = card.dataset.planPrice;
      description.textContent = card.querySelector('.pc__desc')?.textContent || '';
      if (capacity) { capacity.textContent = card.dataset.planCapacity || ''; capacity.hidden = !capacity.textContent; }
      if (imports) { imports.textContent = card.dataset.planImport || ''; imports.hidden = !imports.textContent; }
      link.setAttribute('href', card.dataset.planLink);
      summary.dataset.plan = radio.value;
      if (announce && status) status.textContent = [(strings.planSelected || '').replace('{title}', card.dataset.planTitle).replace('{price}', card.dataset.planPrice), card.dataset.planCapacity].filter(Boolean).join(' ');
    };
    cards.forEach(card => {
      const input = card.querySelector('[data-webshop-tier]');
      if (!input || !input.options.length) return;
      tierControls.set(card, { input, baseLink: card.dataset.planLink });
      applyTier(card, input.selectedIndex > 0);
      input.addEventListener('change', () => {
        const radio = card.querySelector('[data-plan-radio]');
        if (!radio) return;
        radio.checked = true;
        select(radio, true);
      });
      const control = card.querySelector('[data-webshop-picker]');
      if (control) control.hidden = false;
    });
    picker.querySelectorAll('[data-plan-radio]').forEach(radio => {
      radio.addEventListener('change', () => { if (radio.checked) select(radio, true); });
      const label = radio.closest('[data-plan-label]');
      if (label) label.hidden = false;
    });
    const initial = picker.querySelector('[data-plan-radio]:checked') || picker.querySelector('[data-plan-radio]');
    if (initial) { initial.checked = true; select(initial); }
    picker.classList.add('is-ready');
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
