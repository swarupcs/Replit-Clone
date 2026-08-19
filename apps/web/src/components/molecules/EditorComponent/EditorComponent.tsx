import { useRef } from "react";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import draculaTheme from "../../../theme/dracula.json";
import { useActiveFileTabStore } from "../../../store/activeFileTabStore.ts";
import { useEditorSocketStore } from "../../../store/editorSocketStore.ts";
import { extensionToFileType } from "../../../utils/extensionToFileType.ts";

const DEFAULT_CONTENT = "// Welcome to the playground";
const WRITE_DEBOUNCE_MS = 2000;

export const EditorComponent = () => {
  // A plain `let` in the component body was reset on every render, so the
  // debounce never actually cancelled a pending write.
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { activeFileTab } = useActiveFileTabStore();
  const { editorSocket } = useEditorSocketStore();

  function handleEditorTheme(_editor: editor.IStandaloneCodeEditor, monaco: Monaco) {
    // The theme is imported rather than fetched from '/Dracula.json', which
    // 404'd and left the editor permanently unmounted.
    monaco.editor.defineTheme(
      "dracula",
      draculaTheme as editor.IStandaloneThemeData,
    );
    monaco.editor.setTheme("dracula");
  }

  function handleChange(value: string | undefined) {
    if (writeTimerRef.current !== null) {
      clearTimeout(writeTimerRef.current);
    }

    if (value === undefined || !editorSocket || !activeFileTab) return;

    writeTimerRef.current = setTimeout(() => {
      editorSocket.emit("writeFile", {
        data: value,
        pathToFileOrFolder: activeFileTab.path,
      });
    }, WRITE_DEBOUNCE_MS);
  }

  return (
    <Editor
      width="100%"
      theme="vs-dark"
      defaultValue={DEFAULT_CONTENT}
      options={{
        fontSize: 18,
        fontFamily: "monospace",
      }}
      language={extensionToFileType(activeFileTab?.extension)}
      value={activeFileTab?.value ?? DEFAULT_CONTENT}
      onChange={handleChange}
      onMount={handleEditorTheme}
    />
  );
};
