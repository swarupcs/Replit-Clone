import axios from "../config/axiosConfig.ts";

/** Reading another file's saved contents, for the diff pane. plan.md §10.11.
 *
 *  Through the download endpoint the transfer path already exposes, rather
 *  than a second read route: it is the same question — "give me this file as
 *  it is on disk" — already scoped to `viewer` and already confined by
 *  `resolveInProject`. A new endpoint would be a second place for that
 *  confinement to be got right.
 *
 *  Not through the editor socket, which is the OTHER way a file is read here.
 *  That path opens a tab: it feeds `openTabsStore` and the restore machinery,
 *  so using it to fetch a comparison would put the file somebody is comparing
 *  AGAINST into their editor as a side effect.
 */
export async function readFileForCompare(
  projectId: string,
  relPath: string,
): Promise<string> {
  const response = await axios.get<string>(`/api/v1/projects/${projectId}/files`, {
    params: { path: relPath },
    // Text, not JSON. The endpoint serves the file's own bytes, and axios
    // would otherwise try to parse a `.json` file in the project as the
    // response envelope and hand back an object.
    responseType: "text",
    transformResponse: [(data: unknown) => data],
  });

  return typeof response.data === "string" ? response.data : "";
}
