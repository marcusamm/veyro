import { itemById, machineById, recipeById, transportCapacity } from './engine';
import type { ProductionRequest } from './production';
import type { ExtractionOptions } from './construction';

export type ProductionDraft = { name: string; request: ProductionRequest; templateId?: string; scale?: number; extraction?: ExtractionOptions };
export class ProductionValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ProductionValidationError'; }
}
const fail = (message: string): never => { throw new ProductionValidationError(message); };
const optional = (value: unknown, fallback: unknown): unknown => value === undefined ? fallback : value;
function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(`${context} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(`${context} must be a plain object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${context}: unknown field ${key}.`);
}
function text(value: unknown, context: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(`${context} must be non-empty text of at most ${max} characters.`);
  return value;
}
function id(value: unknown, context: string): string {
  const result = text(value, context, 128);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) return fail(`${context} is not a valid identifier.`);
  return result;
}
function number(value: unknown, context: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fail(`${context} must be a finite number between ${min} and ${max}.`);
  return value;
}
function integer(value: unknown, context: string, min: number, max: number): number {
  const result = number(value, context, min, max);
  if (!Number.isInteger(result)) return fail(`${context} must be a whole number.`);
  return result;
}
function knownItem(value: unknown, context: string): string {
  const result = id(value, context);
  if (!Object.hasOwn(itemById, result)) return fail(`${context} is not in the Satisfactory catalog.`);
  return result;
}
function knownRecipe(value: unknown, context: string): string {
  const result = id(value, context);
  if (!Object.hasOwn(recipeById, result)) return fail(`${context} is not in the Satisfactory catalog.`);
  return result;
}
function list(value: unknown, context: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return fail(`${context} must contain ${min}–${max} entries.`);
  return value;
}
function recipeList(value: unknown, context: string): string[] {
  const result = list(value, context, 0, 512).map(entry => knownRecipe(entry, context));
  if (new Set(result).size !== result.length) fail(`${context} contains duplicate recipes.`);
  return result;
}

function rateList(value: unknown, context: string, minCount: number, maxCount: number, minRate: number) {
  const seen = new Set<string>();
  return list(value, context, minCount, maxCount).map((entry, index) => {
    const raw = record(entry, `${context} ${index + 1}`);
    fields(raw, ['itemId', 'rate'], context);
    const itemId = knownItem(raw.itemId, `${context} item`);
    if (seen.has(itemId)) fail(`${context} must not repeat the same item.`);
    seen.add(itemId);
    return { itemId, rate: number(raw.rate, `${context} rate`, minRate, 10_000_000) };
  });
}
function dictionary(value: unknown, context: string): Record<string, unknown> {
  const result = record(value, context);
  if (Object.keys(result).length > 512) fail(`${context} may contain at most 512 entries.`);
  return result;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], context: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return fail(`${context} is not supported.`);
  return value as T;
}

/** Checks an untrusted request without calculating or importing the production solver. */
function validateRequest(input: unknown): ProductionRequest {
  const raw = record(input, 'Production request');
  fields(raw, ['outputs', 'inputs', 'allowedAlternates', 'allowedConverters', 'excludedRecipes', 'recipeOverrides', 'clock', 'recipeClocks', 'sloops', 'somersloopBudget', 'powerShardBudget', 'beltTier', 'pipeTier', 'settings', 'mode', 'optimization', 'resourcePolicy', 'capInputs'], 'Production request');
  const settings = record(optional(raw.settings, { recipeMultiplier: 1, powerMultiplier: 1 }), 'Production settings');
  fields(settings, ['recipeMultiplier', 'powerMultiplier'], 'Production settings');
  const beltTier = integer(optional(raw.beltTier, 3), 'Belt tier', 1, 6), pipeTier = integer(optional(raw.pipeTier, 1), 'Pipe tier', 1, 2);
  if (!transportCapacity('belt', beltTier) || !transportCapacity('pipe', pipeTier)) fail('Unsupported transport tier.');
  const recipeOverrides: Record<string, string> = {}, recipeClocks: Record<string, number> = {}, sloops: Record<string, number> = {};
  for (const [key, value] of Object.entries(dictionary(optional(raw.recipeOverrides, {}), 'Recipe choices'))) {
    const itemId = knownItem(key, 'Recipe choice item'), recipeId = knownRecipe(value, 'Recipe choice');
    if (recipeById[recipeId].products[0]?.itemId !== itemId) fail('A selected recipe must make the chosen item as its main product.');
    recipeOverrides[itemId] = recipeId;
  }
  for (const [key, value] of Object.entries(dictionary(optional(raw.recipeClocks, {}), 'Recipe clocks'))) {
    const recipeId = knownRecipe(key, 'Recipe clock');
    recipeClocks[recipeId] = number(value, 'Recipe clock speed', 1, 250);
  }
  for (const [key, value] of Object.entries(dictionary(optional(raw.sloops, {}), 'Somersloops'))) {
    const recipeId = knownRecipe(key, 'Somersloop recipe');
    sloops[recipeId] = integer(value, 'Somersloops per machine', 0, machineById[recipeById[recipeId].machineId].sloopSlots ?? 0);
  }
  if (raw.capInputs !== undefined && typeof raw.capInputs !== 'boolean') fail('Input caps must be true or false.');
  return {
    outputs: rateList(raw.outputs, 'Output targets', 1, 12, 0.000001),
    inputs: rateList(optional(raw.inputs, []), 'Available inputs', 0, 32, 0),
    allowedAlternates: recipeList(optional(raw.allowedAlternates, []), 'Allowed alternate recipes'),
    allowedConverters: recipeList(optional(raw.allowedConverters, []), 'Allowed converter recipes'),
    excludedRecipes: recipeList(optional(raw.excludedRecipes, []), 'Excluded recipes'),
    recipeOverrides, recipeClocks, sloops,
    ...(raw.somersloopBudget === undefined ? {} : { somersloopBudget: integer(raw.somersloopBudget, 'Somersloop budget', 0, 10000) }),
    ...(raw.powerShardBudget === undefined ? {} : { powerShardBudget: integer(raw.powerShardBudget, 'Power Shard budget', 0, 10000) }),
    clock: number(optional(raw.clock, 100), 'Clock speed', 1, 250), beltTier, pipeTier,
    settings: { recipeMultiplier: number(settings.recipeMultiplier, 'Recipe Cost multiplier', 0.25, 2), powerMultiplier: number(settings.powerMultiplier, 'Power multiplier', 0.25, 5) },
    mode: choice(optional(raw.mode, 'target'), ['target', 'maximize'] as const, 'Calculation mode'),
    optimization: choice(optional(raw.optimization, 'resources'), ['resources', 'power', 'buildings'] as const, 'Optimization'),
    resourcePolicy: choice(optional(raw.resourcePolicy, 'open'), ['open', 'closed'] as const, 'Resource policy'),
    capInputs: raw.capInputs === undefined ? raw.mode === 'maximize' : raw.capInputs as boolean,
  };
}

/** Validates and deep-copies shared/imported calculator state; results are calculated client-side. */
export function validateProductionDraft(input: unknown): ProductionDraft {
  const raw = record(input, 'Production draft');
  fields(raw, ['name', 'request', 'templateId', 'scale', 'extraction'], 'Production draft');
  const result: ProductionDraft = { name: text(raw.name, 'Production plan name', 100), request: validateRequest(raw.request) };
  if (raw.templateId !== undefined) result.templateId = id(raw.templateId, 'Template ID');
  if (raw.scale !== undefined) result.scale = number(raw.scale, 'Template scale', 0.01, 1000);
  if (raw.extraction !== undefined) {
    const value = record(raw.extraction, 'Extraction options');
    fields(value, ['minerTier', 'purity', 'clock'], 'Extraction options');
    result.extraction = { minerTier: integer(optional(value.minerTier, 1), 'Miner tier', 1, 3) as 1 | 2 | 3,
      purity: choice(optional(value.purity, 'normal'), ['impure', 'normal', 'pure'] as const, 'Node purity'),
      clock: number(optional(value.clock, 100), 'Extraction clock', 1, 250) };
  }
  return result;
}

/** A fresh shared draft uses the same explicit defaults in the browser and API. */
export function createDefaultProductionDraft(): ProductionDraft {
  return validateProductionDraft({ name: 'Our production plan', request: { outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], clock: 100, beltTier: 3, pipeTier: 1, settings: { recipeMultiplier: 1, powerMultiplier: 1 } } });
}
