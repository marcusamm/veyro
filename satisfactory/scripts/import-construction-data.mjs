/** Construction costs from the same reviewed game export as the production catalog. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const sourceUrl = 'https://api.new.satisfactorytools.com/data/versions/stable-26281294.json';
const sourceSha256 = 'fddecaa07cdb77022f2e2d87c664617b8905882b10e4da43245638597240ee0c';
const bytes = process.argv[2] ? await readFile(process.argv[2]) : new Uint8Array(await (await fetch(sourceUrl)).arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== sourceSha256) throw new Error('Construction source hash differs from the reviewed game-data pin.');
const { data, metadata } = JSON.parse(Buffer.from(bytes).toString('utf8'));
if (metadata.version !== '1.2.5.0' || metadata.buildId !== '26281294' || metadata.ficsmas) throw new Error('Unexpected game version.');
const catalog = JSON.parse(await readFile(new URL('../app/factory/data/satisfactory-1.2.json', import.meta.url), 'utf8'));
const ids = [...catalog.machines, ...catalog.extractors].map(machine => machine.id);
const costs = {};
for (const id of ids) {
  const matches = Object.values(data.recipes).filter(recipe => recipe.inBuildGun && recipe.products.length === 1 && recipe.products[0].item === id && recipe.products[0].amount === 1);
  if (matches.length !== 1 || !matches[0].ingredients.length) throw new Error(`Expected one nonempty building recipe for ${id}.`);
  costs[id] = matches[0].ingredients.map(row => {
    if (!data.items[row.item] || !Number.isSafeInteger(row.amount) || row.amount <= 0) throw new Error(`Invalid construction material in ${id}.`);
    return { itemId: row.item, rate: row.amount };
  });
}
const output = { provenance: { gameVersion: metadata.version, steamBuildId: metadata.buildId, sourceUrl, sourceSha256, recipeFilter: 'inBuildGun; one building per recipe', license: 'MIT (Satisfactory Tools); game content belongs to Coffee Stain Studios' }, costs };
await writeFile(new URL('../app/factory/data/construction-costs.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(`Imported exact construction costs for ${ids.length} production and extraction buildings.`);
