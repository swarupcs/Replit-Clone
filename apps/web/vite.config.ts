import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { headersFor } from "./src/config/securityHeaders.js";

/** Serves the same security headers nginx serves in the image.
 *
 *  Vite's own `server.headers` is global, and this app needs two sets: an
 *  embed exists to be framed and everything else must not be. A header that
 *  differs between development and production is the worst of both -- absent
 *  exactly where it matters, present where nobody would notice it missing.
 */
const securityHeaders: Plugin = {
  name: "security-headers",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      for (const [name, value] of Object.entries(headersFor(pathname))) {
        res.setHeader(name, value);
      }
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), securityHeaders],
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
    // Pinned and strict: the server's CORS allowlist, the preview CSP's
    // frame-ancestors and the cookie path all key off this exact origin, so
    // silently sliding to the next free port would break auth and blank the
    // preview in confusing ways.
    //
    // 5173 is deliberately avoided -- that is the port project containers use.
    //
    // ABOVE 15000 deliberately. On Windows, Docker Desktop lowers the TCP
    // dynamic port range to 1024-15000 (netsh int ipv4 show dynamicport tcp),
    // and Hyper-V reserves blocks anywhere inside it on every boot -- binding
    // one then fails with EACCES rather than EADDRINUSE. This port chased that
    // twice, 5273 then 4273, because both were only free on the day they were
    // picked. Sitting above the range is what actually settles it; Postgres is
    // on 15432 for the same reason.
    port: 15273,
    strictPort: true,
  },
});
