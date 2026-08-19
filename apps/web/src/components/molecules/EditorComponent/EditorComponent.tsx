import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { Flex, Typography } from "antd";
import draculaTheme from "../../../theme/dracula.json";
import { useActiveFileTabStore } from "../../../store/activeFileTabStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { extensionToFileType } from "../../../utils/extensionToFileType.ts";

const WRITE_DEBOUNCE_MS = 800;

export const EditorComponent = () => {
  // A plain `let` in the component body was reset on every render, so the
  // debounce never actually cancelled a pending write.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);

  const { activeFileTab } = useActiveFileTabStore();
  const { editorSocket } = useEditorSocketStore();

  // Flush any pending write on unmount so switching away does not drop edits.
  useEffect(() => {
    return () => {
      if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current);
    };
  }, []);

  /** One Monaco model per file, so undo history, cursor position, and view
   *  state survive switching tabs. A single controlled `value` reset all three
   *  on every file change. */
  useEffect(() => {
    const monaco = monacoRef.current;
    const codeEditor = editorRef.current;
    if (!monaco || !codeEditor || !activeFileTab) return;

    const uri = monaco.Uri.parse(`inmemory:///${activeFileTab.relPath}`);
    const language = extensionToFileType(activeFileTab.extension);

    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(activeFileTab.value, language, uri);
    } else if (model.getValue() !== activeFileTab.value) {
      // Only when the server's copy genuinely differs, so we do not clobber
      // in-flight local edits on every echo.
      model.setValue(activeFileTab.value);
    }

    codeEditor.setModel(model);
  }, [activeFileTab]);

  function handleMount(codeEditor: editor.IStandaloneCodeEditor, monaco: Monaco) {
    editorRef.current = codeEditor;
    monacoRef.current = monaco;

    // Imported rather than fetched from '/Dracula.json', which 404'd and left
    // the editor permanently unmounted.
    monaco.editor.defineTheme(
      "dracula",
      draculaTheme as editor.IStandaloneThemeData,
    );
    monaco.editor.setTheme("dracula");
  }

  function handleChange(value: string | undefined) {
    if (writeTimerRef.current !== null) clearTimeout(writeTimerRef.current);
    if (value === undefined || !editorSocket || !activeFileTab) return;

    const { relPath } = activeFileTab;

    writeTimerRef.current = setTimeout(() => {
      editorSocket.emit("writeFile", { relPath, data: value });
    }, WRITE_DEBOUNCE_MS);
  }

  if (!activeFileTab) {
    return (
      <Flex
        align="center"
        justify="center"
        style={{ height: "100%", backgroundColor: "#282a36" }}
      >
        <Typography.Text style={{ color: "#6272a4" }}>
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
