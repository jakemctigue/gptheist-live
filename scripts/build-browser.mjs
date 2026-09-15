import { build } from "esbuild";

await build({
  entryPoints: ["src/smartAccountBrowser.ts"],
  bundle: true,
  format: "iife",
  outfile: "assets/desk/smart-account.js",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false,
  minify: true,
  legalComments: "none"
});
