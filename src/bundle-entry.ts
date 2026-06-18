// Minimal entry point for the esbuild bundle.
// Only exports default so OpenCode's plugin loader doesn't find and try to
// call named exports (like ExecutionStore) as plugin functions.
export { default } from "./index.js"
