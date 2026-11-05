export class CalculationError extends Error {
  constructor(code: string, path?: string, message?: string);
  code: string;
  path: string;
}
export const MAX_ABC_ROWS: number;
export const MAX_TCO_COSTS: number;
export const SAMPLES: Record<string, Record<string, unknown>>;
export const SCHEMAS: Record<string, unknown>;
export function parseNumber(value: unknown, format?: 'da' | 'en'): number;
export function inverseNormal(probability: number): number;
export function eoq(input: unknown): Record<string, unknown>;
export function rop(input: unknown): Record<string, unknown>;
export function tco(input: unknown): Record<string, unknown>;
export function abc(input: unknown): Record<string, unknown>;
