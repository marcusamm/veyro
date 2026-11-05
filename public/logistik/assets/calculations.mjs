/** Pure calculations shared by the browser and the verification scripts. */
export class CalculationError extends Error {
  constructor(code, path = '', message = 'Kontrollér de indtastede oplysninger.') {
    super(message);
    this.name = 'CalculationError';
    this.code = code;
    this.path = path;
  }
}

export const MAX_ABC_ROWS = 200;
export const MAX_TCO_COSTS = 30;
const MAX_RESULT = 1e15;
const numeric = (min = 0, max = 1e9) => ({ type: 'number', min, max });

export const SCHEMAS = Object.freeze({
  eoq: {
    annualDemand: numeric(), orderCost: numeric(0, 1e8), unitCost: numeric(0, 1e8),
    holdingRatePercent: numeric(0, 1000), workingDays: numeric(1, 366),
  },
  rop: {
    mode: ['simple', 'statistical'], dailyDemand: numeric(), leadDays: numeric(0, 3650),
    safetyMode: ['units', 'days'], safetyStock: numeric(), safetyDays: numeric(0, 3650),
    dailyStdDev: numeric(), serviceLevelPercent: { ...numeric(50, 100), exclusiveMin: true, exclusiveMax: true },
  },
  tco: {
    periodYears: { ...numeric(0, 100), exclusiveMin: true }, annualQuantity: numeric(), maxAlternatives: 3,
    alternative: { ordersPerYear: numeric(0, 1e6), residualValue: numeric(0, 1e12), maxCosts: MAX_TCO_COSTS },
    cost: { amount: numeric(0, 1e8), frequency: ['once', 'year', 'order', 'unit'] },
    capital: { annualRatePercent: numeric(0, 1000), days: numeric(0, 3650),
      paymentStart: ['order', 'receipt', 'other'], interestMode: ['add', 'replace', 'skip'], existingInterestAnnual: numeric(0, 1e12) },
  },
  abc: {
    thresholdA: { ...numeric(0, 100), exclusiveMin: true, exclusiveMax: true },
    thresholdB: { ...numeric(0, 100), exclusiveMin: true, exclusiveMax: true },
    maxItems: MAX_ABC_ROWS, item: { annualQuantity: numeric(), unitCost: numeric(0, 1e8) },
  },
});

function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Fictitious examples; callers clone these before editing. */
export const SAMPLES = freeze({
  eoq: { annualDemand: 12000, orderCost: 250, unitCost: 80, holdingRatePercent: 20, workingDays: 250 },
  rop: { mode: 'simple', dailyDemand: 40, leadDays: 5, safetyMode: 'days', safetyStock: 80, safetyDays: 2, dailyStdDev: 12, serviceLevelPercent: 95 },
  tco: {
    periodYears: 3, annualQuantity: 12000,
    alternatives: [
      { id: 'a', name: 'Leverandør A', ordersPerYear: 24, residualValue: 0, costs: [
        { id: 'a-start', label: 'Opstart', amount: 6000, frequency: 'once' },
        { id: 'a-unit', label: 'Indkøbspris', amount: 18, frequency: 'unit' },
        { id: 'a-order', label: 'Bestilling og fragt', amount: 350, frequency: 'order' },
        { id: 'a-year', label: 'Håndtering og lager', amount: 18000, frequency: 'year' },
      ] },
      { id: 'b', name: 'Leverandør B', ordersPerYear: 12, residualValue: 0, costs: [
        { id: 'b-start', label: 'Opstart', amount: 12000, frequency: 'once' },
        { id: 'b-unit', label: 'Indkøbspris', amount: 18.5, frequency: 'unit' },
        { id: 'b-order', label: 'Bestilling og fragt', amount: 150, frequency: 'order' },
        { id: 'b-year', label: 'Håndtering og lager', amount: 12000, frequency: 'year' },
      ] },
    ],
  },
  abc: { thresholdA: 80, thresholdB: 95, items: [
    { name: 'Motor M-100', annualQuantity: 400, unitCost: 500 },
    { name: 'Pumpe P-200', annualQuantity: 300, unitCost: 400 },
    { name: 'Leje L-030', annualQuantity: 2000, unitCost: 40 },
    { name: 'Rem R-040', annualQuantity: 1200, unitCost: 30 },
    { name: 'Ventil V-050', annualQuantity: 500, unitCost: 50 },
    { name: 'Pakning P-060', annualQuantity: 3000, unitCost: 5 },
    { name: 'Skrue S-070', annualQuantity: 10000, unitCost: 1 },
    { name: 'Møtrik M-080', annualQuantity: 7000, unitCost: 1 },
    { name: 'Skive S-090', annualQuantity: 4000, unitCost: 1 },
    { name: 'Clips C-010', annualQuantity: 3000, unitCost: 1 },
  ] },
});

