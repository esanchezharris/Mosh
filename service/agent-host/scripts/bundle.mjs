import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/agent-host.mjs",
  bundle: true,
  format: "esm",
  // @openai/agents dynamically requires `debug` on Node. Give esbuild's CJS shim
  // a real require while retaining ESM/top-level-await support for main.ts.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  platform: "node",
  target: "node20",
  legalComments: "none",
  sourcemap: false,
});
