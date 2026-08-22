import { useEffect, useRef, useState } from "react";
// Must precede the Editor import's first render: points Monaco at our bundle
// rather than a CDN. See the file for why.
import "../../../config/monacoSetup.ts";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Flex, Tooltip, Typography } from "antd";
import { VscDiff } from "react-icons/vsc";
import { MAX_FILE_BYTES } from "@replit-clone/shared";
import draculaTheme from "../../../theme/dracula.json";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import {
  selectCanEdit,
  useEditorSocketStore,
} from "../../../store/editorSocketStore.ts";
import {
  useOpenTabsStore,
  selectPaneTab,
  type PaneId,
} from "../../../store/openTabsStore.ts";
import { extensionToFileType } from "../../../utils/extensionToFileType.ts";
import { useEditorSettingsStore } from "../../../store/editorSettingsStore.ts";
import {
  flushAllWrites,
  flushWrite,
  queueWrite,
  setWriteEmitter,
} from "../../../lib/pendingWrites.ts";
import {
  bindDoc,
  colorFor,
  isCollaborative,
  peerCount,
  releaseDoc,
  retainDoc,
  saveDoc,
  subscribeCollab,
} from "../../../lib/collab.ts";
import { useAuthStore } from "../../../store/authStore.ts";
import { registerPaneEditor } from "../../../lib/editorContext.ts";
import { disposeUnwantedModels, trackModel } from "../../../lib/editorModels.ts";

const WRITE_DEBOUNCE_MS = 800;

/** Builds the model URI for a path.
 *
 *  `Uri.parse` would PARSE the path, so a `#` started a fragment, a `?`
 *  started a query, and a space was escaped — none of which survive a round
 *  trip back through `uri.path`. Files named that way lost their view state,
 *  never had their models disposed, and could collide with each other.
 *  `Uri.from` takes the path as given.
 */
function modelUri(monaco: Monaco, relPath: string) {
  return monaco.Uri.from({ scheme: "inmemory", path: `/${relPath}` });
}

interface EditorComponentProps {
  /** Which pane this instance is. Both share the tab list and the write queue;
   *  only the file they display differs. */
  pane?: PaneId;
}