/** User-specified fictitious financing example, never a current market-rate claim. */
export const TCO_CAPITAL_SAMPLE = freeze({
  periodYears: 3, annualQuantity: 3650, capital: { annualRatePercent: 10 },
  alternatives: [
    { id: 'capital-order', name: 'Betaling efter bestilling', ordersPerYear: 12, residualValue: 0,
      costs: [{ id: 'order-purchase', label: 'Indkøbspris', amount: 100, frequency: 'unit' }],
      capital: { purchaseCostId: 'order-purchase', leadDays: 30, paymentStart: 'order', supplierCreditDays: 10, inventoryDays: 20, customerCreditDays: 0, interestMode: 'add' } },
    { id: 'capital-receipt', name: 'Betaling efter modtagelse', ordersPerYear: 12, residualValue: 0,
      costs: [{ id: 'receipt-purchase', label: 'Indkøbspris', amount: 100, frequency: 'unit' }],
      capital: { purchaseCostId: 'receipt-purchase', leadDays: 30, paymentStart: 'receipt', supplierCreditDays: 10, inventoryDays: 20, customerCreditDays: 0, interestMode: 'add' } },
  ],
});

/** Explicit locale, strict grouping. Blank, exponent, currency and mixed formats are rejected. */
export function parseNumber(value, format = 'da') {
  if (format !== 'da' && format !== 'en') throw new CalculationError('number_format', '', 'Vælg dansk eller engelsk talformat.');
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new CalculationError('invalid_number', '', 'Tallet er ikke gyldigt eller er for stort.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'string' || !value.trim()) throw new CalculationError('required', '', 'Udfyld feltet med et tal.');
  const text = value.trim().replace(/[\u00a0\u202f]/g, ' ');
  const decimal = format === 'da' ? ',' : '.';
  const grouping = format === 'da' ? '.' : ',';
  const parts = text.replace(/^[+-]/, '').split(decimal);
  if (parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) throw new CalculationError('invalid_number', '', 'Tallet passer ikke til det valgte talformat.');
  const whole = parts[0];
  const escapedGrouping = grouping === '.' ? '\\.' : ',';
  const grouped = new RegExp('^\\d{1,3}(?:' + escapedGrouping + '\\d{3})+$');
  const spaced = /^\d{1,3}(?: \d{3})+$/;
  if (!( /^\d+$/.test(whole) || grouped.test(whole) || spaced.test(whole) || (whole === '' && parts.length === 2))) {
    throw new CalculationError('invalid_number', '', 'Brug korrekt decimaltegn og tusindtalsseparator.');
  }
  const normalized = text.split(grouping).join('').replaceAll(' ', '').replace(decimal, '.');
  const result = Number(normalized);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw new CalculationError('invalid_number', '', 'Tallet er ikke gyldigt eller er for stort.');
  return Object.is(result, -0) ? 0 : result;
}

function object(value, path = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CalculationError('invalid_input', path);
  return value;
}
function number(value, path, min = 0, max = 1e9, exclusive = false) {
  let n;
  try { n = parseNumber(value); } catch (error) { if (error instanceof CalculationError) error.path = path; throw error; }
  if ((exclusive ? n <= min : n < min) || n > max) throw new CalculationError('out_of_range', path, `Værdien i ${path} er uden for det tilladte interval.`);
  return n;
}
function label(value, path, message = 'Angiv et navn på højst 160 tegn.') {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160 || /[\u0000-\u001f\u007f]/.test(value)) throw new CalculationError('invalid_text', path, message);
  return value.trim();
}
function choice(value, allowed, path) {
  if (!allowed.includes(value)) throw new CalculationError('invalid_choice', path);
  return value;
}
function rows(value, max, path) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new CalculationError('row_count', path, `Brug mellem 1 og ${max} rækker.`);
  return value;
}
function resultNumber(value) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_RESULT) throw new CalculationError('result_too_large', '', 'Resultatet er for stort. Kontrollér størrelser og enheder.');
  return value;
}
const money = value => Math.round((resultNumber(value) + Number.EPSILON * Math.abs(value)) * 100) / 100;
const ceiling = value => Math.ceil(value - 4 * Number.EPSILON * Math.abs(value));

