import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Flex, Typography } from "antd";
import draculaTheme from "../../../theme/dracula.json";
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
        align="center"
        justify="center"
        style={{ height: "100%", backgroundColor: "var(--rc-surface)" }}
      >
        <Typography.Text style={{ color: "var(--rc-text-subtle)" }}>
          Select a file to start editing
        </Typography.Text>
      </Flex>
    );
  }

  return (
    <Editor
      height="100%"
      width="100%"
      theme="dracula"
      options={{
        fontSize: 14,
        fontFamily: "Fira Code, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
      }}
      onChange={handleChange}
      onMount={handleMount}
    />
  );
};
