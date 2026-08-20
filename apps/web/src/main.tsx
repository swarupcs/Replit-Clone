import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App as AntdApp, ConfigProvider } from "antd";
import App from "./App.tsx";
import { queryClient } from "./config/queryClient.ts";
import { antdTheme } from "./config/theme.ts";
import "./index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('Root element "#root" is missing from index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <ConfigProvider theme={antdTheme}>
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
  </StrictMode>,
);
