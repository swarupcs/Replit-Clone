import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Alert, Button, Spin, Tag } from "antd";
import Editor from "@monaco-editor/react";
import type { SandboxPayload } from "@replit-clone/shared";
import { getSandboxApi } from "../apis/embeds.ts";
import {
  bundle,
  describeFailure,
  previewDocument,
} from "../lib/browserBundler.ts";
import { useThemeMode } from "../hooks/useThemeMode.ts";
import { EDITOR_THEMES } from "../config/editorThemes.ts";

/** A sandbox a stranger can open, change and run. plan.md §13.1.
 *
 *  **The whole design is in what this page does not do.** It starts no
 *  container, saves nothing, and asks for no account. The visitor's edits live
 *  in this component's state and the build happens in their browser (§13.2), so
 *  an anonymous page view spends their memory and none of the host's — which
 *  is the refusal §6 decision 13 makes, kept intact. §14.5 says doing this row
 *  before 13.2 would have meant breaking it, and this is what "after" looks
 *  like.
 *
 *  **Saving is forking, and forking means signing in.** That is the same
 *  boundary the product already had, moved to after the interesting part
 *  instead of before it: the stranger changes a line and runs it first, and
 *  only meets the account when they want to keep it.
 */
export function SandboxPage() {
  const { token = "" } = useParams<{ token: string }>();
  const [payload, setPayload] = useState<SandboxPayload | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const [document_, setDocument] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const monacoTheme =
    useThemeMode() === "light" ? EDITOR_THEMES.light : EDITOR_THEMES.dark;

  useEffect(() => {
    let cancelled = false;

    void getSandboxApi(token)
      .then((next) => {
        if (cancelled) return;
        setPayload(next);
        setEdited(next.files);
        setActive(next.entry ?? Object.keys(next.files)[0] ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "That link is not available.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  /** The files as the visitor has them now: `edited` under a name that says
   *  what it is. Their edits are the source of truth from the moment they
   *  type; nothing is sent anywhere. */
  const files = edited;

  const run = useCallback(async () => {
    if (!payload?.entry) return;

    setBuilding(true);
    setFailure(null);

    try {
      const result = await bundle({
        supported: true,
        entry: payload.entry,
        files,
        html: payload.html,
      });
      setDocument(previewDocument(result.code, payload.html));
    } catch (error) {
      setFailure(describeFailure(error));
    } finally {
      setBuilding(false);
    }
  }, [payload, files]);

  /** True once the automatic build has been fired, so it fires exactly once.
   *
   *  `run` changes identity on every keystroke, because it closes over the
   *  files. This guard is what stops that from meaning a build per character;
   *  the Run button is how somebody says they are ready for the next one. A
   *  ref rather than a trimmed dependency list, so the effect can name
   *  everything it actually uses. */
  const builtOnce = useRef(false);

  // The first build happens on its own, because a sandbox that opens showing
  // nothing until you press a button is a sandbox nobody presses the button in.
  useEffect(() => {
    if (builtOnce.current || !payload?.entry) return;
    builtOnce.current = true;
    void run();
  }, [payload, run]);

  if (loadError !== null) {
    return <Alert type="error" showIcon style={{ margin: 24 }} message={loadError} />;
  }

  if (!payload) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <Spin />
      </div>
    );
  }

  if (payload.refusal !== undefined) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ margin: 24 }}
        message={`${payload.projectName} cannot run in a browser`}
        description={payload.refusal}
      />
    );
  }

  const paths = Object.keys(files).sort();

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          borderBottom: "1px solid var(--rc-border)",
        }}
      >
        <strong style={{ fontSize: 14 }}>{payload.projectName}</strong>
        <Tag>{payload.template}</Tag>
        {/* Said plainly and permanently, not in a toast that goes away: a
            visitor who assumes this saves will lose their work. */}
        <span style={{ fontSize: 12, color: "var(--rc-text-subtle)" }}>
          Your changes stay in this browser. Nothing is saved.
        </span>
        <span style={{ flex: 1 }} />
        {building && <Spin size="small" />}
        <Button size="small" type="primary" onClick={() => void run()}>
          Run
        </Button>
        <Button size="small" href={payload.forkUrl}>
          Fork to keep it
        </Button>
      </header>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <nav
          style={{
            width: 200,
            borderRight: "1px solid var(--rc-border)",
            overflowY: "auto",
            padding: 6,
          }}
        >
          {paths.map((relPath) => (
            <button
              key={relPath}
              type="button"
              onClick={() => {
                setActive(relPath);
              }}
              data-on={active === relPath}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                border: 0,
                background: active === relPath ? "var(--rc-surface-sunken)" : "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: 12,
                padding: "3px 6px",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {relPath}
            </button>
          ))}
        </nav>

        <div style={{ flex: 1, minWidth: 0 }}>
          {active !== null && (
            <Editor
              height="100%"
              theme={monacoTheme}
              // `path` is enough: Monaco infers the language from it, and a
              // second source of truth for that is one that can disagree.
              path={active}
              value={files[active] ?? ""}
              onChange={(value) => {
                setEdited((current) => ({ ...current, [active]: value ?? "" }));
              }}
              options={{ minimap: { enabled: false }, fontSize: 13 }}
            />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0, borderLeft: "1px solid var(--rc-border)" }}>
          {failure !== null ? (
            <Alert
              type="error"
              showIcon
              style={{ margin: 12 }}
              message="The build failed"
              description={
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{failure}</pre>
              }
            />
          ) : (
            document_ !== null && (
              <iframe
                title="Sandbox preview"
                srcDoc={document_}
                style={{ width: "100%", height: "100%", border: 0, background: "#fff" }}
                // Somebody else's code, edited by a stranger, in a page with no
                // session. `allow-scripts` without `allow-same-origin`: the two
                // together would let it reach this origin's storage.
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default SandboxPage;
