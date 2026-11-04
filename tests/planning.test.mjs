import { describe, it, expect } from 'vitest';
import {
  PLANNING_TEMPLATES, PlanningValidationError, calculatePlanning, createPlanningData,
  createPlanningRow, isPlanningTemplateId, planningTemplate, validatePlanningData,
} from '../src/lib/planning';

function data(id, row = {}, settings = {}) {
  return { settings: { ...createPlanningData(id).settings, ...settings }, rows: [{ ...createPlanningRow(id), ...row }] };
}
function rejects(id, value, path, code) {
  try { validatePlanningData(id, value); expect.fail('Expected validation rejection'); }
  catch (error) {
    expect(error).toBeInstanceOf(PlanningValidationError);
    expect(error.path).toBe(path);
    expect(error.code).toBe(code);
  }
}

describe('Planning schemas and input validation', () => {
  it.each(PLANNING_TEMPLATES.map(template => [template.id]))('validates and calculates the %s example', id => {
    const example = createPlanningData(id);
    const before = JSON.stringify(example);
    const validated = validatePlanningData(id, example);
    expect(validated).toEqual(example);
    expect(calculatePlanning(id, example).rows).toHaveLength(example.rows.length);
    expect(JSON.stringify(example)).toBe(before);
    expect(isPlanningTemplateId(id)).toBe(true);
    const allNumeric = JSON.stringify(calculatePlanning(id, example));
    expect(allNumeric).not.toMatch(/NaN|Infinity/);
  });

  it('rejects unknown template IDs and does not share mutable sample inputs', () => {
    expect(isPlanningTemplateId('__proto__')).toBe(false);
    expect(() => planningTemplate('unknown')).toThrow(PlanningValidationError);
    const a = createPlanningData('stock');
    a.rows[0].item = 'Changed';
    expect(createPlanningData('stock').rows[0].item).toBe('Packaging boxes');
  });

  it.each([undefined, null, '', '   '])('does not convert a missing item label to a valid row: %j', missing => {
    rejects('stock', data('stock', { item: missing }), 'rows.0.item', 'required');
  });
  it.each([undefined, null, ''])('does not convert a missing numeric input to zero: %j', missing => {
    rejects('stock', data('stock', { onHand: missing }), 'rows.0.onHand', 'required');
  });
  it.each([NaN, Infinity, -Infinity, '1,000', '1.000', '=SUM(A1:A2)', true])('rejects ambiguous or nonnumeric values: %j', invalid => {
    rejects('budget', data('budget', { quantity: invalid }), 'rows.0.quantity', 'type');
  });
  it.each([
    ['stock', 'packSize', 0], ['stock', 'onHand', -1], ['stock', 'leadDays', 3651],
    ['suppliers', 'discountPercent', 101], ['suppliers', 'freight', -1],
    ['eoq', 'holdingRatePercent', -0.1], ['budget', 'unitPrice', 1_000_001],
    ['eoq', 'holdingRatePercent', 1e-300], ['eoq', 'unitCost', 0.0000001],
  ])('rejects out-of-range %s.%s=%s', (id, field, value) => {
    rejects(id, data(id, { [field]: value }), `rows.0.${field}`, 'range');
  });
  it('rejects arbitrary fields, prototypes and too many rows', () => {
    rejects('budget', { ...data('budget'), currency: 'EUR' }, 'data.currency', 'unknown_field');
    rejects('budget', data('budget', { formula: '=1+1' }), 'rows.0.formula', 'unknown_field');
    rejects('budget', data('budget', {}, { total: 10 }), 'settings.total', 'unknown_field');
    rejects('budget', { settings: {}, rows: [] }, 'settings.budget', 'required');
    rejects('stock', { settings: {}, rows: [] }, 'rows', 'row_count');
    rejects('budget', { settings: { budget: 100 }, rows: Array(51).fill(createPlanningRow('budget')) }, 'rows', 'row_count');
    rejects('stock', Object.create({ settings: {}, rows: [] }), 'data', 'type');
  });
  it('rejects repeated stock identifiers and supplier labels after normalization', () => {
    const stock = data('stock');
    stock.rows.push({ ...stock.rows[0], sku: ' sku-001 ' });
    rejects('stock', stock, 'rows.1.sku', 'inconsistent');
    const supplier = data('suppliers');
    supplier.rows.push({ ...supplier.rows[0], supplier: ' new SUPPLIER ' });
    rejects('suppliers', supplier, 'rows.1.supplier', 'inconsistent');
  });
  it('accepts zero values and trims labels without changing semantic units', () => {
    const value = validatePlanningData('stock', data('stock', { item: '  Timber  ', unit: 'm', onHand: -0 }));
    expect(value.rows[0].item).toBe('Timber');
    expect(value.rows[0].unit).toBe('m');
    expect(Object.is(value.rows[0].onHand, -0)).toBe(false);
  });
});

