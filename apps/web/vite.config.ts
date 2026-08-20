import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Split the big third-party libraries into their own chunks. They
        // change far less often than app code, so a deploy no longer
        // invalidates the ~1 MB of vendor JS in every returning user's cache.
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;

          if (id.includes("monaco-editor")) return "monaco";
          if (id.includes("@xterm")) return "xterm";
          if (id.includes("antd") || id.includes("@ant-design")) return "antd";
          if (id.includes("react-icons")) return "icons";
          return undefined;
        },
      },
    },
    // Monaco is ~4 MB on its own and there is no way around that while
    // self-hosting it; it sits behind the lazy playground route and is cached
    // after first open. The limit is set just above it so the warning still
    // fires if anything ELSE grows to that size.
    chunkSizeWarningLimit: 4000,
  },
  server: {
    // Bind on all interfaces so the app is reachable from other LAN machines
    // once it runs on the VM.
    host: true,
    // Pinned and strict: the server's CORS allowlist and the OAuth-style
    // cookie path both key off this exact origin, so silently sliding to
    // 5174 when the port is busy would break auth in confusing ways.
    // 5173 is deliberately avoided � that is the port project containers use.
    port: 5273,
    strictPort: true,
  },
});
