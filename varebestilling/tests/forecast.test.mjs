import { describe, expect, it } from 'vitest';
import { demandStats, reorderInfo, reorderPoint, safetyStock } from '../src/lib/forecast.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings.ts';

const series = (values) => new Map(values.map((q, d) => [d, q]).filter(([, q]) => q > 0));

describe('Sikkerhedslager og genbestillingspunkt', () => {
  it('regner dage uden salg med som 0', () => {
    // 2 pr. dag hver anden dag over 10 dage: gennemsnit 1, standardafvigelse ~1,054
    const s = demandStats(series([2, 0, 2, 0, 2, 0, 2, 0, 2, 0]), 10);
    expect(s.avg).toBe(1);
    expect(s.sd).toBeCloseTo(1.054, 3);
  });

  it('beregner sikkerhedslager og genbestillingspunkt ud fra leveringstid og sikkerhed', () => {
    const stats = { avg: 4, sd: 2, days: 90 };
    const safety = safetyStock(stats, 9, 95); // 1,65 × 2 × 3 = 9,9
    expect(safety).toBe(10);
    expect(reorderPoint(stats, 9, safety)).toBe(46); // 4 × 9 + 10
    expect(safetyStock(stats, 9, 99)).toBe(14); // 2,33 × 2 × 3 = 13,98
    expect(safetyStock({ avg: 4, sd: 0, days: 90 }, 9, 95)).toBe(0); // helt jævnt salg
  });

  it('varsler i god tid, før genbestillingspunktet nås', () => {
    const base = { low_stock_threshold: null, auto_reorder_point: 20, auto_safety_stock: 5, avg_daily_demand: 2, lead_time_days: null, reserved: 4 };
    const s = { ...DEFAULT_SETTINGS, reorder_warn_days: 7, lead_time_days: 5 };
    // 40 disponible, punkt 20, 2 pr. dag: 10 dage til genbestilling = god tid
    expect(reorderInfo({ ...base, stock: 44 }, s)).toMatchObject({ available: 40, automatic: true, daysToReorder: 10, daysToEmpty: 20, urgency: 'ok' });
    // 30 disponible: 5 dage til punktet = inden for varslingsperioden
    expect(reorderInfo({ ...base, stock: 34 }, s)).toMatchObject({ daysToReorder: 5, urgency: 'soon' });
    // Under punktet: bestil nu. Foreslået: 2 × (5 + 30) + 5 − 18 = 57
    expect(reorderInfo({ ...base, stock: 22 }, s)).toMatchObject({ urgency: 'now', suggestQty: 57 });
    // Et fast minimum vinder over det beregnede
    expect(reorderInfo({ ...base, stock: 40, low_stock_threshold: 3 }, s)).toMatchObject({ limit: 3, automatic: false, urgency: 'ok' });
  });
});
