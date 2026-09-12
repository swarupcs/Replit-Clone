import { useEffect, useState } from "react";
import type { GitBlameLine } from "@replit-clone/shared";
import { getBlameApi } from "../apis/projects.ts";

/** Who last touched each line. plan.md §10.13, and §10 names blame one of the
 *  two a personal user notices in the first week.
 *
 *  Off until asked for, and that is not laziness: blame runs `git blame` in
 *  the container for one file, and doing it on every file open would put a
 *  process behind every click in the tree for information almost nobody wants
 *  most of the time.
 */
export function useBlame(
  projectId: string | undefined,
  relPath: string | null,
  enabled: boolean,
): { lines: GitBlameLine[]; loading: boolean } {
  const [lines, setLines] = useState<GitBlameLine[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || !projectId || !relPath) {
      setLines([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void getBlameApi(projectId, relPath)
      .then((result) => {
        if (!cancelled) setLines(result);
      })
      .catch(() => {
        // A file with no history is the ordinary case, not an error: an
        // untracked file has nobody to attribute it to.
        if (!cancelled) setLines([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, relPath, enabled]);

  return { lines, loading };
}
