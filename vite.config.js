import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.PAGES_BASE_PATH || "/",
  publicDir: false,
  worker: { format: "es" },
  plugins: [{
    name: "asset-licenses",
    generateBundle() {
      for (const [fileName, source] of [
        ["licenses/Leaflet.txt", "pof_explorer/static/vendor/LICENSE"],
        ["licenses/Work-Sans.txt", "pof_explorer/static/vendor/fonts/LICENSE"],
        ["licenses/Zarrita.txt", "node_modules/zarrita/LICENSE"],
        ["licenses/Numcodecs.txt", "node_modules/numcodecs/LICENSE"],
      ]) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(source, "utf8") });
      }
    },
  }],
});
