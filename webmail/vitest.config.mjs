import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['webmail/gateway.test.mjs'] },
});
