// Bundles the pure modules (no obsidian import) and their tests so `node --test` can run them.
import esbuild from "esbuild";
import { readdirSync } from "fs";

const entryPoints = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => "test/" + f);

await esbuild.build({
  entryPoints,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2018",
  outdir: "test/.build",
  outExtension: { ".js": ".mjs" },
  logLevel: "warning",
});
