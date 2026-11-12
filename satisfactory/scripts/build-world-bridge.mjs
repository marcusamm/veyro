import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

// Publish code only. Runtime addresses, tokens and world data are never bundled.
await mkdir('dist/client/integrations', { recursive: true });
await build({
  entryPoints: ['scripts/world-map-bridge.mjs'],
  outfile: 'dist/client/integrations/world-map-bridge.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'inline',
});
await copyFile('docs/world-map-setup.md', 'dist/client/integrations/world-map-setup.md');
console.log('Prepared the standalone world-map bridge and setup guide.');
