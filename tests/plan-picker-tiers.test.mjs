import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the production state/URL logic without a browser. Actual native
// controls, layout and keyboard behavior are checked separately in the UI.
const source = readFileSync(new URL('../site/theme/assets/plan-picker.js', import.meta.url), 'utf8');
const prices = { da: ['299 kr.', '399 kr.', '499 kr.'], en: ['≈ EUR 40.01', '≈ EUR 53.39', '≈ EUR 66.77'], sv: ['≈ 439,21 SEK', '≈ 586,10 SEK', '≈ 732,99 SEK'] };
function node({ text = '', hidden = false, data = {} } = {}) {
  const attributes = new Map(), listeners = new Map(), classes = new Set();
  return {
    textContent: text, hidden, dataset: data,
    setAttribute: (key, value) => attributes.set(key, value),
    getAttribute: key => attributes.get(key),
    addEventListener: (type, callback) => listeners.set(type, callback),
    emit(type) { listeners.get(type)?.({ target: this }); },
    classList: { contains: c => classes.has(c), add: c => classes.add(c), toggle(c, enabled) { if (enabled) classes.add(c); else classes.delete(c); } },
  };
}
function fixture(lang = 'da', count = 1) {
  const prefix = lang === 'da' ? '' : `/${lang}`;
  const pickers = Array.from({ length: count }, () => {
    const picker = node();
    const summary = node();
    const fields = Object.fromEntries(['title', 'price', 'total', 'description', 'capacity', 'import', 'link', 'status'].map(name => [name, node({ hidden: ['capacity', 'import'].includes(name) })]));
    summary.querySelector = selector => fields[selector.slice('[data-summary-'.length, -1)] || null;
    const cards = ['hjemmeside', 'booking', 'webshop'].map((name, index) => {
      const card = node({ data: { planTitle: name, planPrice: index === 2 ? prices[lang][0] : index === 1 ? '299 kr.' : '199 kr.', planLink: `${prefix}/pages/kontakt?ydelse=pakke-${name}#formular` } });
      const label = node({ hidden: true }), radio = node(), amount = node(), description = node({ text: `${name} description` }), primary = node(), details = node();
      primary.setAttribute('href', card.dataset.planLink);
      details.setAttribute('href', `${prefix}/pages/${name}`);
      radio.value = name;
      radio.checked = index === 0;
      radio.closest = selector => selector === '[data-plan-card]' ? card : selector === '[data-plan-label]' ? label : null;
      const nodes = { '[data-plan-radio]': radio, '[data-plan-amount]': amount, '.pc__desc': description, '[data-plan-actions] a': primary };
      card.querySelector = selector => nodes[selector] || null;
      card.querySelectorAll = selector => selector === '[data-webshop-capacity], [data-webshop-art-capacity]' ? [nodes['[data-webshop-capacity]'], nodes['[data-webshop-art-capacity]']] : [];
      Object.assign(card, { radio, amount, primary, details, label });
      if (index === 2) {
        const input = node();
        input.options = [60, 120, 200].map((p, n) => ({ value: String(p), dataset: { price: prices[lang][n], capacity: `${lang}: ${p} items and variants in total`, import: `${lang}: 10 manual products or ${p} imported items and variants` } }));
        input.selectedIndex = 0;
        Object.defineProperty(input, 'selectedOptions', { get: () => [input.options[input.selectedIndex]] });
        Object.assign(nodes, { '[data-webshop-tier]': input, '[data-webshop-picker]': node({ hidden: true }), '[data-webshop-capacity]': node(), '[data-webshop-import]': node(), '[data-webshop-art-capacity]': node(), '[data-plan-from]': node() });
        card.input = input;
        card.nodes = nodes;
      }
      return card;
    });
    picker.querySelectorAll = selector => selector === '[data-plan-card]' ? cards : selector === '[data-plan-radio]' ? cards.map(card => card.radio) : [];
    picker.querySelector = selector => selector === '[data-plan-summary]' ? summary : selector === '[data-plan-radio]:checked' ? cards.find(card => card.radio.checked)?.radio : selector === '[data-plan-radio]' ? cards[0].radio : null;
    picker.choose = index => { cards.forEach((card, i) => { card.radio.checked = i === index; }); cards[index].radio.emit('change'); };
    picker.chooseTier = index => { cards[2].input.selectedIndex = index; cards[2].input.emit('change'); };
    return Object.assign(picker, { cards, summary, fields });
  });
  const document = { readyState: 'complete', getElementById: () => ({ textContent: '{"planSelected":"{title}: {price}"}' }), querySelectorAll: () => pickers };
  const context = vm.createContext({ document, window: { location: { href: `https://veyro.dk${prefix}/pages/priser` } }, URL });
  vm.runInContext(source, context);
  return { pickers, context };
}
function expectTier(picker, lang, index) {
  const card = picker.cards[2], option = card.input.options[index], amount = prices[lang][index];
  expect(card.radio.checked).toBe(true);
  expect(card.amount.textContent).toBe(amount);
  expect(picker.fields.price.textContent).toBe(amount);
  expect(picker.fields.total.textContent).toBe(amount);
  expect(picker.fields.capacity.hidden).toBe(false);
  expect(picker.fields.import.hidden).toBe(false);
  expect(picker.fields.capacity.textContent).toBe(option.dataset.capacity);
  expect(picker.fields.import.textContent).toBe(option.dataset.import);
  expect(card.nodes['[data-webshop-capacity]'].textContent).toBe(option.dataset.capacity);
  expect(card.nodes['[data-webshop-art-capacity]'].textContent).toBe(option.dataset.capacity);
  expect(card.nodes['[data-webshop-import]'].textContent).toBe(option.dataset.import);
  expect(card.nodes['[data-plan-from]'].hidden).toBe(true);
  for (const link of [card.primary, picker.fields.link]) {
    const url = new URL(link.getAttribute('href'), 'https://veyro.dk');
    expect(url.pathname).toBe(`${lang === 'da' ? '' : `/${lang}`}/pages/kontakt`);
    expect(url.searchParams.get('ydelse')).toBe('pakke-webshop');
    expect(url.searchParams.getAll('webshop_niveau')).toEqual([option.value]);
    expect(url.hash).toBe('#formular');
  }
  expect(card.details.getAttribute('href')).toBe(`${lang === 'da' ? '' : `/${lang}`}/pages/webshop`);
}

