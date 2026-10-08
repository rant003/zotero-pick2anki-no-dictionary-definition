import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  entryPoints: { recovery: resolve(root, "test/anki-recovery.ts"), "anki-core": resolve(root, "src/modules/anki.ts") },
  bundle: true, platform: "node", format: "esm", target: "node20",
  outdir: resolve(root, "test/dist"), outExtension: { ".js": ".mjs" },
  external: ["jsdom"], loader: { ".css": "text" }, logLevel: "warning",
});
const child = spawnSync(process.execPath, [resolve(root, "test/dist/recovery.mjs")], { cwd: root, stdio: "inherit" });
process.exit(child.status ?? 1);
