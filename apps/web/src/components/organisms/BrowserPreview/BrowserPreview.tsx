import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import { VscRefresh } from "react-icons/vsc";
import type { BrowserPreviewPlan } from "@replit-clone/shared";
import { getBrowserPreviewApi } from "../../../apis/projects.ts";
import {
  bundle,
  describeFailure,
  previewDocument,
} from "../../../lib/browserBundler.ts";

/** A preview with no container behind it. plan.md §13.2.
 *
 *  The source is fetched once and built in the reader's own browser; the host
 *  spends one text response and nothing else. That is the whole reason this
 *  row exists — the container preview costs a container per reader, which is
 *  why an embed of this product cannot be put on a busy page.
 *
 *  **A refusal is shown as a sentence about the project**, not as an error.
 *  "This project runs a server" is a fact, and the container preview beside it
 *  is the answer — a reader who sees "failed" concludes the project is broken.
 */
export function BrowserPreview({ projectId }: { projectId: string }) {
  const [plan, setPlan] = useState<BrowserPreviewPlan | null>(null);
  const [document_, setDocument] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  /** Bumped to force the iframe to reload even when the document is identical,
   *  which is what "Reload" means to somebody whose app has state in it. */
  const [nonce, setNonce] = useState(0);
  const cancelled = useRef(false);

  const build = useCallback(async () => {
    setBuilding(true);
    setFailure(null);

    try {
      const next = await getBrowserPreviewApi(projectId);
      if (cancelled.current) return;
      setPlan(next);

      if (!next.supported) {
        setDocument(null);
        return;
      }

      const result = await bundle(next);
      if (cancelled.current) return;

      setDocument(previewDocument(result.code, next.html));
    } catch (error) {
      if (!cancelled.current) setFailure(describeFailure(error));
    } finally {
      if (!cancelled.current) setBuilding(false);
    }
  }, [projectId]);

  useEffect(() => {
    cancelled.current = false;
    void build();
    return () => {
      cancelled.current = true;
    };
  }, [build]);

  if (plan && !plan.supported) {
    return (
      <Alert
        type="info"
        showIcon
        style={{ margin: 12 }}
        message="Not a browser preview"
        description={plan.message}
      />
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 8px",
          borderBottom: "1px solid var(--rc-border)",
          fontSize: 12,
          color: "var(--rc-text-subtle)",
        }}
      >
        <span style={{ flex: 1 }}>
          Built in this browser — no container is running.
        </span>
        {building && <Spin size="small" />}
        <Button
          size="small"
          icon={<VscRefresh />}
          aria-label="Rebuild the preview"
          onClick={() => {
            setNonce((value) => value + 1);
            void build();
          }}
        >
          Reload
        </Button>
      </div>

      {failure !== null ? (
        <Alert
          type="error"
          showIcon
          style={{ margin: 12 }}
          message="The build failed"
          description={<pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{failure}</pre>}
        />
      ) : (
        document_ !== null && (
          <iframe
            key={nonce}
            title="Preview"
            srcDoc={document_}
            style={{ flex: 1, width: "100%", border: 0, background: "#fff" }}
            // The project's own code, from a repository this platform did not
            // write. `allow-scripts` is what makes it run at all; NOT
            // `allow-same-origin`, so it cannot reach this app's cookies,
            // storage or DOM. The two together would be no sandbox whatever.
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
          />
        )
      )}
    </div>
  );
}

export default BrowserPreview;
