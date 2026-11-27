/** Progressive enhancement only: persistent state and authorization stay on the server. */
export const ACCOUNTING_JS = String.raw`
(() => {
  'use strict';
  const root = document.querySelector('.accounting');
  if (!root) return;
  const fold = (value) => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  root.querySelectorAll('[data-account-picker]').forEach((picker, index) => {
    const input = picker.querySelector('input');
    const datalist = picker.querySelector('datalist');
    const box = picker.querySelector('[data-account-results]');
    if (!input || !datalist || !box) return;
    const options = Array.from(datalist.options, (option) => ({ code: option.value, label: option.textContent.trim() }));
    if (!options.length) return;
    const boxId = 'account-results-' + index;
    box.id = boxId;
    box.setAttribute('role', 'listbox');
    box.setAttribute('aria-label', 'Kontoplan');
    input.removeAttribute('list');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', boxId);
    input.setAttribute('aria-expanded', 'false');
    let visible = [];
    let active = -1;
    const close = () => {
      box.hidden = true;
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };
    const activate = (next) => {
      active = next;
      Array.from(box.querySelectorAll('[role="option"]')).forEach((option, position) => {
        option.setAttribute('aria-selected', position === active ? 'true' : 'false');
        if (position === active) {
          input.setAttribute('aria-activedescendant', option.id);
          option.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        }
      });
    };
    const choose = (position) => {
      const chosen = visible[position];
      if (!chosen) return;
      input.value = chosen.code;
      const help = picker.querySelector('.hint');
      if (help) help.textContent = chosen.label;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      close();
      input.focus();
    };
    const show = () => {
      const terms = fold(input.value).split(/\s+/).filter(Boolean);
      visible = options.filter((option) => terms.every((term) => fold(option.label).includes(term)));
      active = -1;
      input.removeAttribute('aria-activedescendant');
      box.replaceChildren();
      if (visible.length) {
        visible.forEach((option, position) => {
          const node = document.createElement('div');
          node.className = 'acct-account-option';
          node.id = boxId + '-' + position;
          node.setAttribute('role', 'option');
          node.setAttribute('aria-selected', 'false');
          node.textContent = option.label;
          node.addEventListener('mousedown', (event) => event.preventDefault());
          node.addEventListener('click', () => choose(position));
          box.appendChild(node);
        });
      } else {
        const empty = document.createElement('p');
        empty.className = 'acct-account-none';
        empty.textContent = 'Ingen konti matcher. Prøv kontonummer eller et andet navn.';
        box.appendChild(empty);
      }
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    input.addEventListener('input', show);
    input.addEventListener('focus', show);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (box.hidden) show();
        if (visible.length) activate(event.key === 'ArrowDown' ? (active + 1) % visible.length : (active <= 0 ? visible.length - 1 : active - 1));
      } else if (event.key === 'Enter' && !box.hidden && active >= 0) {
        event.preventDefault();
        choose(active);
      } else if (event.key === 'Escape') {
        close();
      } else if (event.key === 'Tab') {
        close();
      }
    });
    const chosen = options.find((option) => option.code === input.value);
    const help = picker.querySelector('.hint');
    if (chosen && help) help.textContent = chosen.label;
  });
  root.querySelectorAll('[data-receipt-currency]').forEach((input) => {
    const form = input.closest('form');
    const fields = form && form.querySelector('[data-foreign-fields]');
    if (!fields) return;
    const update = () => {
      const code = input.value.trim().toUpperCase();
      const foreign = code.length === 3 && code !== 'DKK';
      fields.hidden = !foreign;
      fields.querySelectorAll('input').forEach((field) => {
        field.required = foreign;
        field.disabled = !foreign;
      });
    };
    input.addEventListener('input', update);
    update();
  });
})();
`;
