/** Free planning tools. These are estimates, never inventory or payment mutations. */
export type PlanningTemplateId = 'stock' | 'suppliers' | 'eoq' | 'budget';
export type PlanningValue = string | number;
export type PlanningRow = Record<string, PlanningValue>;
export interface PlanningData { settings: PlanningRow; rows: PlanningRow[] }
export interface PlanningField {
  key: string;
  type: 'text' | 'number';
  defaultValue: PlanningValue;
  min?: number;
  max?: number;
  step?: number;
}
export interface PlanningTemplate {
  id: PlanningTemplateId;
  fields: readonly PlanningField[];
  settingsFields: readonly PlanningField[];
  resultFields: readonly string[];
  summaryFields: readonly string[];
  maxRows: number;
}
export interface PlanningResult {
  templateId: PlanningTemplateId;
  rows: Array<Record<string, string | number | null>>;
  summary: Record<string, string | number | null>;
  warnings: string[];
}
export type PlanningValidationCode = 'required' | 'type' | 'range' | 'unknown_field' | 'row_count' | 'template' | 'inconsistent';
export class PlanningValidationError extends Error {
  constructor(public readonly path: string, public readonly code: PlanningValidationCode) {
    super(`${path}: ${code}`);
    this.name = 'PlanningValidationError';
  }
}

const textField = (key: string, defaultValue: string): PlanningField => ({ key, type: 'text', defaultValue });
const numberField = (key: string, defaultValue: number, min = 0, max = 1_000_000, step = 0.01): PlanningField =>
  ({ key, type: 'number', defaultValue, min, max, step });
const quantity = (key: string, defaultValue: number, min = 0): PlanningField => numberField(key, defaultValue, min, 1_000_000, 0.001);
const pack = () => quantity('packSize', 1, 0.001);
const days = (key: string, defaultValue: number) => numberField(key, defaultValue, 0, 3650, 0.1);
const percent = (key: string, defaultValue: number) => numberField(key, defaultValue, 0, 100, 0.01);
const unitPrice = (key = 'unitPrice', value = 10) => numberField(key, value, 0, 1_000_000, 0.0001);

/** Labels are translated by the UI; field keys and stored values do not change language. */
export const PLANNING_TEMPLATES: readonly PlanningTemplate[] = [
  {
    id: 'stock', maxRows: 50, settingsFields: [],
    fields: [textField('sku', 'SKU-001'), textField('item', 'New item'), textField('unit', 'pcs'),
      quantity('onHand', 0), quantity('reserved', 0), quantity('onOrder', 0), quantity('dailyDemand', 0),
      days('leadDays', 7), quantity('safetyStock', 0), days('reviewDays', 7), pack()],
    resultFields: ['available', 'inventoryPosition', 'reorderPoint', 'targetStock', 'orderQuantity', 'daysCover', 'status'],
    summaryFields: ['items', 'reorderItems', 'safetyItems'],
  },
  {
    id: 'suppliers', maxRows: 50,
    settingsFields: [textField('item', 'Packaging boxes'), textField('unit', 'pcs'), quantity('requiredQuantity', 100, 0.001)],
    fields: [textField('supplier', 'New supplier'), unitPrice(), percent('discountPercent', 0), pack(),
      quantity('minimumQuantity', 0), numberField('freight', 0), numberField('otherCosts', 0), days('leadDays', 7)],
    resultFields: ['orderQuantity', 'goodsCost', 'landedTotal', 'landedUnitCost', 'excessQuantity', 'rank', 'status'],
    summaryFields: ['requiredQuantity', 'lowestTotal', 'lowestSupplier', 'ties'],
  },
  {
    id: 'eoq', maxRows: 50, settingsFields: [],
    fields: [textField('item', 'New item'), textField('unit', 'pcs'), quantity('annualDemand', 1200),
      numberField('orderCost', 50), unitPrice('unitCost', 20), percent('holdingRatePercent', 20), pack()],
    resultFields: ['annualHoldingPerUnit', 'theoreticalEoq', 'orderQuantity', 'ordersPerYear',
      'annualOrderingCost', 'annualHoldingCost', 'annualRelevantCost', 'status'],
    summaryFields: ['items', 'calculableItems'],
  },
  {
    id: 'budget', maxRows: 50, settingsFields: [numberField('budget', 5000, 0, 1_000_000_000_000)],
    fields: [textField('item', 'New item'), textField('unit', 'pcs'), quantity('quantity', 1),
      unitPrice(), percent('discountPercent', 0), numberField('freight', 0)],
    resultFields: ['goodsCost', 'lineTotal'],
    summaryFields: ['goodsTotal', 'freightTotal', 'plannedTotal', 'budget', 'remaining', 'utilizationPercent', 'status'],
  },
];

