import { defineConfig } from "tsup";

// Builds the npm package into publish/dist. Inside the workspace `@orrery/mcp` is still consumed as TypeScript source.
// `@orrery/sdk` and `@orrery/shared` are bundled into the output; `@modelcontextprotocol/sdk`, `viem` and `zod` stay external.
export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    outDir: "publish/dist",
    format: ["esm"],
    target: "es2022",
    platform: "node",
    dts: {
      resolve: true,
      compilerOptions: {
        allowImportingTsExtensions: false,
        paths: {
          "@orrery/sdk": ["../sdk/src/index.ts"],
          "@orrery/shared": ["../shared/src/index.ts"],
        },
      },
    },
    noExternal: ["@orrery/sdk", "@orrery/shared"],
    external: ["@modelcontextprotocol/sdk", "viem", "zod"],
    sourcemap: false,
    clean: true,
    splitting: false,
  },
  {
    entry: { cli: "src/cli.ts" },
    outDir: "publish/dist",
    format: ["esm"],
    target: "es2022",
    platform: "node",
    dts: false,
    noExternal: ["@orrery/sdk", "@orrery/shared"],
    external: ["@modelcontextprotocol/sdk", "viem", "zod"],
    banner: { js: "#!/usr/bin/env node" },
    sourcemap: false,
    clean: false,
    splitting: false,
  },
]);
