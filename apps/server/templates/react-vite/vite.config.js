import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The preview proxy serves this app under /preview/<projectId>/, so every asset
// URL and the HMR socket have to be prefixed with that path. The server injects
// it as PREVIEW_BASE when it starts the container.
const base = process.env.PREVIEW_BASE ?? "/";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    // Must bind on all interfaces: the proxy reaches this container over the
    // sandbox network, not via localhost.
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    // Polling, when the server says the host's bind mount does not deliver
    // file events -- Docker Desktop on Windows and macOS. Without it a save
    // reaches the container but nothing here ever notices, so HMR never fires
    // and the preview sits on the previous version of the page.
    watch: {
      usePolling: process.env.CHOKIDAR_USEPOLLING === "true",
      interval: Number(process.env.CHOKIDAR_INTERVAL ?? 1000),
    },
    hmr: {
      // Dial back through the proxied path rather than the container's origin.
      path: `${base}@vite-hmr`,
    },
  },
});
