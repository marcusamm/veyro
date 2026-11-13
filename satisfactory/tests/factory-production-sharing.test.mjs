import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `export * from './app/factory/production-sharing.ts'; export * from './app/factory/production-validation.ts'; export * from './app/factory/templates.ts'; export * from './app/factory/engine.ts';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { encodeProductionShare, decodeProductionShare, validateProductionDraft, createDefaultProductionDraft, templateRequest, catalog, MAX_PRODUCTION_SHARE_TOKEN_LENGTH, MAX_PRODUCTION_SHARE_BYTES } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

async function rawToken(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const result = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return Buffer.from(result).toString('base64url');
}

test('share tokens round-trip a strict production draft without network or server state', async () => {
  const draft = createDefaultProductionDraft(), before = structuredClone(draft);
  const token = await encodeProductionShare(draft);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.ok(token.length < MAX_PRODUCTION_SHARE_TOKEN_LENGTH);
  assert.deepEqual(await decodeProductionShare(token), draft);
  assert.deepEqual(draft, before);
  assert.equal(token.includes('https:'), false);
});

test('non-ASCII names and complete template recipe whitelists survive sharing', async () => {
  const draft = validateProductionDraft({ name: 'Rotorværksted · Ålborg 🏭 — 鋼鐵', request: templateRequest('motors', 2.5), templateId: 'motors', scale: 2.5 });
  assert.ok(draft.request.excludedRecipes.length > 250);
  const token = await encodeProductionShare(draft);
  assert.deepEqual(await decodeProductionShare(token), draft);
});

test('share encoder rejects unknown and invalid fields before compression', async () => {
  await assert.rejects(encodeProductionShare({ ...createDefaultProductionDraft(), secret: 'must-not-be-shared' }), /unknown field/);
  const draft = createDefaultProductionDraft();
  draft.request.recipeClocks = { not_a_recipe: 100 };
  await assert.rejects(encodeProductionShare(draft), /catalog/);
  const invalidRate = createDefaultProductionDraft();
  invalidRate.request.outputs[0].rate = Infinity;
  await assert.rejects(encodeProductionShare(invalidRate), /finite number/);
});

test('decoder rejects malformed, oversized and non-gzip tokens', async () => {
  for (const token of ['', 'a', '***', 'a+b/c=', 'valid_looking.with_dot', Buffer.from('{}').toString('base64url')]) await assert.rejects(decodeProductionShare(token));
  await assert.rejects(decodeProductionShare('A'.repeat(MAX_PRODUCTION_SHARE_TOKEN_LENGTH + 1)), /30 KB/);
  await assert.rejects(decodeProductionShare(null));
});

test('gzip integrity failures and truncated tokens cannot import a partial plan', async () => {
  const token = await encodeProductionShare(createDefaultProductionDraft());
  const corrupted = Buffer.from(token, 'base64url');
  corrupted[corrupted.length - 8] ^= 0xff; // Gzip CRC, not a JSON field.
  await assert.rejects(decodeProductionShare(corrupted.toString('base64url')), /damaged or incomplete/);
  const truncated = Buffer.from(token, 'base64url').subarray(0, -4);
  await assert.rejects(decodeProductionShare(truncated.toString('base64url')), /damaged or incomplete/);
});

test('decoded data must be valid UTF-8 JSON and a strict known production draft', async () => {
  await assert.rejects(decodeProductionShare(await rawToken(new Uint8Array([0xc3, 0x28]))), /UTF-8 JSON/);
  await assert.rejects(decodeProductionShare(await rawToken('not JSON')), /UTF-8 JSON/);
  await assert.rejects(decodeProductionShare(await rawToken(JSON.stringify({ ...createDefaultProductionDraft(), unexpected: true }))), /unknown field/);
  const draft = createDefaultProductionDraft();
  draft.request.outputs[0].itemId = 'Desc_FakeItem_C';
  await assert.rejects(decodeProductionShare(await rawToken(JSON.stringify(draft))), /catalog/);
  const nestedUnknown = createDefaultProductionDraft();
  nestedUnknown.request.remoteUrl = 'https://example.invalid';
  await assert.rejects(decodeProductionShare(await rawToken(JSON.stringify(nestedUnknown))), /unknown field/);
});

test('highly compressed oversized payloads are stopped while reading the decompression stream', async () => {
  const payload = JSON.stringify({ name: 'x'.repeat(MAX_PRODUCTION_SHARE_BYTES * 20), request: createDefaultProductionDraft().request });
  const token = await rawToken(payload);
  assert.ok(token.length < MAX_PRODUCTION_SHARE_TOKEN_LENGTH, 'compressed input fits the URL limit');
  await assert.rejects(decodeProductionShare(token), /expands beyond the 100 KB limit/);
});

test('share round-trip preserves all allowed recipe choices, clock overrides and multipliers', async () => {
  const draft = createDefaultProductionDraft();
  draft.request.allowedAlternates = catalog.recipes.filter(recipe => recipe.alternate).map(recipe => recipe.id);
  draft.request.recipeClocks = Object.fromEntries(catalog.recipes.map(recipe => [recipe.id, 137.5]));
  draft.request.settings = { recipeMultiplier: 0.75, powerMultiplier: 1.25 };
  draft.request.inputs = [{ itemId: 'Desc_OreIron_C', rate: 240 }];
  draft.request.resourcePolicy = 'closed';
  const checked = validateProductionDraft(draft);
  assert.deepEqual(await decodeProductionShare(await encodeProductionShare(draft)), checked);
});
