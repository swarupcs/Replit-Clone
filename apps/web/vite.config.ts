import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind on all interfaces so the app is reachable from other LAN machines
    // once it runs on the VM.
    host: true,
  },
});