function eoqCosts(demand, orderCost, holdingCost, days, quantity) {
  if (demand === 0) return { ordersPerYear: 0, intervalDays: null, averageStock: 0, orderingCost: 0, holdingCost: 0, totalCost: 0 };
  if (quantity === 0) return { ordersPerYear: null, intervalDays: 0, averageStock: 0, orderingCost: 0, holdingCost: 0, totalCost: 0 };
  const ordersPerYear = resultNumber(demand / quantity);
  const ordering = resultNumber(ordersPerYear * orderCost);
  const holding = resultNumber(quantity / 2 * holdingCost);
  return { ordersPerYear, intervalDays: resultNumber(days / ordersPerYear), averageStock: quantity / 2,
    orderingCost: ordering, holdingCost: holding, totalCost: resultNumber(ordering + holding) };
}

export function eoq(input) {
  object(input);
  const D = number(input.annualDemand, 'annualDemand');
  const S = number(input.orderCost, 'orderCost', 0, 1e8);
  const c = number(input.unitCost, 'unitCost', 0, 1e8);
  const i = number(input.holdingRatePercent, 'holdingRatePercent', 0, 1000);
  const days = number(input.workingDays, 'workingDays', 1, 366);
  const H = resultNumber(c * i / 100);
  if (D > 0 && H === 0) throw new CalculationError('zero_holding_cost', c === 0 ? 'unitCost' : 'holdingRatePercent', 'EOQ kræver en positiv årlig lageromkostning pr. enhed, når efterspørgslen er positiv.');
  const mathematicalQuantity = D === 0 ? 0 : resultNumber(Math.sqrt(2 * D * S / H));
  const roundedQuantity = D === 0 ? 0 : Math.max(1, ceiling(mathematicalQuantity));
  const mathematical = eoqCosts(D, S, H, days, mathematicalQuantity);
  const practical = eoqCosts(D, S, H, days, roundedQuantity);
  const warnings = D === 0 ? ['zero_demand'] : S === 0 ? ['zero_order_cost'] : [];
  const points = [];
  if (D > 0) {
    const reference = mathematicalQuantity || 1;
    for (let n = 0; n <= 40; n++) {
      const quantity = reference * (0.2 + n * 0.07);
      const costs = eoqCosts(D, S, H, days, quantity);
      points.push({ quantity, orderingCost: costs.orderingCost, holdingCost: costs.holdingCost, totalCost: costs.totalCost });
    }
    points.push({ quantity: roundedQuantity, ...pickCosts(practical) });
    if (mathematicalQuantity > 0) points.push({ quantity: mathematicalQuantity, ...pickCosts(mathematical) });
    points.sort((a, b) => a.quantity - b.quantity);
  }
  return { holdingCostPerUnit: H, mathematicalQuantity, roundedQuantity, mathematical, practical, chartPoints: points, warnings };
}
function pickCosts(value) { return { orderingCost: value.orderingCost, holdingCost: value.holdingCost, totalCost: value.totalCost }; }