export function isPlanningTemplateId(value: unknown): value is PlanningTemplateId {
  return typeof value === 'string' && PLANNING_TEMPLATES.some(template => template.id === value);
}
export function planningTemplate(id: PlanningTemplateId): PlanningTemplate {
  const template = PLANNING_TEMPLATES.find(item => item.id === id);
  if (!template) throw new PlanningValidationError('templateId', 'template');
  return template;
}
function defaults(fields: readonly PlanningField[]): PlanningRow {
  return Object.fromEntries(fields.map(field => [field.key, field.defaultValue]));
}
export function createPlanningRow(id: PlanningTemplateId): PlanningRow {
  return defaults(planningTemplate(id).fields);
}

/** Illustrative examples only; none is actual customer data or a live supplier price. */
export function createPlanningData(id: PlanningTemplateId): PlanningData {
  const template = planningTemplate(id);
  const row = (input: PlanningRow) => ({ ...createPlanningRow(id), ...input });
  const rows: Record<PlanningTemplateId, PlanningRow[]> = {
    stock: [
      row({ sku: 'BOX-01', item: 'Packaging boxes', unit: 'pcs', onHand: 120, reserved: 20, onOrder: 0, dailyDemand: 18, leadDays: 7, safetyStock: 40, reviewDays: 7, packSize: 25 }),
      row({ sku: 'TAPE-02', item: 'Packing tape', unit: 'rolls', onHand: 80, reserved: 5, onOrder: 24, dailyDemand: 4, leadDays: 5, safetyStock: 12, reviewDays: 7, packSize: 6 }),
      row({ sku: 'LABEL-03', item: 'Shipping labels', unit: 'pcs', onHand: 35, reserved: 15, onOrder: 0, dailyDemand: 10, leadDays: 3, safetyStock: 50, reviewDays: 7, packSize: 100 }),
    ],
    suppliers: [
      row({ supplier: 'Supplier A', unitPrice: 8.5, discountPercent: 0, packSize: 25, minimumQuantity: 100, freight: 75, otherCosts: 0, leadDays: 5 }),
      row({ supplier: 'Supplier B', unitPrice: 8.1, discountPercent: 5, packSize: 20, minimumQuantity: 100, freight: 95, otherCosts: 20, leadDays: 7 }),
      row({ supplier: 'Supplier C', unitPrice: 7.4, discountPercent: 0, packSize: 50, minimumQuantity: 200, freight: 0, otherCosts: 0, leadDays: 10 }),
    ],
    eoq: [row({ item: 'Packaging boxes', unit: 'pcs', annualDemand: 2400, orderCost: 75, unitCost: 20, holdingRatePercent: 20, packSize: 25 })],
    budget: [
      row({ item: 'Packaging boxes', unit: 'pcs', quantity: 200, unitPrice: 8.5, discountPercent: 5, freight: 75 }),
      row({ item: 'Packing tape', unit: 'rolls', quantity: 48, unitPrice: 22, discountPercent: 0, freight: 0 }),
      row({ item: 'Shipping labels', unit: 'pcs', quantity: 1000, unitPrice: 0.6, discountPercent: 0, freight: 40 }),
    ],
  };
  return { settings: defaults(template.settingsFields), rows: rows[id]! };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PlanningValidationError(path, 'type');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new PlanningValidationError(path, 'type');
  return value as Record<string, unknown>;
}
function fields(value: unknown, definitions: readonly PlanningField[], path: string): PlanningRow {
  const input = record(value, path);
  const keys = new Set(definitions.map(field => field.key));
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new PlanningValidationError(`${path}.${key}`, 'unknown_field');
  const output: PlanningRow = {};
  for (const field of definitions) {
    const at = `${path}.${field.key}`;
    const value = input[field.key];
    if (value === undefined || value === null || value === '') throw new PlanningValidationError(at, 'required');
    if (field.type === 'text') {
      if (typeof value !== 'string') throw new PlanningValidationError(at, 'type');
      const trimmed = value.trim();
      if (!trimmed) throw new PlanningValidationError(at, 'required');
      if (trimmed.length > 120 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new PlanningValidationError(at, 'range');
      output[field.key] = trimmed;
    } else {
      // No Number('') or locale guessing: a missing/ambiguous input must remain an error.
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new PlanningValidationError(at, 'type');
      if (value < field.min! || value > field.max!) throw new PlanningValidationError(at, 'range');
      // Match the input's supported precision. It also keeps arbitrarily tiny positive
      // holding costs and pack sizes from overflowing an otherwise finite calculation.
      if (field.step) {
        const scaled = value / field.step;
        if ((value > 0 && Math.round(scaled) === 0) || Math.abs(scaled - Math.round(scaled)) > Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8) {
          throw new PlanningValidationError(at, 'range');
        }
      }
      output[field.key] = Object.is(value, -0) ? 0 : value;
    }
  }
  return output;
}
export function validatePlanningData(id: PlanningTemplateId, value: unknown): PlanningData {
  const template = planningTemplate(id);
  const input = record(value, 'data');
  for (const key of Object.keys(input)) if (key !== 'settings' && key !== 'rows') throw new PlanningValidationError(`data.${key}`, 'unknown_field');
  const settings = fields(input.settings, template.settingsFields, 'settings');
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > template.maxRows) throw new PlanningValidationError('rows', 'row_count');
  const rows = input.rows.map((row, i) => fields(row, template.fields, `rows.${i}`));
  const uniqueField = id === 'stock' ? 'sku' : id === 'suppliers' ? 'supplier' : null;
  if (uniqueField) {
    const seen = new Set<string>();
    rows.forEach((row, i) => {
      const key = String(row[uniqueField]).toLowerCase();
      if (seen.has(key)) throw new PlanningValidationError(`rows.${i}.${uniqueField}`, 'inconsistent');
      seen.add(key);
    });
  }
  return { settings, rows };
}

