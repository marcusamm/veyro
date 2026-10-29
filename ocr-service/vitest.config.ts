import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Node cannot load Cloudflare's native module. Lifecycle tests supply only
  // the base-class context; all container operations are explicit fakes.
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/runtime.ts', import.meta.url)) } },
});
