import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['webmail/*.test.mjs'] },
});
