// Builds the npm package into packages/mcp/publish and writes its package.json.
//
// The workspace keeps `@orrery/mcp` and its TypeScript-source export, so vitest and local scripts stay untouched.
// Run `pnpm --filter @orrery/mcp pack:npm`, then `npm pack` or `npm publish --access public` inside packages/mcp/publish.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_NAME = "@orrery-tech/mcp";
const LICENSE = "MIT";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "publish");
const src = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

execFileSync("pnpm", ["exec", "tsup"], { cwd: root, stdio: "inherit" });

// Ensure cli.js has a clean Node shebang (strip any inherited `npx tsx` line from src/cli.ts).
const cliPath = join(out, "dist/cli.js");
const cliBody = readFileSync(cliPath, "utf8").replace(/^#!.*\n(?=#!)/m, "");
writeFileSync(cliPath, cliBody);
chmodSync(cliPath, 0o755);

const { ["@orrery/sdk"]: _dropped, ...deps } = src.dependencies;
const pkg = {
  name: PUBLISHED_NAME,
  version: src.version,
  description: src.description,
  license: LICENSE,
  homepage: "https://orreryagent.com/docs",
  keywords: ["orrery", "mcp", "model-context-protocol", "ai-agent", "x402", "erc-8004", "robinhood-chain"],
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  bin: { "orrery-mcp": "dist/cli.js" },
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
  files: ["dist", "README.md", "LICENSE"],
  sideEffects: false,
  engines: { node: ">=20" },
  dependencies: deps,
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
copyFileSync(join(root, "README.md"), join(out, "README.md"));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
console.log(`Staged ${PUBLISHED_NAME}@${pkg.version} in ${out}`);
