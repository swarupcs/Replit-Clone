import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind on all interfaces so the app is reachable from other LAN machines
    // once it runs on the VM.
    host: true,
    // Pinned and strict: the server's CORS allowlist and the OAuth-style
    // cookie path both key off this exact origin, so silently sliding to
    // 5174 when the port is busy would break auth in confusing ways.
    // 5173 is deliberately avoided — that is the port project containers use.
    port: 5273,
    strictPort: true,
  },
});