export const EditorComponent = ({ pane = "primary" }: EditorComponentProps) => {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  /** Per-file scroll position and folded regions, keyed by relPath. */
  const viewStates = useRef(new Map<string, editor.ICodeEditorViewState | null>());
  /** Path currently attached to the editor.
   *
   *  Tracked here rather than recovered from `model.uri`: a URI does not always
   *  round-trip back to the path it was built from, so paths with a space, a
   *  `#` or a `?` lost their view state and leaked their models. */
  const openedPath = useRef<string | null>(null);
  /** Set while the editor's contents are being replaced programmatically, so
   *  the resulting change event is not mistaken for the user typing. */
  const suppressChange = useRef(false);
  /** Bumped each time Monaco hands us an editor.
   *
   *  State, not a ref, because the effects below need to RUN again once the
   *  editor exists. Monaco loads asynchronously, so on the very first file the
   *  attach effect fired while `editorRef` was still null and gave up — and
   *  nothing re-ran it when the editor finally arrived, so the first file
   *  opened in a session showed an empty buffer until a second file was
   *  clicked. A ref would have been read at the same wrong moment.
   *
   *  A counter rather than a flag: closing every tab unmounts the editor, and
   *  the next file mounts a fresh one. A flag would already be true and change
   *  nothing, leaving that editor just as empty as the first one was.
   */
  const [mountTick, setMountTick] = useState(0);

  const activeTab = useOpenTabsStore(selectPaneTab(pane));
  const focusedPane = useOpenTabsStore((state) => state.focusedPane);
  const focusPane = useOpenTabsStore((state) => state.focusPane);
  const splitOpen = useOpenTabsStore((state) => state.splitOpen);
  const markDirty = useOpenTabsStore((state) => state.markDirty);
  const { editorSocket } = useEditorSocketStore();
  const canEdit = useEditorSocketStore(selectCanEdit);
  const user = useAuthStore((state) => state.user);

  /** Bumped whenever a document syncs or someone joins, so the peer badge and
   *  the "server owns saving" decision re-render. */
  const [collabTick, setCollabTick] = useState(0);
  useEffect(() => subscribeCollab(() => setCollabTick((value) => value + 1)), []);
  const settings = useEditorSettingsStore();

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [selectionCount, setSelectionCount] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);
  /** Showing the unsaved changes rather than the editor. */
  const [showDiff, setShowDiff] = useState(false);
  /** The buffer as it stands, captured when the diff opens. Monaco owns the
   *  live text, so there is nothing in React state to compare against. */
  const [diffCurrent, setDiffCurrent] = useState("");

  /** This pane's file, readable from Monaco callbacks that outlive a render. */
  const paneRelPathRef = useRef<string | null>(null);
  paneRelPathRef.current = activeTab?.relPath ?? null;

  // The queue is module-level, so the two panes share one per-path timer.
  // Two queues for the same file would race each other.
  useEffect(() => {
    if (!editorSocket) return;

    setWriteEmitter((relPath, data) => {
      editorSocket.emit("writeFile", { relPath, data });
    });

    return () => setWriteEmitter(null);
  }, [editorSocket]);

  // Last resort. Blur (see handleMount) is what actually catches navigation;
  // by unmount the socket may already be gone.
  useEffect(() => flushAllWrites, []);

  /** One Monaco model per file, so undo history, cursor position, and scroll
   *  survive switching tabs. A single controlled `value` reset all three on
   *  every file change. */
  useEffect(() => {
    // Before anything else: the file being switched away from may still have a
    // debounced write queued, and nothing else would ever send it.
    flushAllWrites();

    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor || !activeTab) return;

    const previousPath = openedPath.current;
    if (previousPath !== null && codeEditor.getModel()) {
      viewStates.current.set(previousPath, codeEditor.saveViewState());
    }

    const uri = modelUri(monaco, activeTab.relPath);
    const language = extensionToFileType(activeTab.extension, activeTab.name);

    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(activeTab.value, language, uri);
    } else if (!activeTab.isDirty && model.getValue() !== activeTab.value) {
      // Only when the server's copy genuinely differs AND we have no unsaved
      // local edits, so a reopen does not clobber in-flight typing.
      //
      // Suppressed because setValue raises a content-change event exactly like
      // a keystroke: without this, merely reopening a file marked it dirty and
      // queued a write of the contents it had just been given.
      suppressChange.current = true;
      model.setValue(activeTab.value);
      suppressChange.current = false;
    }

    // Claimed as ours on every open, not only on creation: the second pane to
    // show a file finds the model rather than creating it, and it still has to
    // be a model somebody is willing to dispose.
    trackModel(model);

    // The diff described the file being left, so it does not survive a switch.
    setShowDiff(false);
    openedPath.current = activeTab.relPath;

    codeEditor.setModel(model);

    // A search result asked to land on a specific line; that wins over the
    // remembered scroll position for this file.
    const reveal = useOpenTabsStore.getState().pendingReveal;
    if (reveal && reveal.relPath === activeTab.relPath) {
      useOpenTabsStore.getState().consumeReveal();
      codeEditor.revealLineInCenter(reveal.line);
      codeEditor.setPosition({ lineNumber: reveal.line, column: reveal.column });
    } else {
      const saved = viewStates.current.get(activeTab.relPath);
      if (saved) codeEditor.restoreViewState(saved);
    }

    codeEditor.focus();
  }, [activeTab, mountTick]);

  /** Shared editing for whichever file this pane is showing.
   *
   *  Retained per pane: two panes on one file share the document, and it is
   *  released only when the last of them moves away.
   */
  useEffect(() => {
    const relPath = activeTab?.relPath;
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;

    // A viewer's edits would be rejected anyway, and a CRDT binding that can
    // write would let them type into a buffer nobody will save.
    if (!relPath || !editorSocket || !monaco || !codeEditor || !canEdit) return;

    retainDoc(editorSocket, relPath, {
      name: user?.email ?? "Someone",
      color: colorFor(user?.id ?? "anonymous"),
    });

    const model = monaco.editor.getModel(modelUri(monaco, relPath));
    if (model) bindDoc(relPath, model, codeEditor);

    return () => {
      releaseDoc(editorSocket, relPath);
    };
    // `mounted` for the same reason as the attach effect above: on the first
    // file, Monaco has not produced an editor yet and this would bind nothing.
  }, [activeTab?.relPath, editorSocket, canEdit, user?.email, user?.id, mountTick]);

  /** Dispose models for files that are no longer open, so a long session does
   *  not accumulate them.
   *
   *  Only models this editor created are candidates. Sweeping
   *  `monaco.editor.getModels()` — the page-wide registry — also disposed the
   *  diff editor's two generated models, and the wrapper then destructured a
   *  null `getModel()` on the next language change and took the pane down. */
  const openPaths = useOpenTabsStore((state) => state.tabs.map((t) => t.relPath).join("\u0000"));
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    const open = new Set(openPaths.split("\u0000").filter(Boolean));
    disposeUnwantedModels(
      [...open].map((path) => modelUri(monaco, path).toString()),
    );

    for (const path of viewStates.current.keys()) {
      if (!open.has(path)) viewStates.current.delete(path);
    }
  }, [openPaths, mountTick]);

  /** Lets the assistant read what this pane is showing, at the moment it asks.
   *
   *  Pull rather than push: mirroring the buffer and selection into a store on
   *  every keystroke would re-render half the app to serve one panel that is
   *  usually closed. */
  useEffect(
    () =>
      registerPaneEditor(pane, () => {
        const codeEditor = editorRef.current;
        const model = codeEditor?.getModel();
        if (!codeEditor || !model) return undefined;

        const selection = codeEditor.getSelection();

        return {
          // Models are keyed by an inmemory URI whose path is the relPath with
          // a leading slash — see modelUri.
          relPath: model.uri.path.replace(/^\//, ""),
          contents: model.getValue(),
          selection:
            selection && !selection.isEmpty()
              ? model.getValueInRange(selection)
              : undefined,
        };
      }),
    [pane],
  );

  function handleMount(codeEditor: editor.IStandaloneCodeEditor, monaco: Monaco) {
    editorRef.current = codeEditor;
    monacoRef.current = monaco;

    // Imported rather than fetched from '/Dracula.json', which 404'd and left
    // the editor permanently unmounted.
    monaco.editor.defineTheme("dracula", draculaTheme as editor.IStandaloneThemeData);
    monaco.editor.setTheme("dracula");

    // Feeds the status bar. Monaco owns the cursor, so this is the only way to
    // observe it; the listener is disposed with the editor.
    codeEditor.onDidChangeCursorPosition((event) => {
      setCursor({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });

    // Autosave on focus loss, the way editors with autosave behave. Clicking
    // the file tree, the terminal, or Back all leave the editor, and none of
    // them would otherwise wait out the debounce — while unmount cleanup is too
    // late to rely on, since the socket may already have been disconnected.
    codeEditor.onDidBlurEditorText(() => {
      flushAllWrites();
    });

    // Focus follows the cursor, so opening a file from the tree puts it in the
    // pane the user was last working in.
    codeEditor.onDidFocusEditorText(() => {
      focusPane(pane);
    });

    codeEditor.onDidChangeCursorSelection((event) => {
      const model = codeEditor.getModel();
      setSelectionCount(
        model ? model.getValueLengthInRange(event.selection) : 0,
      );
    });

    // Ctrl/Cmd+S flushes immediately instead of waiting out the debounce.
    // Reads the active path at invocation time: Monaco keeps this callback for
    // the editor's whole lifetime, so anything captured now would go stale.
    codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveNow(codeEditor);
    });

    // Last, so the effects this releases see fully configured refs.
    setMountTick((tick) => tick + 1);
  }

  /** Formats if asked to, then writes immediately.
   *
   *  Monaco ships the formatters already; nothing used to invoke them. The
   *  format runs first and its result is what gets saved, so the file on disk
   *  matches what the editor shows.
   */
  async function saveNow(codeEditor: editor.IStandaloneCodeEditor) {
    const relPath = paneRelPathRef.current;
    if (!relPath) return;

    if (useEditorSettingsStore.getState().formatOnSave) {
      // Suppressed so the formatter's edits are not mistaken for typing, which
      // would queue a second write of the same content.
      suppressChange.current = true;
      try {
        await codeEditor.getAction("editor.action.formatDocument")?.run();
      } catch {
        // No formatter for this language, or it declined. Save regardless —
        // refusing to save because formatting failed would be worse.
      } finally {
        suppressChange.current = false;
      }
    }

    // A shared file is written by the SERVER, from the merged document, so
    // asking it to write now is the only thing that actually saves one.
    //
    // This used to fall straight through to the client path below, where
    // `queueIfAllowed` declines to queue a shared file — and then `flushWrite`
    // sent whatever was still in the queue. Which was, at best, nothing, and
    // at worst an older buffer queued before the document synced: Ctrl+S then
    // put the PREVIOUS contents back on disk over the edit being saved.
    if (saveDoc(editorSocket, relPath)) return;

    // Saves even when nothing is queued, so Ctrl+S is never a no-op the user
    // has to guess about.
    queueIfAllowed(relPath, codeEditor.getValue(), 0);
    flushWrite(relPath);
  }

  /** Queues a write unless the buffer is over the editor's limit.
   *
   *  The server refuses those too; catching it here means the user is told
   *  while they can still act on it, rather than after a silent round trip.
   */
  function queueIfAllowed(relPath: string, data: string, delay: number) {
    // While a file is edited collaboratively the SERVER writes it, from the
    // merged document. A client write here would clobber whatever the others
    // have typed since this buffer was last in step.
    if (isCollaborative(relPath)) return;

    if (new Blob([data]).size > MAX_FILE_BYTES) {
      setWriteError(
        `This file is over the ${String(MAX_FILE_BYTES / 1024 / 1024)} MB editor limit and was not saved.`,
      );
      return;
    }

    setWriteError(null);
    queueWrite(relPath, data, delay);
  }

  function handleChange(value: string | undefined) {
    if (suppressChange.current) return;
    if (value === undefined || !activeTab) return;

    const { relPath } = activeTab;
    markDirty(relPath, true);
    queueIfAllowed(relPath, value, WRITE_DEBOUNCE_MS);
  }

  if (!activeTab) {
    return (
      <Flex
        vertical
        align="center"
        justify="center"
        gap={10}
        style={{ height: "100%", backgroundColor: "var(--rc-editor-bg)" }}
      >
        <span className="rc-logo" style={{ opacity: 0.55 }}>
          &lt;/&gt;
        </span>
        <Typography.Text style={{ color: "var(--rc-text-muted)", fontSize: 14 }}>
          Select a file to start editing
        </Typography.Text>
        <Typography.Text style={{ color: "var(--rc-text-subtle)", fontSize: 12 }}>
          Changes save automatically — or press{" "}
          <kbd
            style={{
              fontFamily: "var(--rc-mono)",
              background: "var(--rc-selection)",
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            Ctrl+S
          </kbd>
        </Typography.Text>
      </Flex>
    );
  }

  const segments = activeTab.relPath.split("/");
  const language = extensionToFileType(activeTab.extension, activeTab.name);

  // `collabTick` is what makes these re-read after a sync; the values live
  // outside React so nothing else would.
  void collabTick;
  const shared = isCollaborative(activeTab.relPath);
  const others = Math.max(0, peerCount(activeTab.relPath) - 1);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-editor-bg)",
        // Only marked when there is a second pane to tell it apart from.
        boxShadow:
          splitOpen && focusedPane === pane
            ? "inset 0 2px 0 0 var(--rc-accent)"
            : undefined,
      }}
    >
      {/* Breadcrumb: the active file's path, so a deeply nested file is
          identifiable without hunting for it in the tree. */}
      <div className="rc-breadcrumb">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <span key={index} style={{ display: "contents" }}>
              {index > 0 && <span className="rc-breadcrumb-sep">›</span>}
              <span data-current={isLast}>
                {isLast && (
                  <FileIcon extension={activeTab.extension} name={activeTab.name} />
                )}
                {segment}
              </span>
            </span>
          );
        })}

        {others > 0 && (
          <Tooltip
            title={`${String(others)} other ${others === 1 ? "person is" : "people are"} editing this file`}
          >
            <span
              style={{
                marginLeft: "auto",
                marginRight: 8,
                fontSize: 11,
                fontFamily: "var(--rc-mono)",
                color: "var(--rc-green)",
              }}
            >
              +{others}
            </span>
          </Tooltip>
        )}

        {/* Compares the buffer against what is on disk. Monaco ships the diff
            editor; nothing surfaced it, so there was no way to see what a save
            would actually change. */}
        <Tooltip
          title={
            activeTab.isDirty
              ? showDiff
                ? "Back to the editor"
                : "Show unsaved changes"
              : "No unsaved changes to compare"
          }
        >
          <button
            className="rc-icon-button"
            style={{ marginLeft: others > 0 ? 0 : "auto", marginRight: 8 }}
            data-on={showDiff}
            disabled={!activeTab.isDirty && !showDiff}
            aria-label="Show unsaved changes"
            aria-pressed={showDiff}
            onClick={() => {
              if (!showDiff) setDiffCurrent(editorRef.current?.getValue() ?? "");
              setShowDiff((value) => !value);
            }}
          >
            <VscDiff size={14} />
          </button>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: showDiff ? "block" : "none" }}>
        <DiffEditor
          height="100%"
          width="100%"
          theme="dracula"
          language={language}
          // Left is the file as saved; right is what is in the buffer now.
          original={activeTab.value}
          modified={diffCurrent}
          options={{
            readOnly: true,
            renderSideBySide: true,
            fontSize: settings.fontSize,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      </div>

      {/* Hidden rather than unmounted while diffing, so the models, undo
          history and scroll position all survive the round trip. */}
      <div style={{ flex: 1, minHeight: 0, display: showDiff ? "none" : "block" }}>
        <Editor
          height="100%"
          width="100%"
          theme="dracula"
          options={{
            // Read-only access is presented as read-only rather than letting
            // every keystroke be rejected one at a time.
            readOnly: !canEdit,
            fontSize: settings.fontSize,
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontLigatures: true,
            lineHeight: 1.6,
            minimap: { enabled: settings.minimap },
            lineNumbers: settings.lineNumbers ? "on" : "off",
            wordWrap: settings.wordWrap ? "on" : "off",
            tabSize: settings.tabSize,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 16, bottom: 16 },
            smoothScrolling: true,
            cursorBlinking: "smooth",
            cursorSmoothCaretAnimation: "on",
            renderLineHighlight: "line",
            roundedSelection: true,
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            guides: { indentation: true, bracketPairs: true },
          }}
          onChange={handleChange}
          onMount={handleMount}
        />
      </div>

      {/* Status bar. Mirrors what an editor is expected to report: where the
          cursor is, what the file is, and whether it still has unsaved edits. */}
      <div className="rc-statusbar">
        <span className="rc-statusbar-group">
          <span title="Line and column">
            Ln {cursor.line}, Col {cursor.column}
          </span>
          {selectionCount > 0 && <span>({selectionCount} selected)</span>}
        </span>

        <span className="rc-statusbar-group">
          <span>Spaces: {settings.tabSize}</span>
          <span>UTF-8</span>
          <span style={{ textTransform: "capitalize" }}>{language}</span>
          <span
            data-dirty={activeTab.isDirty || writeError !== null}
            className="rc-statusbar-save"
            title={
              writeError ??
              (activeTab.isDirty
                ? "Unsaved changes — autosaves shortly, or press Ctrl+S"
                : "All changes saved")
            }
          >
            {!canEdit
              ? "Read-only"
              : writeError
                ? "Too large"
                : shared
                  ? "Shared"
                  : activeTab.isDirty
                    ? "Unsaved"
                    : "Saved"}
          </span>
        </span>
      </div>
    </div>
  );
};