const n = (row: PlanningRow, key: string): number => row[key] as number;
/** Keep quantities precise; suppress floating point dust at exact pack boundaries. */
const quantityRound = (value: number): number => Math.round(value * 1e6) / 1e6;
const moneyRound = (value: number): number => Math.round((value + Number.EPSILON * Math.abs(value)) * 100) / 100;
function roundToPack(quantity: number, packSize: number): number {
  const packs = quantity / packSize;
  const nearest = Math.round(packs);
  const exact = Math.abs(packs - nearest) <= Number.EPSILON * Math.max(1, Math.abs(packs)) * 8;
  return quantityRound((exact ? nearest : Math.ceil(packs)) * packSize);
}
function moneySum(amounts: number[]): number {
  return amounts.reduce((sum, amount) => sum + Math.round(amount * 100), 0) / 100;
}

/**
 * EOQ and reorder-point basis: Bartholdi & Hackman, Warehouse & Distribution
 * Science, Appendix A, https://www2.isye.gatech.edu/~jjb/wh/book/editions/wh-sci-0.97.pdf
 * Our stock target is a planning policy: demand × (lead + review days) + safety.
 */
export function calculatePlanning(id: PlanningTemplateId, value: unknown): PlanningResult {
  const data = validatePlanningData(id, value);
  if (id === 'stock') {
    const rows = data.rows.map(row => {
      const available = quantityRound(n(row, 'onHand') - n(row, 'reserved'));
      const inventoryPosition = quantityRound(available + n(row, 'onOrder'));
      const reorderPoint = quantityRound(n(row, 'dailyDemand') * n(row, 'leadDays') + n(row, 'safetyStock'));
      const targetStock = quantityRound(n(row, 'dailyDemand') * (n(row, 'leadDays') + n(row, 'reviewDays')) + n(row, 'safetyStock'));
      const orderQuantity = inventoryPosition <= reorderPoint ? roundToPack(Math.max(0, targetStock - inventoryPosition), n(row, 'packSize')) : 0;
      const safetyReached = n(row, 'onHand') <= n(row, 'safetyStock') ? 1 : 0;
      return { ...row, available, inventoryPosition, reorderPoint, targetStock, orderQuantity,
        daysCover: n(row, 'dailyDemand') > 0 ? Math.max(0, available) / n(row, 'dailyDemand') : null,
        orderNow: orderQuantity > 0 ? 1 : 0, safetyReached,
        status: safetyReached ? 'safety' : orderQuantity > 0 ? 'reorder' : 'covered' };
    });
    return { templateId: id, rows, summary: { items: rows.length,
      reorderItems: rows.filter(row => row.orderNow).length, safetyItems: rows.filter(row => row.safetyReached).length },
    warnings: ['stock_assumptions'] };
  }
  if (id === 'suppliers') {
    const requiredQuantity = n(data.settings, 'requiredQuantity');
    const rows = data.rows.map(row => {
      const orderQuantity = roundToPack(Math.max(requiredQuantity, n(row, 'minimumQuantity')), n(row, 'packSize'));
      const netUnitPrice = n(row, 'unitPrice') * (1 - n(row, 'discountPercent') / 100);
      const goodsCost = moneyRound(orderQuantity * netUnitPrice);
      const landedTotal = moneySum([goodsCost, moneyRound(n(row, 'freight')), moneyRound(n(row, 'otherCosts'))]);
      return { ...row, supplier: String(row.supplier), orderQuantity, netUnitPrice, goodsCost, landedTotal,
        landedUnitCost: landedTotal / orderQuantity, excessQuantity: quantityRound(orderQuantity - requiredQuantity), rank: 0, status: '' };
    });
    const costs = [...new Set(rows.map(row => row.landedTotal))].sort((a, b) => a - b);
    const lowestTotal = costs[0]!;
    for (const row of rows) {
      row.rank = costs.indexOf(row.landedTotal) + 1;
      row.status = row.landedTotal === lowestTotal ? 'lowest' : 'alternative';
    }
    const lowest = rows.filter(row => row.status === 'lowest');
    return { templateId: id, rows, summary: { requiredQuantity, lowestTotal,
      lowestSupplier: lowest.map(row => row.supplier).join(', '), ties: lowest.length }, warnings: ['supplier_assumptions'] };
  }
  if (id === 'eoq') {
    const rows = data.rows.map(row => {
      const demand = n(row, 'annualDemand');
      const orderCost = n(row, 'orderCost');
      const annualHoldingPerUnit = n(row, 'unitCost') * n(row, 'holdingRatePercent') / 100;
      const missing = demand > 0 && annualHoldingPerUnit === 0;
      const theoreticalEoq = missing ? null : demand === 0 ? 0 : Math.sqrt(2 * demand * orderCost / annualHoldingPerUnit);
      const orderQuantity = theoreticalEoq === null ? null : demand === 0 ? 0 : Math.max(n(row, 'packSize'), roundToPack(theoreticalEoq, n(row, 'packSize')));
      const ordersPerYear = orderQuantity === null ? null : orderQuantity > 0 ? demand / orderQuantity : 0;
      const annualOrderingCost = ordersPerYear === null ? null : moneyRound(ordersPerYear * orderCost);
      const annualHoldingCost = orderQuantity === null ? null : moneyRound(orderQuantity / 2 * annualHoldingPerUnit);
      const annualRelevantCost = annualOrderingCost === null || annualHoldingCost === null ? null : moneySum([annualOrderingCost, annualHoldingCost]);
      return { ...row, annualHoldingPerUnit, theoreticalEoq, orderQuantity, ordersPerYear,
        annualOrderingCost, annualHoldingCost, annualRelevantCost,
        status: missing ? 'missing_holding_cost' : demand === 0 ? 'zero_demand' : orderCost === 0 ? 'minimum_pack' : 'calculated' };
    });
    const calculableItems = rows.filter(row => row.status !== 'missing_holding_cost').length;
    return { templateId: id, rows, summary: { items: rows.length, calculableItems },
      warnings: ['eoq_assumptions', ...(calculableItems < rows.length ? ['zero_holding_cost'] : [])] };
  }
  const rows = data.rows.map(row => {
    const goodsCost = moneyRound(n(row, 'quantity') * n(row, 'unitPrice') * (1 - n(row, 'discountPercent') / 100));
    return { ...row, goodsCost, lineTotal: moneySum([goodsCost, moneyRound(n(row, 'freight'))]) };
  });
  const goodsTotal = moneySum(rows.map(row => row.goodsCost));
  const freightTotal = moneySum(data.rows.map(row => moneyRound(n(row, 'freight'))));
  const plannedTotal = moneySum(rows.map(row => row.lineTotal));
  const budget = moneyRound(n(data.settings, 'budget'));
  const remaining = moneySum([budget, -plannedTotal]);
  return { templateId: id, rows,
    summary: { goodsTotal, freightTotal, plannedTotal, budget, remaining,
      utilizationPercent: budget > 0 ? plannedTotal / budget * 100 : null, status: remaining < 0 ? 'over_budget' : 'within_budget' },
    warnings: ['budget_assumptions'] };
}
