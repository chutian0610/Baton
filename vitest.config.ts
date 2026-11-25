import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    // The process-level daemon suite (tests/) and the Web UI suite
    // (ui/tests/, which also boots real daemons) run in one `vitest run`.
    include: ['tests/**/*.test.ts', 'ui/tests/**/*.test.ts'],
    // Tests boot the real daemon as a subprocess; file-level isolation (the
    // default) gives every file its own temp data dir and daemon instance.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // The mounted-component tests talk to a daemon on a dynamic port, which
    // is cross-origin relative to the DOM window — happy-dom's same-origin
    // policy must stand down inside the test environment. (Production needs
    // none of this: the bundle is served by the daemon itself, ADR-0006.)
    environmentOptions: {
      // the env setup destructures `happyDOM` verbatim — key casing matters
      happyDOM: {
        settings: {
          fetch: { disableSameOriginPolicy: true },
        },
      },
    },
  },
});
