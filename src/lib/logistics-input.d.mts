export type LogisticsToolId = 'eoq' | 'genbestilling' | 'tco' | 'abc';
export type LogisticsInput = Record<string, unknown>;
export {CalculationError, CalculationError as LogisticsValidationError} from './logistics-calculations.mjs';
export const MAX_SAVED_INPUT_BYTES: number;
export function canonicalizeInput(toolId: string, raw: unknown): LogisticsInput;
export function validateLogisticsInput(toolId: string, input: unknown): LogisticsInput;
