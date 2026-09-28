// Bundles each Lambda handler into its own folder under dist/, which template.yaml points at.
import { build } from "esbuild";

await build({
  entryPoints: {
    "webhook/index": "src/handlers/webhook.ts",
    "processor/index": "src/handlers/processor.ts",
    "local/chat": "src/local/chat.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
});
