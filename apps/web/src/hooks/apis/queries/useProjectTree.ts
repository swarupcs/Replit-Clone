import { useQuery } from "@tanstack/react-query";
import { getProjectTree } from "../../../apis/projects.ts";

export const useProjectTree = (projectId: string) => {
  // This query previously had NO queryKey at all, so it never cached and threw
  // at runtime under react-query v5.
  const {
    isLoading,
    isError,
    data: projectTree,
    error,
  } = useQuery({
    queryKey: ["projectTree", projectId],
    queryFn: () => getProjectTree({ projectId }),
    enabled: Boolean(projectId),
  });

  return { isLoading, isError, projectTree, error };
};
