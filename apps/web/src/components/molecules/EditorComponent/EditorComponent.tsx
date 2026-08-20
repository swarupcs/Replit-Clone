import { useEffect, useRef, useState } from "react";
// Must precede the Editor import's first render: points Monaco at our bundle
// rather than a CDN. See the file for why.
import "../../../config/monacoSetup.ts";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Flex, Typography } from "antd";
import draculaTheme from "../../../theme/dracula.json";
import { FileIcon } from "../../atoms/FileIcon/FileIcon.tsx";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { useOpenTabsStore, selectActiveTab } from "../../../store/openTabsStore.ts";
import { extensionToFileType } from "../../../utils/extensionToFileType.ts";

const WRITE_DEBOUNCE_MS = 800;

export const EditorComponent = () => {
  // A plain `let` in the component body was reset on every render, so the
  // debounce never actually cancelled a pending write.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  /** Per-file scroll position and folded regions. */
  const viewStates = useRef(new Map<string, editor.ICodeEditorViewState | null>());

  const activeTab = useOpenTabsStore(selectActiveTab);
  const markDirty = useOpenTabsStore((state) => state.markDirty);
  const { editorSocket } = useEditorSocketStore();

  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [selectionCount, setSelectionCount] = useState(0);

  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current);
    };
  }, []);

  /** One Monaco model per file, so undo history, cursor position, and scroll
   *  survive switching tabs. A single controlled `value` reset all three on
   *  every file change. */
  useEffect(() => {
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor || !activeTab) return;

    const previousModel = codeEditor.getModel();
    if (previousModel) {
      viewStates.current.set(previousModel.uri.path.slice(1), codeEditor.saveViewState());
    }

    const uri = monaco.Uri.parse(`inmemory:///${activeTab.relPath}`);
    const language = extensionToFileType(activeTab.extension);

    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(activeTab.value, language, uri);
    } else if (!activeTab.isDirty && model.getValue() !== activeTab.value) {
      // Only when the server's copy genuinely differs AND we have no unsaved
      // local edits, so a reopen does not clobber in-flight typing.
      model.setValue(activeTab.value);
    }

    codeEditor.setModel(model);

    const saved = viewStates.current.get(activeTab.relPath);
    if (saved) codeEditor.restoreViewState(saved);
    codeEditor.focus();
  }, [activeTab]);

  /** Dispose models for files that are no longer open, so a long session does
   *  not accumulate them. */
  const openPaths = useOpenTabsStore((state) => state.tabs.map((t) => t.relPath).join("\u0000"));
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;

    const open = new Set(openPaths.split("\u0000").filter(Boolean));
    for (const model of monaco.editor.getModels()) {
      const path = model.uri.path.slice(1);
      if (!open.has(path)) {
        viewStates.current.delete(path);
        model.dispose();
      }
    }
  }, [openPaths]);

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

    codeEditor.onDidChangeCursorSelection((event) => {
      const model = codeEditor.getModel();
      setSelectionCount(
        model ? model.getValueLengthInRange(event.selection) : 0,
      );
    });

    // Ctrl/Cmd+S flushes immediately instead of waiting out the debounce.
    codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      flushWrite(codeEditor.getValue());
    });
  }

  function flushWrite(value: string) {
    const tab = useOpenTabsStore.getState().tabs.find(
      (t) => t.relPath === useOpenTabsStore.getState().activeRelPath,
    );
    if (!tab || !editorSocket) return;

    if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current);
    editorSocket.emit("writeFile", { relPath: tab.relPath, data: value });
  }

  function handleChange(value: string | undefined) {
    if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current);
    if (value === undefined || !editorSocket || !activeTab) return;

    const { relPath } = activeTab;
    markDirty(relPath, true);

    writeTimerRef.current = setTimeout(() => {
      editorSocket.emit("writeFile", { relPath, data: value });
    }, WRITE_DEBOUNCE_MS);
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
  const language = extensionToFileType(activeTab.extension);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        backgroundColor: "var(--rc-editor-bg)",
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
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor
          height="100%"
          width="100%"
          theme="dracula"
          options={{
        fontSize: 14,
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        fontLigatures: true,
        lineHeight: 1.6,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
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
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span style={{ textTransform: "capitalize" }}>{language}</span>
          <span
            data-dirty={activeTab.isDirty}
            className="rc-statusbar-save"
            title={
              activeTab.isDirty
                ? "Unsaved changes — autosaves shortly, or press Ctrl+S"
                : "All changes saved"
            }
          >
            {activeTab.isDirty ? "Unsaved" : "Saved"}
          </span>
        </span>
      </div>
    </div>
  );
};
