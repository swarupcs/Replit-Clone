import { Router } from "./Router.tsx";
import { useSessionBootstrap } from "./hooks/useSessionBootstrap.ts";
import "./App.css";

function App() {
  useSessionBootstrap();

  return <Router />;
}

export default App;
