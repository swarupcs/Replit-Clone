import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { Router } from "./Router.tsx";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.ts";
import { watchNetwork } from "./store/connectionStore.ts";
import { registerServiceWorker } from "./lib/serviceWorker.ts";

// Outside the component: registration is per document, not per mount, and
// React's StrictMode mounts the tree twice in development.
registerServiceWorker();

function App() {
  // Everywhere except an embed. See the hook: refreshing inside a third-party
  // iframe can spend the reader's refresh token and lose its replacement,
  // signing them out of the tab they actually came from.
  const isEmbed = useLocation().pathname.startsWith("/embed/");

  useSessionBootstrap(!isEmbed);

  // One pair of window listeners for the whole app. Two would be two updates
  // for one change. plan.md §11.7.
  useEffect(() => watchNetwork(), []);

  return <Router />;
}

export default App;
