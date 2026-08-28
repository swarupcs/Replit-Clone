import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Spin } from "antd";
import "../config/monacoSetup.ts";
import { EDITOR_THEMES } from "../config/editorThemes.ts";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { EmbedView } from "@replit-clone/shared";
import { FileIcon } from "../components/atoms/FileIcon/FileIcon.tsx";
import { getEmbedApi, getEmbedFileApi } from "../apis/embeds.ts";
import { extensionToFileType } from "../utils/extensionToFileType.ts";
import { useThemeMode } from "../hooks/useThemeMode.ts";
import { useThemeStore, type ThemeMode } from "../store/themeStore.ts";

/** A project inside somebody else's page.
 *
 *  Everything this app does elsewhere assumes a session, a socket and a
 *  container. This page assumes none of the three: it is read by people with no
 *  account, in an iframe on a site we do not control, and it must render
 *  usefully on a slow connection in a 400px-wide column.
 *
 *  So it deliberately shares almost nothing with the playground. No socket, no
 *  collaboration, no stores beyond the theme, no write path — not to keep it
 *  small, but because each of those is a thing that could go wrong inside
 *  somebody's article, where nobody will ever see the error.
 */

/** Below this the two halves cannot sit side by side, so `split` becomes a
 *  pair of tabs. Measured against the FRAME, not the viewport: an embed is
 *  usually narrow inside a wide window. */
const SPLIT_MIN_WIDTH = 640;

function isView(value: string | null): value is EmbedView {
  return value === "code" || value === "preview" || value === "split";
}

function isMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