/** Acklam's rational inverse-normal approximation (absolute error about 1e-8 here). */
export function inverseNormal(probability) {
  const p = number(probability, 'probability', 0, 1, true);
  if (p >= 1) throw new CalculationError('out_of_range', 'probability');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425 || p > 1 - 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p < 0.5 ? p : 1 - p));
    const tail = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    return p < 0.5 ? tail : -tail;
  }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function rop(input) {
  object(input);
  const mode = choice(input.mode, ['simple', 'statistical'], 'mode');
  const dailyDemand = number(input.dailyDemand, 'dailyDemand');
  const leadDays = number(input.leadDays, 'leadDays', 0, 3650);
  const expectedDemand = resultNumber(dailyDemand * leadDays);
  let safetyStock, zScore = null;
  const warnings = [];
  if (mode === 'simple') {
    const safetyMode = choice(input.safetyMode, ['units', 'days'], 'safetyMode');
    safetyStock = safetyMode === 'units' ? number(input.safetyStock, 'safetyStock') :
      resultNumber(dailyDemand * number(input.safetyDays, 'safetyDays', 0, 3650));
  } else {
    const dailyStdDev = number(input.dailyStdDev, 'dailyStdDev');
    const level = number(input.serviceLevelPercent, 'serviceLevelPercent', 50, 100, true);
    if (level >= 100) throw new CalculationError('out_of_range', 'serviceLevelPercent', 'Cyklusservicegraden skal være større end 50 % og mindre end 100 %.');
    zScore = inverseNormal(level / 100);
    safetyStock = resultNumber(zScore * dailyStdDev * Math.sqrt(leadDays));
    if (dailyDemand === 0 && dailyStdDev > 0) warnings.push('zero_mean_positive_variation');
    if (dailyStdDev === 0) warnings.push('zero_variation');
    warnings.push('normal_independent_daily_demand');
  }
  if (dailyDemand === 0) warnings.push('zero_demand');
  if (leadDays === 0) warnings.push('zero_lead_time');
  const reorderPoint = resultNumber(expectedDemand + safetyStock);
  return { expectedDemand, safetyStock, reorderPoint, roundedReorderPoint: ceiling(reorderPoint), zScore, warnings };
}

