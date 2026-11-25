import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The process-level daemon suite (tests/) and the Web UI suite
    // (ui/tests/, which also boots real daemons) run in one `vitest run`.
    include: ['tests/**/*.test.ts', 'ui/tests/**/*.test.ts'],
    // Tests boot the real daemon as a subprocess; file-level isolation (the
    // default) gives every file its own temp data dir and daemon instance.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