export const EmbedPage = () => {
  const { token = "" } = useParams<{ token: string }>();
  const [params] = useSearchParams();

  const setOverride = useThemeStore((state) => state.setOverride);
  const themeParam = params.get("theme");

  useEffect(() => {
    // The host author's call, not this reader's saved preference — see the
    // store. Cleared on the way out so it cannot leak into a normal session if
    // the app is ever mounted twice in one document.
    setOverride(isMode(themeParam) ? themeParam : null);
    return () => {
      setOverride(null);
    };
  }, [themeParam, setOverride]);

  const mode = useThemeMode();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["embed", token],
    queryFn: () => getEmbedApi(token),
    // A revoked or mistyped token is not going to become valid; retrying it
    // three times only makes the blank frame last longer.
    retry: false,
    // The page is a frame in an article that may sit open for hours. Nothing
    // here changes without the owner republishing, and a refetch inside
    // somebody else's page is traffic they did not ask for.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const [openFile, setOpenFile] = useState<string | null>(null);
  const [chosenView, setChosenView] = useState<EmbedView | null>(null);
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = () => {
      setWidth(window.innerWidth);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // The URL wins over the stored setting, so one token can be embedded twice in
  // the same article showing different things.
  const urlView = params.get("view");
  const urlFile = params.get("file");

  const requestedView: EmbedView =
    chosenView ?? (isView(urlView) ? urlView : (data?.view ?? "split"));

  const hasPreview = Boolean(data?.previewUrl);

  /** What is actually rendered, once the frame's width and what exists are
   *  taken into account. A `split` with nothing to preview is a code view with
   *  an apologetic empty pane, which nobody wants in their article. */
  const view: EmbedView = !hasPreview
    ? "code"
    : requestedView === "split" && width < SPLIT_MIN_WIDTH
      ? "code"
      : requestedView;

  const narrow = width < SPLIT_MIN_WIDTH;

  const activePath =
    openFile ??
    (urlFile && data?.files.some((f) => f.relPath === urlFile)
      ? urlFile
      : (data?.activeFile ?? null));

  const { data: file, isLoading: fileLoading } = useQuery({
    queryKey: ["embed-file", token, activePath],
    queryFn: () => getEmbedFileApi(token, activePath ?? ""),
    enabled: Boolean(data && activePath),
    retry: false,
    staleTime: Infinity,
  });

  const language = useMemo(() => {
    if (!activePath) return "plaintext";
    const name = activePath.split("/").pop() ?? activePath;
    return extensionToFileType(name.split(".").pop(), name) ?? "plaintext";
  }, [activePath]);

  if (isLoading) {
    return (
      <div className="rc-embed rc-embed-centered">
        <Spin />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rc-embed rc-embed-centered">
        {/* No detail on purpose. A revoked embed, a deleted project and a
            mistyped token are one answer here — anything finer is a way to
            find out which tokens exist. */}
        <p className="rc-embed-gone">This embed is no longer available.</p>
      </div>
    );
  }

  const codePane = (
    <div className="rc-embed-code">
      <ul className="rc-embed-files" aria-label="Files">
        {data.files.map((entry) => (
          <li key={entry.relPath}>
            <button
              type="button"
              className={
                entry.relPath === activePath
                  ? "rc-embed-file rc-embed-file-active"
                  : "rc-embed-file"
              }
              aria-current={entry.relPath === activePath ? "true" : undefined}
              onClick={() => {
                setOpenFile(entry.relPath);
              }}
            >
              <FileIcon
                extension={entry.relPath.split(".").pop()}
                name={entry.relPath.split("/").pop() ?? entry.relPath}
              />
              <span>{entry.relPath}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="rc-embed-editor">
        {fileLoading ? (
          <div className="rc-embed-centered">
            <Spin size="small" />
          </div>
        ) : (
          <>
            {file?.truncated && (
              <p className="rc-embed-truncated" role="status">
                Showing the first part of this file — it was too long to embed.
              </p>
            )}
            <Editor
              // Keyed on the path so switching files replaces the model rather
              // than mutating one, which is what keeps the read-only editor
              // from carrying the previous file's folds and scroll position.
              key={activePath ?? "none"}
              height="100%"
              language={language}
              value={file?.contents ?? ""}
              // The same two themes the editor uses. An embed rendering in
              // Monaco's stock `vs` while the rest of the page is ours was a
              // small, permanent tell that it was a different thing.
              theme={mode === "light" ? EDITOR_THEMES.light : EDITOR_THEMES.dark}
              options={READ_ONLY_OPTIONS}
            />
          </>
        )}
      </div>
    </div>
  );

  const previewPane = data.previewUrl ? (
    <iframe
      className="rc-embed-preview"
      src={data.previewUrl}
      title={`${data.projectName} preview`}
      // The published site is somebody's own code on its own origin. It is
      // already public and already served without a session, so there is
      // nothing here for it to reach — but it is also not ours, and a frame
      // that cannot navigate the top window is the difference between an embed
      // and a redirect somebody did not consent to.
      sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  ) : null;

  return (
    <div className="rc-embed" data-view={view}>
      <header className="rc-embed-bar">
        <span className="rc-embed-name" title={data.projectName}>
          {data.projectName}
        </span>

        {hasPreview && (
          <div className="rc-embed-tabs" role="tablist" aria-label="View">
            {(["code", "preview"] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={view === option}
                className={
                  view === option ? "rc-embed-tab rc-embed-tab-on" : "rc-embed-tab"
                }
                onClick={() => {
                  setChosenView(option);
                }}
              >
                {option === "code" ? "Code" : "Preview"}
              </button>
            ))}
            {/* A third choice only where both halves fit; offering it in a
                narrow frame would be offering a layout that cannot render. */}
            {!narrow && (
              <button
                type="button"
                role="tab"
                aria-selected={view === "split"}
                className={
                  view === "split" ? "rc-embed-tab rc-embed-tab-on" : "rc-embed-tab"
                }
                onClick={() => {
                  setChosenView("split");
                }}
              >
                Both
              </button>
            )}
          </div>
        )}

        {data.projectUrl && (
          <a
            className="rc-embed-open"
            href={data.projectUrl}
            // The whole point: this page is in a frame, and the project is not
            // something to open inside one.
            target="_blank"
            rel="noopener noreferrer"
          >
            Open project
          </a>
        )}
      </header>

      <main className="rc-embed-body">
        {view !== "preview" && codePane}
        {view !== "code" && previewPane}
      </main>
    </div>
  );
};

const READ_ONLY_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  // Said in the UI rather than by a tooltip nobody reads: an embed is a
  // reading surface, and a cursor that types into a void is a small lie.
  domReadOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  lineNumbersMinChars: 3,
  padding: { top: 10, bottom: 10 },
  // A frame sits inside a scrolling article. Catching the wheel and never
  // letting it go is how an embed traps a reader halfway down the page.
  scrollbar: { alwaysConsumeMouseWheel: false },
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  contextmenu: false,
};
