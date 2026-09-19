import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // node polyfills so the audited crypto path (node:crypto, Buffer) in src/lib runs
  // IDENTICALLY in the Tauri webview as it does under Vitest/Node — no separate impl.
  plugins: [nodePolyfills({ include: ["crypto", "buffer", "stream", "vm"], globals: { Buffer: true } }), react()],

  // Strip console.* and debugger from the PRODUCTION bundle (`tauri build`) — a signer must
  // not leak anything to a console. `drop` only applies to the minified build, so `tauri dev`
  // keeps full logging. Belt-and-suspenders alongside devtools being off in release builds.
  esbuild: {
    drop: ["debugger"],
    pure: ["console.log", "console.info", "console.debug", "console.warn"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
