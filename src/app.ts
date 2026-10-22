/**
 * @file src/app.ts
 *
 * Re-exports `createApp` from `src/index.ts` so that any tooling or tests that
 * previously imported from this module continue to work without modification.
 *
 * The canonical app factory now lives entirely in `src/index.ts`. This shim
 * exists only for backwards-compatibility; prefer importing from `./index`
 * directly in new code.
 */
export { createApp } from './index';
