/**
 * Entry point loaded via --import. Registers the mock-loader hooks so that
 * bun:sqlite and missing npm packages are stubbed out in the test runner and
 * all child processes it spawns.
 */
import { register } from "node:module"
import { pathToFileURL } from "node:url"
import { resolve as resolvePath, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const loaderUrl = pathToFileURL(resolvePath(__dirname, "mock-loader.mjs")).href

register(loaderUrl, import.meta.url)