describe('Reorder planning', () => {
  it('includes safety once, reserves stock, includes outstanding orders and rounds packs upward', () => {
    const result = calculatePlanning('stock', data('stock', {
      onHand: 100, reserved: 20, onOrder: 25, dailyDemand: 10, leadDays: 7,
      safetyStock: 40, reviewDays: 14, packSize: 12,
    }));
    expect(result.rows[0]).toMatchObject({ available: 80, inventoryPosition: 105, reorderPoint: 110,
      targetStock: 250, orderQuantity: 156, daysCover: 8, orderNow: 1, safetyReached: 0, status: 'reorder' });
    expect(result.summary).toEqual({ items: 1, reorderItems: 1, safetyItems: 0 });
  });
  it('reorders at the exact threshold but not above it', () => {
    const input = data('stock', { onHand: 110, dailyDemand: 10, leadDays: 7, safetyStock: 40, reviewDays: 7, packSize: 10 });
    expect(calculatePlanning('stock', input).rows[0].orderQuantity).toBe(70);
    input.rows[0].onHand = 110.001;
    expect(calculatePlanning('stock', input).rows[0]).toMatchObject({ orderQuantity: 0, status: 'covered' });
  });
  it('reports physical safety independently when incoming stock covers the order requirement', () => {
    const result = calculatePlanning('stock', data('stock', {
      onHand: 10, onOrder: 200, dailyDemand: 10, leadDays: 5, safetyStock: 20, reviewDays: 7,
    }));
    expect(result.rows[0]).toMatchObject({ inventoryPosition: 210, orderQuantity: 0, safetyReached: 1, status: 'safety' });
    expect(result.summary).toMatchObject({ reorderItems: 0, safetyItems: 1 });
  });
  it('retains reservation shortages and never invents infinite days of cover', () => {
    const result = calculatePlanning('stock', data('stock', { onHand: 10, reserved: 30, dailyDemand: 0, safetyStock: 5, packSize: 10 }));
    expect(result.rows[0]).toMatchObject({ available: -20, inventoryPosition: -20, targetStock: 5, orderQuantity: 30, daysCover: null });
  });
  it('does not add an extra pack due to decimal floating-point dust', () => {
    const result = calculatePlanning('stock', data('stock', { onHand: 0, safetyStock: 0.3, dailyDemand: 0, packSize: 0.1 }));
    expect(result.rows[0].orderQuantity).toBe(0.3);
  });
});

describe('Supplier comparison', () => {
  it('covers demand and MOQ with complete packs before applying discount and charges', () => {
    const result = calculatePlanning('suppliers', data('suppliers', {
      unitPrice: 2, packSize: 20, minimumQuantity: 150, discountPercent: 10, freight: 20, otherCosts: 5,
    }, { requiredQuantity: 101 }));
    expect(result.rows[0]).toMatchObject({ orderQuantity: 160, netUnitPrice: 1.8, goodsCost: 288,
      landedTotal: 313, landedUnitCost: 313 / 160, excessQuantity: 59, rank: 1, status: 'lowest' });
    expect(result.summary.lowestTotal).toBe(313);
  });
  it('ranks total purchase cost, not a misleading low unit price requiring excess stock', () => {
    const input = data('suppliers', { supplier: 'Small order', unitPrice: 10, minimumQuantity: 100 }, { requiredQuantity: 100 });
    input.rows.push({ ...input.rows[0], supplier: 'Bulk order', unitPrice: 6, minimumQuantity: 200 });
    const result = calculatePlanning('suppliers', input);
    expect(result.summary.lowestSupplier).toBe('Small order');
    expect(result.rows[1]).toMatchObject({ landedUnitCost: 6, landedTotal: 1200, rank: 2 });
  });
  it('flags ties and responds when freight changes the cheapest supplier', () => {
    const input = data('suppliers', { supplier: 'A', unitPrice: 10 }, { requiredQuantity: 100 });
    input.rows.push({ ...input.rows[0], supplier: 'B' });
    expect(calculatePlanning('suppliers', input).summary).toMatchObject({ lowestSupplier: 'A, B', ties: 2 });
    input.rows[0].freight = 1;
    expect(calculatePlanning('suppliers', input).summary).toMatchObject({ lowestSupplier: 'B', ties: 1 });
  });
  it('requires one item, one unit and positive common demand', () => {
    rejects('suppliers', data('suppliers', {}, { requiredQuantity: 0 }), 'settings.requiredQuantity', 'range');
    rejects('suppliers', data('suppliers', { unit: 'kg' }), 'rows.0.unit', 'unknown_field');
    rejects('suppliers', data('suppliers', {}, { unit: '' }), 'settings.unit', 'required');
  });
});

