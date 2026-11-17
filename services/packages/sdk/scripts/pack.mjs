// Builds the npm package into packages/sdk/publish and writes its package.json.
//
// The workspace keeps the internal name `@orrery/sdk` and its TypeScript-source export, so the web app, tsx scripts
// and vitest are untouched. The published name lives here only (the `@orrery` scope on npm belongs to another
// account). Run `pnpm --filter @orrery/sdk pack:npm`, then `npm pack` or `npm publish` inside packages/sdk/publish.
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLISHED_NAME = "@orrery-tech/sdk";
const LICENSE = "MIT";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "publish");
const src = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

execFileSync("pnpm", ["exec", "tsup"], { cwd: root, stdio: "inherit" });

const pkg = {
  name: PUBLISHED_NAME,
  version: src.version,
  description: "Orrery SDK: capped, public spending authority for AI agents on Robinhood Chain, and signed payer checks for merchants.",
  license: LICENSE,
  homepage: "https://orreryagent.com/docs",
  keywords: ["orrery", "agent", "x402", "erc-8004", "robinhood-chain", "viem", "payments"],
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
  files: ["dist", "README.md", "LICENSE"],
  sideEffects: false,
  engines: { node: ">=20" },
  peerDependencies: { viem: src.dependencies.viem },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
copyFileSync(join(root, "README.md"), join(out, "README.md"));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
console.log(`Staged ${PUBLISHED_NAME}@${pkg.version} in ${out}`);
