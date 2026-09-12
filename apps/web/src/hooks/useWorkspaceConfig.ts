import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EditorConfig } from "@replit-clone/shared";
import { getEditorConfigApi } from "../apis/projects.ts";
import { useWorkspaceConfigStore } from "../store/workspaceConfigStore.ts";

/** Reads `.vscode/settings.json` and friends when a project opens.
 *  plan.md §10.9.
 *
 *  Cleared on the way out, and that is not tidiness: these settings belong to
 *  ONE repository. Leaving them in place while somebody navigates to another
 *  project would apply one project's committed font size to the next, which is
 *  precisely the confusion this row exists to remove.
 */
export function useWorkspaceConfig(projectId: string | undefined): void {
  const setConfig = useWorkspaceConfigStore((state) => state.setConfig);

  const { data } = useQuery<EditorConfig>({
    queryKey: ["editorConfig", projectId],
    queryFn: () => getEditorConfigApi(projectId ?? ""),
    enabled: Boolean(projectId),
    // A file in the tree. Refetched when the tree changes rather than on a
    // timer -- see the invalidation in the save path.
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    setConfig(data ?? null);
    return () => {
      setConfig(null);
    };
  }, [data, setConfig]);
}
