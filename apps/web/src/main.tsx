import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import App from "./App.tsx";
import { queryClient } from "./config/queryClient.ts";
import { antdThemeFor } from "./config/theme.ts";
import { useThemeMode } from "./hooks/useThemeMode.ts";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('Root element "#root" is missing from index.html');
}

/** Wraps the app so the theme can be a hook — `ConfigProvider` needs the
 *  resolved mode, and the mode follows a store and the OS. */
const Themed = () => {
  const mode = useThemeMode();

  return (
    <ConfigProvider theme={antdThemeFor(mode)}>
      {/* Gives antd's message/modal/notification statics the app's theme
          context instead of rendering them unthemed. */}
      <AntdApp>
        <BrowserRouter>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  );
};

createRoot(rootElement).render(
  <StrictMode>
    <Themed />
  </StrictMode>,
);
