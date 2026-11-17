import { defineConfig } from "tsup";

// Builds the npm package only. Inside the workspace `@orrery/sdk` is still consumed as TypeScript source, so nothing
// in the repo needs this build. `@orrery/shared` is bundled into the output (JS and types); viem stays external.
export default defineConfig({
  entry: { index: "src/public.ts" },
  outDir: "publish/dist",
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: {
    resolve: true,
    compilerOptions: { allowImportingTsExtensions: false, paths: { "@orrery/shared": ["../shared/src/index.ts"] } },
  },
  noExternal: ["@orrery/shared"],
  external: ["viem"],
  // Module-level parseAbi/getAbiItem calls in the unreleased modules are pure; marking them lets rollup drop them
  // (esbuild renames a second import of the same name with a numeric suffix, hence the `2` entries).
  treeshake: { preset: "recommended", manualPureFunctions: ["parseAbi", "parseAbi2", "getAbiItem", "getAbiItem2"] },
  sourcemap: false,
  clean: true,
  splitting: false,
});