describe('Economic order quantity', () => {
  it('uses annual holding cost per unit and the same year basis for costs and demand', () => {
    const result = calculatePlanning('eoq', data('eoq', { annualDemand: 2400, orderCost: 75, unitCost: 20, holdingRatePercent: 20, packSize: 25 }));
    expect(result.rows[0]).toMatchObject({ annualHoldingPerUnit: 4, theoreticalEoq: 300,
      orderQuantity: 300, ordersPerYear: 8, annualOrderingCost: 600, annualHoldingCost: 600, annualRelevantCost: 1200, status: 'calculated' });
  });
  it('rounds the suggested quantity up to a whole pack and recalculates both annual costs', () => {
    const result = calculatePlanning('eoq', data('eoq', { annualDemand: 2400, orderCost: 75, unitCost: 20, holdingRatePercent: 20, packSize: 80 }));
    expect(result.rows[0]).toMatchObject({ theoreticalEoq: 300, orderQuantity: 320, ordersPerYear: 7.5,
      annualOrderingCost: 562.5, annualHoldingCost: 640, annualRelevantCost: 1202.5 });
  });
  it('returns zero orders for zero demand even when holding cost is zero', () => {
    const result = calculatePlanning('eoq', data('eoq', { annualDemand: 0, unitCost: 0, holdingRatePercent: 0 }));
    expect(result.rows[0]).toMatchObject({ theoreticalEoq: 0, orderQuantity: 0, ordersPerYear: 0,
      annualOrderingCost: 0, annualHoldingCost: 0, annualRelevantCost: 0, status: 'zero_demand' });
  });
  it('marks positive demand with no holding cost as uncalculable rather than healthy zero', () => {
    const result = calculatePlanning('eoq', data('eoq', { holdingRatePercent: 0 }));
    expect(result.rows[0]).toMatchObject({ theoreticalEoq: null, orderQuantity: null, annualRelevantCost: null, status: 'missing_holding_cost' });
    expect(result.summary.calculableItems).toBe(0);
    expect(result.warnings).toContain('zero_holding_cost');
  });
  it('uses the minimum pack when the fixed order cost is zero', () => {
    const result = calculatePlanning('eoq', data('eoq', { annualDemand: 1200, orderCost: 0, unitCost: 10, holdingRatePercent: 20, packSize: 12 }));
    expect(result.rows[0]).toMatchObject({ theoreticalEoq: 0, orderQuantity: 12, ordersPerYear: 100,
      annualOrderingCost: 0, annualHoldingCost: 12, annualRelevantCost: 12, status: 'minimum_pack' });
  });
});

describe('Purchasing budget', () => {
  it('reconciles discounted goods and explicit freight to the budget', () => {
    const input = data('budget', { quantity: 10, unitPrice: 12.5, discountPercent: 20, freight: 15 }, { budget: 200 });
    input.rows.push({ ...input.rows[0], item: 'Second item', quantity: 5, unitPrice: 10, discountPercent: 0, freight: 5 });
    const result = calculatePlanning('budget', input);
    expect(result.rows.map(row => row.lineTotal)).toEqual([115, 55]);
    expect(result.summary).toEqual({ goodsTotal: 150, freightTotal: 20, plannedTotal: 170, budget: 200,
      remaining: 30, utilizationPercent: 85, status: 'within_budget' });
    input.settings.budget = 100;
    expect(calculatePlanning('budget', input).summary).toMatchObject({ remaining: -70, utilizationPercent: 170, status: 'over_budget' });
  });
  it('uses currency cents per line so displayed lines reconcile exactly', () => {
    const input = data('budget', { quantity: 1, unitPrice: 1.005, freight: 0.01 }, { budget: 10 });
    input.rows.push({ ...input.rows[0], item: 'Another item' });
    const result = calculatePlanning('budget', input);
    expect(result.rows[0]).toMatchObject({ goodsCost: 1.01, lineTotal: 1.02 });
    expect(result.summary).toMatchObject({ goodsTotal: 2.02, freightTotal: 0.02, plannedTotal: 2.04, remaining: 7.96 });
  });
  it('shows no percentage for a zero budget and includes explicitly entered freight', () => {
    const result = calculatePlanning('budget', data('budget', { quantity: 0, freight: 10 }, { budget: 0 }));
    expect(result.summary).toMatchObject({ goodsTotal: 0, freightTotal: 10, plannedTotal: 10, remaining: -10,
      utilizationPercent: null, status: 'over_budget' });
  });
});
