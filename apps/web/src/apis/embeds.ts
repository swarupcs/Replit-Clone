import axios from "axios";
import type {
  ApiSuccess,
  EmbedFileContents,
  EmbedPayload,
  EmbedSettings,
  EmbedState,
} from "@replit-clone/shared";
import authed from "../config/axiosConfig.ts";

/** A client with NO credentials, for the two endpoints an embed reads.
 *
 *  Deliberately not the shared instance. That one sends `withCredentials` and
 *  refreshes the session on a 401, and an embed runs inside a page this
 *  platform does not control: attaching the reader's refresh cookie to a
 *  request made by somebody else's blog is precisely the thing three origins
 *  were separated to prevent, and a 401 in a frame quietly rotating (or
 *  clearing) the session they have open in another tab is the other half of it.
 *
 *  Nothing here needs a credential anyway. The token in the URL is the whole
 *  authorisation, and it is read-only by construction.
 */
const anonymous = axios.create({
  baseURL: import.meta.env.VITE_BACKEND_URL,
  withCredentials: false,
});

export const getEmbedApi = async (token: string): Promise<EmbedPayload> => {
  const response = await anonymous.get<ApiSuccess<EmbedPayload>>(
    `/api/v1/embeds/${encodeURIComponent(token)}`,
  );
  return response.data.data;
};

export const getEmbedFileApi = async (
  token: string,
  relPath: string,
): Promise<EmbedFileContents> => {
  const response = await anonymous.get<ApiSuccess<EmbedFileContents>>(
    `/api/v1/embeds/${encodeURIComponent(token)}/file`,
    { params: { path: relPath } },
  );
  return response.data.data;
};

/* ---- the owner's side, which does need a session ---- */

export const getProjectEmbedApi = async (
  projectId: string,
): Promise<EmbedState> => {
  const response = await authed.get<ApiSuccess<EmbedState>>(
    `/api/v1/projects/${projectId}/embed`,
  );
  return response.data.data;
};

export const createProjectEmbedApi = async (
  projectId: string,
  settings: Partial<EmbedSettings>,
): Promise<EmbedState> => {
  const response = await authed.post<ApiSuccess<EmbedState>>(
    `/api/v1/projects/${projectId}/embed`,
    settings,
  );
  return response.data.data;
};

export const updateProjectEmbedApi = async (
  projectId: string,
  settings: Partial<EmbedSettings>,
): Promise<EmbedState> => {
  const response = await authed.patch<ApiSuccess<EmbedState>>(
    `/api/v1/projects/${projectId}/embed`,
    settings,
  );
  return response.data.data;
};

export const revokeProjectEmbedApi = async (
  projectId: string,
): Promise<EmbedState> => {
  const response = await authed.delete<ApiSuccess<EmbedState>>(
    `/api/v1/projects/${projectId}/embed`,
  );
  return response.data.data;
};

/** The URL an iframe points at.
 *
 *  Built from the page's own origin rather than a configured one, because the
 *  embed page IS this app — whatever address the owner is looking at it on is
 *  the address their readers will reach it on.
 */
export function embedUrl(
  token: string,
  options: { view?: string; file?: string; theme?: string } = {},
): string {
  const url = new URL(`/embed/${token}`, window.location.origin);

  for (const [key, value] of Object.entries(options)) {
    if (value) url.searchParams.set(key, value);
  }

  return url.toString();
}

/** The snippet an author pastes.
 *
 *  `allow` is deliberately narrow and `sandbox` is deliberately absent: the
 *  embed page is served from this app's own origin and frames the published
 *  site itself, so a sandbox here would only break our own page while doing
 *  nothing about the site inside it.
 */
export function embedSnippet(url: string, title: string): string {
  const safeTitle = title.replace(/"/g, "&quot;");

  return (
    `<iframe src="${url}"\n` +
    `  style="width:100%;height:500px;border:0;border-radius:8px;overflow:hidden"\n` +
    `  title="${safeTitle}"\n` +
    `  allow="clipboard-write"\n` +
    `  loading="lazy"></iframe>`
  );
}
