import { Router } from "./Router.tsx";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.ts";

function App() {
  useSessionBootstrap();

  return <Router />;
}

export default App;