export function tco(input) {
  object(input);
  const periodYears = number(input.periodYears, 'periodYears', 0, 100, true);
  const annualQuantity = number(input.annualQuantity, 'annualQuantity');
  const periodQuantity = resultNumber(periodYears * annualQuantity);
  const warnings = ['undiscounted'];
  const capitalEnabled = input.capital !== undefined;
  const annualRatePercent = capitalEnabled ? number(object(input.capital, 'capital').annualRatePercent, 'capital.annualRatePercent', 0, 1000) : null;
  const ids = new Set();
  const alternatives = rows(input.alternatives, 3, 'alternatives').map((raw, index) => {
    const path = `alternatives.${index}`;
    object(raw, path);
    const id = raw.id === undefined ? String(index + 1) : label(raw.id, `${path}.id`);
    if (ids.has(id)) throw new CalculationError('duplicate_id', `${path}.id`, 'Alternativerne skal have forskellige ID’er.');
    ids.add(id);
    const name = label(raw.name, `${path}.name`);
    const ordersPerYear = number(raw.ordersPerYear, `${path}.ordersPerYear`, 0, 1e6);
    const residualValue = money(number(raw.residualValue, `${path}.residualValue`, 0, 1e12));
    const multipliers = { once: 1, year: periodYears, order: periodYears * ordersPerYear, unit: periodQuantity };
    const costIds = new Set();
    const breakdown = rows(raw.costs, MAX_TCO_COSTS, `${path}.costs`).map((cost, costIndex) => {
      const costPath = `${path}.costs.${costIndex}`;
      object(cost, costPath);
      const costId = cost.id === undefined ? String(costIndex + 1) : label(cost.id, `${costPath}.id`);
      if (costIds.has(costId)) throw new CalculationError('duplicate_id', `${costPath}.id`);
      costIds.add(costId);
      const frequency = choice(cost.frequency, ['once', 'year', 'order', 'unit'], `${costPath}.frequency`);
      const amount = number(cost.amount, `${costPath}.amount`, 0, 1e8);
      return { id: costId, label: label(cost.label, `${costPath}.label`), frequency, amount,
        multiplier: multipliers[frequency], total: money(amount * multipliers[frequency]) };
    });
    const grossCost = money(breakdown.reduce((sum, cost) => sum + cost.total, 0));
    const totalCost = money(grossCost - residualValue);
    let capital;
    if (capitalEnabled) {
      const cp = `${path}.capital`, data = object(raw.capital, cp);
      const purchaseCostId = label(data.purchaseCostId, `${cp}.purchaseCostId`, 'Vælg en eksisterende indkøbspris med frekvensen Pr. enhed.');
      const purchase = breakdown.find(cost => cost.id === purchaseCostId);
      if (!purchase || purchase.frequency !== 'unit') throw new CalculationError('purchase_cost', `${cp}.purchaseCostId`, 'Vælg en eksisterende indkøbspris med frekvensen Pr. enhed.');
      const leadDays = number(data.leadDays, `${cp}.leadDays`, 0, 3650);
      const paymentStart = choice(data.paymentStart, ['order', 'receipt', 'other'], `${cp}.paymentStart`);
      const startDay = paymentStart === 'order' ? 0 : paymentStart === 'receipt' ? leadDays : number(data.paymentStartDays, `${cp}.paymentStartDays`, 0, 3650);
      const supplierCreditDays = number(data.supplierCreditDays, `${cp}.supplierCreditDays`, 0, 3650);
      const inventoryDays = number(data.inventoryDays, `${cp}.inventoryDays`, 0, 3650);
      const customerCreditDays = number(data.customerCreditDays, `${cp}.customerCreditDays`, 0, 3650);
      const interestMode = choice(data.interestMode, ['add', 'replace', 'skip'], `${cp}.interestMode`);
      const paymentDay = resultNumber(startDay + supplierCreditDays);
      const customerPaymentDay = resultNumber(leadDays + inventoryDays + customerCreditDays);
      const netDays = resultNumber(customerPaymentDay - paymentDay);
      const annualPurchase = resultNumber(annualQuantity * purchase.amount);
      const averageCapital = resultNumber(annualPurchase * netDays / 365);
      const annualCost = resultNumber(Math.max(averageCapital, 0) * annualRatePercent / 100);
      const periodCost = money(annualCost * periodYears);
      let removedInterest = 0;
      if (interestMode === 'replace') {
        const existingInterestCostId = label(data.existingInterestCostId, `${cp}.existingInterestCostId`, 'Vælg den eksisterende omkostningspost, der indeholder renten. Varekøbet kan ikke vælges som rentepost.');
        const existing = breakdown.find(cost => cost.id === existingInterestCostId);
        if (!existing || existingInterestCostId === purchaseCostId) throw new CalculationError('interest_cost', `${cp}.existingInterestCostId`, 'Vælg den eksisterende omkostningspost, der indeholder renten. Varekøbet kan ikke vælges som rentepost.');
        const existingInterestAnnual = number(data.existingInterestAnnual, `${cp}.existingInterestAnnual`, 0, 1e12);
        const exactRemoved = resultNumber(existingInterestAnnual * periodYears);
        if (exactRemoved > existing.total + 1e-8) throw new CalculationError('interest_exceeds_cost', `${cp}.existingInterestAnnual`, 'Renten, der udskilles i perioden, må ikke overstige den valgte omkostningspost.');
        removedInterest = money(exactRemoved);
      }
      const appliedCost = interestMode === 'skip' ? 0 : periodCost;
      const timeline = [{ kind: 'order', day: 0 }, { kind: 'receipt', day: leadDays }, { kind: 'supplier', day: paymentDay }, { kind: 'customer', day: customerPaymentDay }].sort((a, b) => a.day - b.day);
      capital = { purchaseCostId, interestMode, annualRatePercent, paymentDay, customerPaymentDay, netDays,
        annualPurchase: money(annualPurchase), averageCapital: money(averageCapital), annualCost: money(annualCost), periodCost,
        removedInterest, appliedCost, totalBeforeCapital: money(totalCost - removedInterest), timeline };
      if (netDays < 0) warnings.push(`favourable_payment_terms:${id}`);
      if (interestMode === 'skip') warnings.push(`capital_addition_skipped:${id}`);
    }
    const comparisonTotalCost = capital ? money(capital.totalBeforeCapital + capital.appliedCost) : totalCost;
    if (residualValue > grossCost) warnings.push(`residual_exceeds_cost:${id}`);
    if (annualQuantity > 0 && ordersPerYear === 0 && breakdown.some(cost => cost.frequency === 'order' && cost.amount > 0)) warnings.push(`zero_orders:${id}`);
    return { id, name, breakdown, grossCost, residualValue, totalCost, comparisonTotalCost, ...(capital ? { capital } : {}), costPerUnit: periodQuantity > 0 ? resultNumber(comparisonTotalCost / periodQuantity) : null };
  });
  const lowestCost = Math.min(...alternatives.map(alt => alt.comparisonTotalCost));
  const lowestIds = alternatives.filter(alt => alt.comparisonTotalCost === lowestCost).map(alt => alt.id);
  if (annualQuantity === 0) warnings.push('no_unit_basis');
  if (!Number.isInteger(periodYears)) warnings.push('partial_year');
  return { capitalEnabled, periodQuantity, alternatives: alternatives.map(alt => ({ ...alt, differenceFromLowest: money(alt.comparisonTotalCost - lowestCost) })), lowestCost, lowestIds, warnings };
}

