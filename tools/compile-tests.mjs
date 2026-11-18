// Type-checks the Foundry tests with solc-js (no forge needed). Needs contracts/lib/forge-std.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
const require = createRequire(import.meta.url);
const solc = require("solc");
const root = join(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "contracts");
const sources = {};
for (const d of ["src", "test", "script"]) {
  const walk = (dir) => { for (const f of readdirSync(join(root, dir), { withFileTypes: true })) { const p = join(dir, f.name); f.isDirectory() ? walk(p) : p.endsWith(".sol") && (sources[p.split("\\").join("/")] = { content: readFileSync(join(root, p), "utf8") }); } };
  walk(d);
}
function findImports(path) {
  const p = path.startsWith("forge-std/") ? join(root, "lib/forge-std/src", path.slice(10)) : join(root, path);
  return existsSync(p) ? { contents: readFileSync(p, "utf8") } : { error: "not found " + path };
}
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": [] } } } }), { import: findImports }));
const errs = (out.errors ?? []).filter((e) => e.severity === "error");
for (const e of errs) console.error(e.formattedMessage);
console.log(errs.length ? `${errs.length} errors` : "Foundry tests compile");
process.exit(errs.length ? 1 : 0);
