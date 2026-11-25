# Vue 3 + Vite for the Web UI

v0.3 introduces the first frontend code into a repo that had none, and the stack ships inside the npm package. Decision (2026-11): Vue 3 + Vite, built ahead of publish; the daemon serves only the built static bundle — no SSR, no runtime frontend dependencies in the daemon. The owner works in Vue daily; a reactive task tree with filter views is exactly what a framework buys, and hand-rolling that in vanilla TypeScript costs more over time than the dependency it saves.

Considered and rejected: vanilla TS (zero deps, but hand-built reactivity for the tree and filter views); React and Svelte (both viable, neither a better fit for a local dashboard than the owner's daily tool).