export function abc(input) {
  object(input);
  const thresholdA = number(input.thresholdA, 'thresholdA', 0, 100, true);
  const thresholdB = number(input.thresholdB, 'thresholdB', 0, 100, true);
  if (!(thresholdA < thresholdB && thresholdB < 100)) throw new CalculationError('threshold_order', 'thresholdB', 'Grænserne skal opfylde 0 < A < B < 100 %.');
  const items = rows(input.items, MAX_ABC_ROWS, 'items').map((item, originalIndex) => {
    const path = `items.${originalIndex}`;
    object(item, path);
    const name = label(item.name, `${path}.name`);
    const annualQuantity = number(item.annualQuantity, `${path}.annualQuantity`);
    const unitCost = number(item.unitCost, `${path}.unitCost`, 0, 1e8);
    return { name, annualQuantity, unitCost, originalIndex, annualValue: resultNumber(annualQuantity * unitCost) };
  }).sort((a, b) => b.annualValue - a.annualValue || a.originalIndex - b.originalIndex);
  const totalValue = resultNumber(items.reduce((total, item) => total + item.annualValue, 0));
  const summary = Object.fromEntries(['A', 'B', 'C'].map(key => [key, { count: 0, value: 0, sharePercent: 0 }]));
  const warnings = [];
  if (totalValue === 0) warnings.push('zero_total_value');
  if (new Set(items.map(item => item.name.toLocaleLowerCase('da'))).size !== items.length) warnings.push('duplicate_names');
  let cumulativeValue = 0;
  const tolerance = Number.EPSILON * totalValue * 8;
  const ranked = items.map(item => {
    const before = cumulativeValue;
    const classification = item.annualValue === 0 || totalValue === 0 ? 'C' :
      before < totalValue * thresholdA / 100 - tolerance ? 'A' :
      before < totalValue * thresholdB / 100 - tolerance ? 'B' : 'C';
    cumulativeValue += item.annualValue;
    summary[classification].count++;
    summary[classification].value += item.annualValue;
    return { ...item, sharePercent: totalValue ? item.annualValue / totalValue * 100 : 0,
      cumulativePercent: totalValue ? Math.min(100, cumulativeValue / totalValue * 100) : 0, class: classification };
  });
  for (const value of Object.values(summary)) value.sharePercent = totalValue ? value.value / totalValue * 100 : 0;
  return { items: ranked, totalValue, totalItems: items.length, summary, warnings };
}
