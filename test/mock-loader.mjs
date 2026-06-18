/**
 * Custom ES module loader for the test suite.
 *
 * Intercepts imports of Bun-only and missing packages and returns minimal
 * stubs so that tests can run under Node 22 without the Bun runtime or
 * npm install.
 *
 * Pass via NODE_OPTIONS so child processes (spawned by node:test) also
 * get the loader:
 *
 *   NODE_OPTIONS="--import ./test/mock-loader.mjs" node --test ...
 *
 * The resolve hook converts stubbed specifiers to data: URLs.
 * The load hook serves the source for those data: URLs.
 */

const STUB_PREFIX = "data:text/javascript;stub="

const stubs = {
  "bun:sqlite": `
import { DatabaseSync } from "node:sqlite";
export { DatabaseSync as Database };
`,

  "@opencode-ai/plugin": `
export function tool(def) { return def; }
const schemaField = () => {
  const field = { describe: () => field, optional: () => field };
  return field;
};
tool.schema = { string: schemaField };
export default {};
`,

  "@opencode-ai/plugin/tool": `
export function tool(def) { return def; }
const schemaField = () => {
  const field = { describe: () => field, optional: () => field };
  return field;
};
tool.schema = { string: schemaField };
export { tool as default };
`,

  "@opencode-ai/sdk": `export default {};`,
}

const STUB_SPECIFIERS = new Set(Object.keys(stubs))

// Rewrite .js imports to .ts so Node's strip-types loader can find them.
// This is needed because src/* uses NodeNext module resolution (.js extensions)
// but the actual files on disk are .ts.
function rewriteJsToTs(specifier, parentUrl) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) return null
  if (!parentUrl) return null
  try {
    const resolved = new URL(specifier, parentUrl)
    if (resolved.pathname.endsWith(".js")) {
      resolved.pathname = resolved.pathname.slice(0, -3) + ".ts"
      return resolved.href
    }
  } catch {
    // ignore
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  // Intercept stub packages.
  if (STUB_SPECIFIERS.has(specifier)) {
    const encoded = encodeURIComponent(stubs[specifier])
    return {
      shortCircuit: true,
      url: STUB_PREFIX + encoded,
      format: "module",
    }
  }

  // Rewrite .js → .ts for local source imports.
  const tsUrl = rewriteJsToTs(specifier, context.parentURL)
  if (tsUrl) {
    return { shortCircuit: true, url: tsUrl }
  }

  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(STUB_PREFIX)) {
    const source = decodeURIComponent(url.slice(STUB_PREFIX.length))
    return { shortCircuit: true, format: "module", source }
  }
  return nextLoad(url, context)
}