describe('Webshop picker state and enquiry propagation', () => {
  it('keeps the original initial plan and uses the first tier when Webshop is selected', () => {
    const { pickers: [picker] } = fixture();
    expect(picker.summary.dataset.plan).toBe('hjemmeside');
    expect(picker.fields.capacity.hidden).toBe(true);
    expect(picker.cards[2].nodes['[data-plan-from]'].hidden).toBe(false);
    expect(picker.cards[2].nodes['[data-webshop-picker]'].hidden).toBe(false);
    expect(picker.cards.every(card => !card.label.hidden)).toBe(true);
    picker.choose(2);
    expectTier(picker, 'da', 0);
  });
  it('updates all price/capacity/import/link fields together and remembers choices across plans', () => {
    const { pickers: [picker] } = fixture();
    picker.chooseTier(1);
    expectTier(picker, 'da', 1);
    picker.chooseTier(2);
    expectTier(picker, 'da', 2);
    picker.choose(1);
    expect(picker.summary.dataset.plan).toBe('booking');
    expect(picker.fields.capacity.hidden).toBe(true);
    expect(picker.fields.import.hidden).toBe(true);
    expect(picker.fields.link.getAttribute('href')).toBe('/pages/kontakt?ydelse=pakke-booking#formular');
    picker.choose(2);
    expectTier(picker, 'da', 2);
    picker.chooseTier(0);
    expectTier(picker, 'da', 0);
  });
  it.each(['en', 'sv'])('preserves %s display currency and localized links without recalculating amounts', lang => {
    const { pickers: [picker] } = fixture(lang);
    for (let index = 0; index < 3; index++) { picker.chooseTier(index); expectTier(picker, lang, index); }
  });
  it('isolates multiple pickers and does not bind initialized pickers twice', () => {
    const { pickers, context } = fixture('da', 2);
    pickers[0].chooseTier(2);
    expectTier(pickers[0], 'da', 2);
    expect(pickers[1].summary.dataset.plan).toBe('hjemmeside');
    expect(pickers[1].cards[2].input.selectedIndex).toBe(0);
    vm.runInContext(source, context);
    expectTier(pickers[0], 'da', 2);
  });
  it('announces the selected amount and capacity in the existing polite status', () => {
    const { pickers: [picker] } = fixture('sv');
    picker.chooseTier(1);
    expect(picker.fields.status.textContent).toBe(`webshop: ${prices.sv[1]} sv: 120 items and variants in total`);
  });
});
