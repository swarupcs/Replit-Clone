import { useEffect } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useAuthStore } from "../store/authStore.ts";
import {
  LspClient,
  toMarkerSeverity,
  toMonacoRange,
  type LspDiagnostic,
} from "../lib/lspClient.ts";

/** Languages this app will ask the server for.
 *
 *  Mirrors `LANGUAGE_SERVERS` on the server, and deliberately a copy rather
 *  than a fetch: the cost of being wrong is one refused WebSocket, and the
 *  cost of a round trip is one on every file opened in every language. The
 *  server is the authority — it refuses anything not on its own list — so this
 *  is an optimisation, not a permission check.
 */
const LSP_LANGUAGES = new Set(["python", "go"]);

/** Where the project tree is mounted inside its container.
 *
 *  The language server sees container paths, and the editor sees `inmemory:`
 *  model URIs. Everything crossing that boundary is translated here, which is
 *  why both directions live in one file. */
const CONTAINER_ROOT = "/home/sandbox/app";

/** Marker owner. Namespaced so clearing these never touches Monaco's own
 *  TypeScript diagnostics, which use their own owner and are the reason the
 *  Problems panel already has content for one language. */
const MARKER_OWNER = "lsp";

function socketUrl(projectId: string, language: string, token: string): string {
  const backend = new URL(import.meta.env.VITE_BACKEND_URL);
  const protocol = backend.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ projectId, language, token });

  return `${protocol}//${backend.host}/lsp?${query.toString()}`;
}

/** Connects Monaco to a language server running in the project's container.
 *
 *  One connection per open file rather than one per project, which is the
 *  simpler half of a trade worth stating: a shared connection would keep the
 *  server warm across file switches, at the cost of tracking which documents
 *  are open and reconciling that with the tab strip. Diagnostics for the file
 *  being looked at are what this is for, and reopening costs a handshake.
 *
 *  Does nothing at all for a language with no server, which is most of them —
 *  including every language Monaco already analyses in the browser.
 */
export function useLanguageServer(options: {
  monaco: Monaco | null;
  editor: editor.IStandaloneCodeEditor | null;
  projectId: string;
  relPath: string | undefined;
  language: string | undefined;
  /** Bumped when the editor remounts, so this re-runs against the new one. */
  mountTick: number;
}): void {
  const { monaco, editor: codeEditor, projectId, relPath, language, mountTick } =
    options;

  /** Whether a session exists at all — not its value. The token is read
   *  imperatively below for the same reason the terminal does it: it rotates,
   *  and reconnecting a language server every fifteen minutes would throw away
   *  a warm index for nothing. */
  const hasSession = useAuthStore((state) => state.accessToken !== null);

  useEffect(() => {
    if (!monaco || !codeEditor || !relPath || !language || !projectId) return;
    if (!LSP_LANGUAGES.has(language)) return;

    const token = useAuthStore.getState().accessToken;
    if (!token) return;

    const model = codeEditor.getModel();
    if (!model) return;

    const documentUri = `file://${CONTAINER_ROOT}/${relPath}`;
    let version = 1;
    let disposed = false;

    const client = new LspClient(socketUrl(projectId, language, token), {
      onDiagnostics: (uri, diagnostics: LspDiagnostic[]) => {
        if (disposed) return;
        // The server answers about the file it was told about; anything else
        // belongs to a document this connection never opened.
        if (uri !== documentUri) return;

        monaco.editor.setModelMarkers(
          model,
          MARKER_OWNER,
          diagnostics.map((diagnostic) => ({
            ...toMonacoRange(diagnostic.range),
            message: diagnostic.message,
            severity: toMarkerSeverity(diagnostic.severity),
            source: diagnostic.source ?? language,
          })),
        );
      },
      onClose: () => {
        if (disposed) return;
        // A server that has gone leaves no opinion behind. Stale markers would
        // outlive the analysis that produced them and quietly become wrong as
        // the file is edited.
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      },
    });

    client.connect();

    void client
      .initialize(`file://${CONTAINER_ROOT}`)
      .then(() => {
        if (disposed) return;
        client.notify("textDocument/didOpen", {
          textDocument: {
            uri: documentUri,
            languageId: language,
            version,
            text: model.getValue(),
          },
        });
      })
      .catch(() => {
        // Refused, or the socket never opened. The editor keeps working
        // without intelligence, which is the state it was in a moment ago.
      });

    // Full text on every change. Both servers here treat a change with no
    // range as a whole-document replacement, and the alternative -- computing
    // incremental ranges -- buys throughput this does not need for a file
    // small enough to have open in an editor.
    const changes = model.onDidChangeContent(() => {
      version += 1;
      client.notify("textDocument/didChange", {
        textDocument: { uri: documentUri, version },
        contentChanges: [{ text: model.getValue() }],
      });
    });

    return () => {
      disposed = true;
      changes.dispose();
      client.notify("textDocument/didClose", {
        textDocument: { uri: documentUri },
      });
      client.dispose();
      // Guarded: switching files disposes the model, and setting markers on a
      // disposed one throws.
      if (!model.isDisposed()) {
        monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
      }
    };
  }, [monaco, codeEditor, projectId, relPath, language, hasSession, mountTick]);
}
