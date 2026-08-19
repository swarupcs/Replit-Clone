import { Route, Routes } from "react-router-dom";
import { CreateProject } from "./pages/CreateProject.tsx";
import { ProjectPlayground } from "./pages/ProjectPlayground.tsx";

export const Router = () => {
  return (
    <Routes>
      <Route path="/" element={<CreateProject />} />
      <Route path="/project/:projectId" element={<ProjectPlayground />} />
    </Routes>
  );
};
