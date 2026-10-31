/* A native radio group chooses which existing demo enquiry link to use. No purchase is made. */
(() => {
  'use strict';
  const strings = (() => { try { return JSON.parse(document.getElementById('ThemeStrings')?.textContent || '{}'); } catch (_) { return {}; } })();
  const init = () => document.querySelectorAll('[data-plan-picker]').forEach(picker => {
    const cards = [...picker.querySelectorAll('[data-plan-card]')];
    const summary = picker.querySelector('[data-plan-summary]');
    if (!summary || !cards.length) return;
    const title = summary.querySelector('[data-summary-title]');
    const price = summary.querySelector('[data-summary-price]');
    const total = summary.querySelector('[data-summary-total]');
    const description = summary.querySelector('[data-summary-description]');
    const link = summary.querySelector('[data-summary-link]');
    const status = summary.querySelector('[data-summary-status]');
    const select = (radio, announce = false) => {
      const card = radio.closest('[data-plan-card]');
      if (!card || !cards.includes(card)) return;
      cards.forEach(item => item.classList.toggle('is-selected', item === card));
      title.textContent = card.dataset.planTitle;
      price.textContent = card.dataset.planPrice;
      total.textContent = card.dataset.planPrice;
      description.textContent = card.querySelector('.pc__desc')?.textContent || '';
      link.setAttribute('href', card.dataset.planLink);
      summary.dataset.plan = radio.value;
      if (announce && status) status.textContent = (strings.planSelected || '').replace('{title}', card.dataset.planTitle).replace('{price}', card.dataset.planPrice);
    };
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
