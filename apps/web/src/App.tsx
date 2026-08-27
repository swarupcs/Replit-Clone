import { useLocation } from "react-router-dom";
import { Router } from "./Router.tsx";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.ts";

function App() {
  // Everywhere except an embed. See the hook: refreshing inside a third-party
  // iframe can spend the reader's refresh token and lose its replacement,
  // signing them out of the tab they actually came from.
  const isEmbed = useLocation().pathname.startsWith("/embed/");

  useSessionBootstrap(!isEmbed);

  return <Router />;
}

export default App;
